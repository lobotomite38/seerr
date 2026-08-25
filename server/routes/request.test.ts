import assert from 'node:assert/strict';
import { before, beforeEach, describe, it, mock } from 'node:test';

import RadarrAPI, { type RadarrMovie } from '@server/api/servarr/radarr';
import SonarrAPI, { type SonarrSeries } from '@server/api/servarr/sonarr';
import TheMovieDb from '@server/api/themoviedb';
import type {
  TmdbMovieDetails,
  TmdbTvDetails,
} from '@server/api/themoviedb/interfaces';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import OverrideRule from '@server/entity/OverrideRule';
import Season from '@server/entity/Season';
import SeasonRequest from '@server/entity/SeasonRequest';
import { User } from '@server/entity/User';
import PushoverAgent from '@server/lib/notifications/agents/pushover';
import { Permission } from '@server/lib/permissions';
import type { RadarrSettings, SonarrSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import { checkUser } from '@server/middleware/auth';
import { setupTestDb } from '@server/test/db';
import type { Express } from 'express';
import express from 'express';
import session from 'express-session';
import request from 'supertest';
import authRoutes from './auth';
import requestRoutes from './request';

const sendNotificationMock = mock.method(
  MediaRequest,
  'sendNotification',
  async () => undefined
).mock;

const getMovieImpl: (args: {
  movieId: number;
  language?: string;
}) => Promise<TmdbMovieDetails> = async ({ movieId }) => fakeTmdbMovie(movieId);

Object.defineProperty(TheMovieDb.prototype, 'getMovie', {
  get() {
    return async (args: { movieId: number; language?: string }) =>
      getMovieImpl(args);
  },
  set() {},
  configurable: true,
});

const getTvShowImpl: (args: {
  tvId: number;
  language?: string;
}) => Promise<TmdbTvDetails> = async ({ tvId }) => fakeTmdbShow(tvId);

Object.defineProperty(TheMovieDb.prototype, 'getTvShow', {
  get() {
    return async (args: { tvId: number; language?: string }) =>
      getTvShowImpl(args);
  },
  set() {},
  configurable: true,
});

function fakeTmdbMovie(tmdbId: number): TmdbMovieDetails {
  return {
    id: tmdbId,
    genres: [],
    original_language: 'en',
    keywords: { keywords: [] },
    external_ids: {},
  } as unknown as TmdbMovieDetails;
}

function fakeTmdbShow(tmdbId: number): TmdbTvDetails {
  return {
    id: tmdbId,
    genres: [],
    original_language: 'en',
    keywords: { results: [] },
    external_ids: { tvdb_id: tmdbId + 1000 },
    seasons: [
      {
        id: 1,
        season_number: 1,
        air_date: '2020-01-01',
        episode_count: 10,
        name: 'Season 1',
        overview: '',
      },
      {
        id: 2,
        season_number: 2,
        air_date: '2021-01-01',
        episode_count: 10,
        name: 'Season 2',
        overview: '',
      },
    ],
  } as unknown as TmdbTvDetails;
}

function configureRadarr(overrides: Partial<RadarrSettings>[]): void {
  const settings = getSettings();
  settings.radarr = overrides.map((o, i) => ({
    id: i,
    name: `Radarr ${i}`,
    hostname: 'localhost',
    port: 7878,
    apiKey: 'test-key',
    baseUrl: '',
    useSsl: false,
    activeProfileId: 1,
    activeDirectory: '/movies',
    is4k: false,
    minimumAvailability: 'released',
    tags: [],
    isDefault: i === 0,
    syncEnabled: true,
    preventSearch: false,
    externalUrl: '',
    ...o,
  })) as RadarrSettings[];
}

function configureSonarr(overrides: Partial<SonarrSettings>[]): void {
  const settings = getSettings();
  settings.sonarr = overrides.map((o, i) => ({
    id: i,
    name: `Sonarr ${i}`,
    hostname: 'localhost',
    port: 8989,
    apiKey: 'test-key',
    baseUrl: '',
    useSsl: false,
    activeProfileId: 1,
    activeDirectory: '/tv',
    activeLanguageProfileId: 1,
    animeTags: [],
    is4k: false,
    enableSeasonFolders: true,
    tags: [],
    isDefault: i === 0,
    syncEnabled: true,
    preventSearch: false,
    externalUrl: '',
    ...o,
  })) as SonarrSettings[];
}

let app: Express;

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(
    session({
      secret: 'test-secret',
      resave: false,
      saveUninitialized: false,
    })
  );
  app.use(checkUser);
  app.use('/auth', authRoutes);
  app.use('/request', requestRoutes);
  app.use(
    (
      err: { status?: number; message?: string },
      _req: express.Request,
      res: express.Response,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      _next: express.NextFunction
    ) => {
      res
        .status(err.status ?? 500)
        .json({ status: err.status ?? 500, message: err.message });
    }
  );
  return app;
}

before(async () => {
  app = createApp();
});

beforeEach(() => {
  sendNotificationMock.resetCalls();
});

setupTestDb();

async function loginAs(email: string, password: string) {
  const settings = getSettings();
  const priorLocalLogin = settings.main.localLogin;
  settings.main.localLogin = true;

  try {
    const agent = request.agent(app);
    const res = await agent.post('/auth/local').send({ email, password });
    assert.strictEqual(res.status, 200);
    return agent;
  } finally {
    settings.main.localLogin = priorLocalLogin;
  }
}

async function seedQualityOverrideUser() {
  const user = new User();
  user.id = 11;
  user.plexId = 11;
  user.plexToken = '1234';
  user.plexUsername = 'quality-override';
  user.username = 'quality-override';
  user.email = 'quality-override@seerr.dev';
  user.avatar = 'https://example.com/avatar.png';
  user.password =
    '$2b$12$Z5V2P5HZgmx4/AnWFMZN1.aD5AM1NucNi.mhNTSQ9oVtmdzu7Le/a';
  user.permissions = Permission.ADMIN;

  return getRepository(User).save(user);
}

async function seedRequest(status = MediaRequestStatus.PENDING) {
  const userRepo = getRepository(User);
  const mediaRepo = getRepository(Media);
  const requestRepo = getRepository(MediaRequest);

  const requestedBy = await userRepo.findOneOrFail({
    where: { email: 'friend@seerr.dev' },
  });

  const media = await mediaRepo.save(
    new Media({
      mediaType: MediaType.MOVIE,
      tmdbId: 12345,
      status: MediaStatus.UNKNOWN,
      status4k: MediaStatus.UNKNOWN,
    })
  );

  const created = await requestRepo.save(
    new MediaRequest({
      type: MediaType.MOVIE,
      status,
      media,
      requestedBy,
      is4k: false,
      updatedAt: new Date('2025-03-01T00:00:00.000Z'),
    })
  );

  return requestRepo.findOneOrFail({
    where: { id: created.id },
    relations: { requestedBy: true, modifiedBy: true },
  });
}

async function grantFriendRequestPermissions() {
  const userRepo = getRepository(User);
  const friend = await userRepo.findOneOrFail({
    where: { email: 'friend@seerr.dev' },
  });

  friend.permissions =
    Permission.REQUEST |
    Permission.REQUEST_MOVIE |
    Permission.REQUEST_TV |
    Permission.REQUEST_4K |
    Permission.REQUEST_4K_MOVIE |
    Permission.REQUEST_4K_TV;

  await userRepo.save(friend);
}

async function seedMovieMedia({
  tmdbId,
  status = MediaStatus.UNKNOWN,
  status4k = MediaStatus.UNKNOWN,
}: {
  tmdbId: number;
  status?: MediaStatus;
  status4k?: MediaStatus;
}) {
  return getRepository(Media).save(
    new Media({
      mediaType: MediaType.MOVIE,
      tmdbId,
      status,
      status4k,
    })
  );
}

async function seedTvMedia({
  tmdbId,
  seasons,
}: {
  tmdbId: number;
  seasons: Season[];
}) {
  return getRepository(Media).save(
    new Media({
      mediaType: MediaType.TV,
      tmdbId,
      tvdbId: tmdbId + 1000,
      status: MediaStatus.PARTIALLY_AVAILABLE,
      status4k: MediaStatus.UNKNOWN,
      seasons,
    })
  );
}

describe('POST /request opposite quality request block', () => {
  const blockedStatuses = [
    MediaStatus.PENDING,
    MediaStatus.PROCESSING,
    MediaStatus.PARTIALLY_AVAILABLE,
    MediaStatus.AVAILABLE,
  ];

  for (const [index, oppositeStatus] of blockedStatuses.entries()) {
    it(`blocks a non-owner movie 4K request when 1080p status is ${MediaStatus[oppositeStatus]}`, async () => {
      await grantFriendRequestPermissions();
      const tmdbId = 70010 + index;
      await seedMovieMedia({
        tmdbId,
        status: oppositeStatus,
        status4k: MediaStatus.UNKNOWN,
      });

      const agent = await loginAs('friend@seerr.dev', 'test1234');
      const res = await agent.post('/request').send({
        mediaType: MediaType.MOVIE,
        mediaId: tmdbId,
        is4k: true,
      });

      assert.strictEqual(res.status, 409);
      assert.strictEqual(
        res.body.message,
        'This has already been requested or is available in 1080p.'
      );
    });

    it(`blocks a non-owner movie 1080p request when 4K status is ${MediaStatus[oppositeStatus]}`, async () => {
      await grantFriendRequestPermissions();
      const tmdbId = 70020 + index;
      await seedMovieMedia({
        tmdbId,
        status: MediaStatus.UNKNOWN,
        status4k: oppositeStatus,
      });

      const agent = await loginAs('friend@seerr.dev', 'test1234');
      const res = await agent.post('/request').send({
        mediaType: MediaType.MOVIE,
        mediaId: tmdbId,
        is4k: false,
      });

      assert.strictEqual(res.status, 409);
      assert.strictEqual(
        res.body.message,
        'This has already been requested or is available in 4K.'
      );
    });
  }

  for (const [index, oppositeStatus] of [
    MediaStatus.UNKNOWN,
    MediaStatus.DELETED,
  ].entries()) {
    it(`allows both request directions when the opposite status is ${MediaStatus[oppositeStatus]}`, async () => {
      await grantFriendRequestPermissions();
      const agent = await loginAs('friend@seerr.dev', 'test1234');
      const request4kId = 70030 + index * 2;
      const request1080pId = request4kId + 1;
      await seedMovieMedia({ tmdbId: request4kId, status: oppositeStatus });
      await seedMovieMedia({
        tmdbId: request1080pId,
        status4k: oppositeStatus,
      });

      const request4k = await agent.post('/request').send({
        mediaType: MediaType.MOVIE,
        mediaId: request4kId,
        is4k: true,
      });
      const request1080p = await agent.post('/request').send({
        mediaType: MediaType.MOVIE,
        mediaId: request1080pId,
        is4k: false,
      });

      assert.strictEqual(request4k.status, 201);
      assert.strictEqual(request1080p.status, 201);
    });
  }

  it('allows owner user id 1 to create an opposite-quality movie request', async () => {
    const media = await seedMovieMedia({
      tmdbId: 70003,
      status: MediaStatus.AVAILABLE,
      status4k: MediaStatus.UNKNOWN,
    });

    const agent = await loginAs('admin@seerr.dev', 'test1234');
    const res = await agent.post('/request').send({
      mediaType: MediaType.MOVIE,
      mediaId: 70003,
      is4k: true,
    });

    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.is4k, true);

    const updated = await getRepository(Media).findOneOrFail({
      where: { id: media.id },
    });
    assert.strictEqual(updated.status, MediaStatus.AVAILABLE);
    assert.strictEqual(updated.status4k, MediaStatus.PROCESSING);
  });

  it('allows configured user id 11 to create opposite-quality movie and TV requests', async () => {
    await seedQualityOverrideUser();
    const movie = await seedMovieMedia({
      tmdbId: 70005,
      status: MediaStatus.AVAILABLE,
      status4k: MediaStatus.UNKNOWN,
    });
    await seedTvMedia({
      tmdbId: 70007,
      seasons: [
        new Season({
          seasonNumber: 1,
          status: MediaStatus.AVAILABLE,
          status4k: MediaStatus.UNKNOWN,
        }),
      ],
    });

    const agent = await loginAs('quality-override@seerr.dev', 'test1234');
    const movieResponse = await agent.post('/request').send({
      mediaType: MediaType.MOVIE,
      mediaId: 70005,
      is4k: true,
    });
    const tvResponse = await agent.post('/request').send({
      mediaType: MediaType.TV,
      mediaId: 70007,
      is4k: true,
      seasons: [1],
    });

    assert.strictEqual(movieResponse.status, 201);
    assert.strictEqual(movieResponse.body.is4k, true);
    assert.strictEqual(tvResponse.status, 201);
    assert.deepStrictEqual(
      tvResponse.body.seasons.map(
        (season: SeasonRequest) => season.seasonNumber
      ),
      [1]
    );

    const updatedMovie = await getRepository(Media).findOneOrFail({
      where: { id: movie.id },
    });
    assert.strictEqual(updatedMovie.status, MediaStatus.AVAILABLE);
    assert.strictEqual(updatedMovie.status4k, MediaStatus.PROCESSING);
  });

  it('does not let another admin bypass by submitting on behalf of owner user id 1', async () => {
    const userRepo = getRepository(User);
    const otherAdmin = new User();
    otherAdmin.plexId = 2;
    otherAdmin.plexToken = '1234';
    otherAdmin.plexUsername = 'other-admin';
    otherAdmin.username = 'other-admin';
    otherAdmin.email = 'other-admin@seerr.dev';
    otherAdmin.avatar = 'https://example.com/avatar.png';
    otherAdmin.password =
      '$2b$12$Z5V2P5HZgmx4/AnWFMZN1.aD5AM1NucNi.mhNTSQ9oVtmdzu7Le/a';
    otherAdmin.permissions = Permission.ADMIN;
    await userRepo.save(otherAdmin);

    await seedMovieMedia({
      tmdbId: 70004,
      status: MediaStatus.AVAILABLE,
      status4k: MediaStatus.UNKNOWN,
    });

    const agent = await loginAs('other-admin@seerr.dev', 'test1234');
    const res = await agent.post('/request').send({
      mediaType: MediaType.MOVIE,
      mediaId: 70004,
      is4k: true,
      userId: 1,
    });

    assert.strictEqual(res.status, 409);
    assert.strictEqual(
      res.body.message,
      'This has already been requested or is available in 1080p.'
    );
  });

  it('blocks TV requests only when a selected season is available in the opposite quality', async () => {
    await grantFriendRequestPermissions();
    await seedTvMedia({
      tmdbId: 70006,
      seasons: [
        new Season({
          seasonNumber: 1,
          status: MediaStatus.AVAILABLE,
          status4k: MediaStatus.UNKNOWN,
        }),
        new Season({
          seasonNumber: 2,
          status: MediaStatus.UNKNOWN,
          status4k: MediaStatus.UNKNOWN,
        }),
      ],
    });

    const agent = await loginAs('friend@seerr.dev', 'test1234');
    const allowed = await agent.post('/request').send({
      mediaType: MediaType.TV,
      mediaId: 70006,
      is4k: true,
      seasons: [2],
    });

    assert.strictEqual(allowed.status, 201);
    assert.deepStrictEqual(
      allowed.body.seasons.map((season: SeasonRequest) => season.seasonNumber),
      [2]
    );

    const blocked = await agent.post('/request').send({
      mediaType: MediaType.TV,
      mediaId: 70006,
      is4k: true,
      seasons: [1],
    });

    assert.strictEqual(blocked.status, 409);
    assert.strictEqual(
      blocked.body.message,
      'This has already been requested or is available in 1080p.'
    );
  });
});

describe('DELETE /request/:requestId', () => {
  it('allows the owner to delete their own pending request', async () => {
    const mediaRequest = await seedRequest();

    const agent = await loginAs('friend@seerr.dev', 'test1234');
    const res = await agent.delete(`/request/${mediaRequest.id}`);

    assert.strictEqual(res.status, 204);
  });

  it('allows an admin to delete any pending request', async () => {
    const mediaRequest = await seedRequest();

    const agent = await loginAs('admin@seerr.dev', 'test1234');
    const res = await agent.delete(`/request/${mediaRequest.id}`);

    assert.strictEqual(res.status, 204);
  });

  it('prevents a non-owner non-admin from deleting a pending request', async () => {
    const userRepo = getRepository(User);
    const mediaRepo = getRepository(Media);
    const requestRepo = getRepository(MediaRequest);

    // Create a request owned by admin, then try to delete as friend
    const owner = await userRepo.findOneOrFail({
      where: { email: 'admin@seerr.dev' },
    });

    const media = await mediaRepo.save(
      new Media({
        mediaType: MediaType.MOVIE,
        tmdbId: 54321,
        status: MediaStatus.UNKNOWN,
        status4k: MediaStatus.UNKNOWN,
      })
    );

    const mediaRequest = await requestRepo.save(
      new MediaRequest({
        type: MediaType.MOVIE,
        status: MediaRequestStatus.PENDING,
        media,
        requestedBy: owner,
        is4k: false,
      })
    );

    const agent = await loginAs('friend@seerr.dev', 'test1234');
    const res = await agent.delete(`/request/${mediaRequest.id}`);

    assert.strictEqual(res.status, 401);
  });

  it('prevents the owner from deleting an approved request', async () => {
    const mediaRequest = await seedRequest(MediaRequestStatus.APPROVED);

    const agent = await loginAs('friend@seerr.dev', 'test1234');
    const res = await agent.delete(`/request/${mediaRequest.id}`);

    assert.strictEqual(res.status, 401);
  });

  it('returns 404 for a non-existent request', async () => {
    const agent = await loginAs('admin@seerr.dev', 'test1234');
    const res = await agent.delete('/request/99999999');

    assert.strictEqual(res.status, 404);
  });
});

describe('PUT /request/:requestId (movie)', () => {
  it('persists server and root folder changes to the database', async () => {
    const requestRepo = getRepository(MediaRequest);
    const mediaRequest = await seedRequest();

    const agent = await loginAs('admin@seerr.dev', 'test1234');
    const res = await agent.put(`/request/${mediaRequest.id}`).send({
      mediaType: MediaType.MOVIE,
      serverId: 3,
      profileId: 7,
      rootFolder: '/updated/movies',
      tags: [1, 2],
    });

    assert.strictEqual(res.status, 200);

    const saved = await requestRepo.findOneOrFail({
      where: { id: mediaRequest.id },
    });
    assert.strictEqual(saved.serverId, 3);
    assert.strictEqual(saved.profileId, 7);
    assert.strictEqual(saved.rootFolder, '/updated/movies');
  });
});

describe('POST /request/:requestId/:status', () => {
  const cases = [
    { action: 'approve', expected: MediaRequestStatus.APPROVED },
    { action: 'decline', expected: MediaRequestStatus.DECLINED },
  ] as const;

  for (const { action, expected } of cases) {
    it(`transitions to ${action}d and records the acting user`, async () => {
      const repo = getRepository(MediaRequest);
      const pending = await seedRequest();
      const admin = await loginAs('admin@seerr.dev', 'test1234');

      const res = await admin.post(`/request/${pending.id}/${action}`);

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.status, expected);
      assert.strictEqual(res.body.modifiedBy.email, 'admin@seerr.dev');

      const persisted = await repo.findOneOrFail({
        where: { id: pending.id },
        relations: { modifiedBy: true },
      });

      assert.strictEqual(persisted.status, expected);
      assert.strictEqual(persisted.modifiedBy?.email, 'admin@seerr.dev');
      assert.ok(persisted.updatedAt > pending.updatedAt);
    });
  }
});

describe('POST /request/:requestId/retry', () => {
  it('re-approves a failed request and records the acting user', async () => {
    const repo = getRepository(MediaRequest);
    const failed = await seedRequest(MediaRequestStatus.FAILED);
    const admin = await loginAs('admin@seerr.dev', 'test1234');

    const res = await admin.post(`/request/${failed.id}/retry`);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.status, MediaRequestStatus.APPROVED);
    assert.strictEqual(res.body.modifiedBy.email, 'admin@seerr.dev');

    const persisted = await repo.findOneOrFail({
      where: { id: failed.id },
      relations: { modifiedBy: true },
    });

    assert.strictEqual(persisted.status, MediaRequestStatus.APPROVED);
    assert.strictEqual(persisted.modifiedBy?.email, 'admin@seerr.dev');
    assert.ok(persisted.updatedAt > failed.updatedAt);
  });
});

describe('DELETE /request/:requestId, deleted media status restoration', () => {
  async function seedDeletedMediaScenario() {
    const userRepo = getRepository(User);
    const mediaRepo = getRepository(Media);
    const requestRepo = getRepository(MediaRequest);

    const admin = await userRepo.findOneOrFail({
      where: { email: 'admin@seerr.dev' },
    });

    const media = await mediaRepo.save(
      new Media({
        mediaType: MediaType.MOVIE,
        tmdbId: 99001,
        status: MediaStatus.DELETED,
        status4k: MediaStatus.UNKNOWN,
      })
    );

    const staleRequest = await requestRepo.save(
      new MediaRequest({
        type: MediaType.MOVIE,
        status: MediaRequestStatus.COMPLETED,
        media,
        requestedBy: admin,
        is4k: false,
        isAutoRequest: true,
      })
    );

    media.status = MediaStatus.PENDING;
    await mediaRepo.save(media);

    const newRequest = await requestRepo.save(
      new MediaRequest({
        type: MediaType.MOVIE,
        status: MediaRequestStatus.APPROVED,
        media,
        requestedBy: admin,
        is4k: false,
      })
    );

    return { media, staleRequest, newRequest, admin };
  }

  it('restores media status to DELETED when the re-request is deleted and a stale completed request remains', async () => {
    const mediaRepo = getRepository(Media);
    const { media, newRequest } = await seedDeletedMediaScenario();

    const agent = await loginAs('admin@seerr.dev', 'test1234');
    const res = await agent.delete(`/request/${newRequest.id}`);

    assert.strictEqual(res.status, 204);

    const updated = await mediaRepo.findOneOrFail({ where: { id: media.id } });
    assert.strictEqual(updated.status, MediaStatus.DELETED);
  });

  it('restores media status4k to DELETED when the re-request is deleted and a stale completed request remains', async () => {
    const userRepo = getRepository(User);
    const mediaRepo = getRepository(Media);
    const requestRepo = getRepository(MediaRequest);

    const admin = await userRepo.findOneOrFail({
      where: { email: 'admin@seerr.dev' },
    });

    const media = await mediaRepo.save(
      new Media({
        mediaType: MediaType.MOVIE,
        tmdbId: 99003,
        status: MediaStatus.UNKNOWN,
        status4k: MediaStatus.DELETED,
      })
    );

    await requestRepo.save(
      new MediaRequest({
        type: MediaType.MOVIE,
        status: MediaRequestStatus.COMPLETED,
        media,
        requestedBy: admin,
        is4k: true,
        isAutoRequest: true,
      })
    );

    media.status4k = MediaStatus.PENDING;
    await mediaRepo.save(media);

    const newRequest = await requestRepo.save(
      new MediaRequest({
        type: MediaType.MOVIE,
        status: MediaRequestStatus.APPROVED,
        media,
        requestedBy: admin,
        is4k: true,
      })
    );

    const agent = await loginAs('admin@seerr.dev', 'test1234');
    const res = await agent.delete(`/request/${newRequest.id}`);

    assert.strictEqual(res.status, 204);

    const updated = await mediaRepo.findOneOrFail({ where: { id: media.id } });
    assert.strictEqual(updated.status4k, MediaStatus.DELETED);
  });

  it('resets media status to UNKNOWN when the stale completed request is also deleted', async () => {
    const mediaRepo = getRepository(Media);
    const requestRepo = getRepository(MediaRequest);
    const { media, newRequest, staleRequest } =
      await seedDeletedMediaScenario();

    const agent = await loginAs('admin@seerr.dev', 'test1234');

    await agent.delete(`/request/${newRequest.id}`);

    const res = await agent.delete(`/request/${staleRequest.id}`);
    assert.strictEqual(res.status, 204);

    const updated = await mediaRepo.findOneOrFail({ where: { id: media.id } });
    assert.strictEqual(updated.status, MediaStatus.UNKNOWN);

    const remaining = await requestRepo.find({
      where: { media: { id: media.id } },
    });
    assert.strictEqual(remaining.length, 0);
  });

  it('resets media status4k to UNKNOWN when the stale completed 4K request is also deleted', async () => {
    const userRepo = getRepository(User);
    const mediaRepo = getRepository(Media);
    const requestRepo = getRepository(MediaRequest);

    const admin = await userRepo.findOneOrFail({
      where: { email: 'admin@seerr.dev' },
    });

    const media = await mediaRepo.save(
      new Media({
        mediaType: MediaType.MOVIE,
        tmdbId: 99004,
        status: MediaStatus.UNKNOWN,
        status4k: MediaStatus.DELETED,
      })
    );

    const staleRequest = await requestRepo.save(
      new MediaRequest({
        type: MediaType.MOVIE,
        status: MediaRequestStatus.COMPLETED,
        media,
        requestedBy: admin,
        is4k: true,
        isAutoRequest: true,
      })
    );

    media.status4k = MediaStatus.PENDING;
    await mediaRepo.save(media);

    const newRequest = await requestRepo.save(
      new MediaRequest({
        type: MediaType.MOVIE,
        status: MediaRequestStatus.APPROVED,
        media,
        requestedBy: admin,
        is4k: true,
      })
    );

    const agent = await loginAs('admin@seerr.dev', 'test1234');

    await agent.delete(`/request/${newRequest.id}`);

    const res = await agent.delete(`/request/${staleRequest.id}`);
    assert.strictEqual(res.status, 204);

    const updated = await mediaRepo.findOneOrFail({ where: { id: media.id } });
    assert.strictEqual(updated.status4k, MediaStatus.UNKNOWN);
  });

  it('does not reset media status when other active requests still exist', async () => {
    const userRepo = getRepository(User);
    const mediaRepo = getRepository(Media);
    const requestRepo = getRepository(MediaRequest);

    const admin = await userRepo.findOneOrFail({
      where: { email: 'admin@seerr.dev' },
    });

    const media = await mediaRepo.save(
      new Media({
        mediaType: MediaType.MOVIE,
        tmdbId: 99002,
        status: MediaStatus.PENDING,
        status4k: MediaStatus.UNKNOWN,
      })
    );

    const req1 = await requestRepo.save(
      new MediaRequest({
        type: MediaType.MOVIE,
        status: MediaRequestStatus.PENDING,
        media,
        requestedBy: admin,
        is4k: false,
      })
    );

    await requestRepo.save(
      new MediaRequest({
        type: MediaType.MOVIE,
        status: MediaRequestStatus.PENDING,
        media,
        requestedBy: admin,
        is4k: false,
      })
    );

    const agent = await loginAs('admin@seerr.dev', 'test1234');
    const res = await agent.delete(`/request/${req1.id}`);

    assert.strictEqual(res.status, 204);

    const updated = await mediaRepo.findOneOrFail({ where: { id: media.id } });
    assert.strictEqual(updated.status, MediaStatus.PENDING);
  });

  it('does not reset media status when status is PARTIALLY_AVAILABLE and only completed requests remain', async () => {
    const userRepo = getRepository(User);
    const mediaRepo = getRepository(Media);
    const requestRepo = getRepository(MediaRequest);

    const admin = await userRepo.findOneOrFail({
      where: { email: 'admin@seerr.dev' },
    });

    const media = await mediaRepo.save(
      new Media({
        mediaType: MediaType.MOVIE,
        tmdbId: 99005,
        status: MediaStatus.PARTIALLY_AVAILABLE,
        status4k: MediaStatus.UNKNOWN,
      })
    );

    const completedRequest = await requestRepo.save(
      new MediaRequest({
        type: MediaType.MOVIE,
        status: MediaRequestStatus.COMPLETED,
        media,
        requestedBy: admin,
        is4k: false,
      })
    );

    const agent = await loginAs('admin@seerr.dev', 'test1234');
    const res = await agent.delete(`/request/${completedRequest.id}`);

    assert.strictEqual(res.status, 204);

    const updated = await mediaRepo.findOneOrFail({ where: { id: media.id } });
    assert.strictEqual(updated.status, MediaStatus.PARTIALLY_AVAILABLE);
  });
});

describe('POST /request/:requestId/cancel', () => {
  const baseServer = {
    hostname: '127.0.0.1',
    port: 9999,
    apiKey: 'test',
    useSsl: false,
    activeProfileId: 1,
    activeProfileName: 'Test',
    activeDirectory: '/test',
    tags: [],
    isDefault: true,
    externalUrl: '',
    syncEnabled: true,
    preventSearch: true,
    tagRequests: false,
    overrideRule: [],
  };

  beforeEach(() => {
    const settings = getSettings();
    settings.radarr = [
      {
        ...baseServer,
        id: 1,
        name: 'Radarr 1080p',
        is4k: false,
        minimumAvailability: 'released',
      },
      {
        ...baseServer,
        id: 0,
        name: 'Radarr 4K',
        is4k: true,
        minimumAvailability: 'released',
      },
    ];
    settings.sonarr = [
      {
        ...baseServer,
        id: 1,
        name: 'Sonarr 1080p',
        is4k: false,
        seriesType: 'standard',
        animeSeriesType: 'anime',
        enableSeasonFolders: true,
        monitorNewItems: 'all',
      },
      {
        ...baseServer,
        id: 0,
        name: 'Sonarr 4K',
        is4k: true,
        seriesType: 'standard',
        animeSeriesType: 'anime',
        enableSeasonFolders: true,
        monitorNewItems: 'all',
      },
    ];
  });

  async function seedCancellationRequest({
    type = MediaType.MOVIE,
    is4k = false,
    status = MediaRequestStatus.APPROVED,
    ownerEmail = 'friend@seerr.dev',
    tmdbId = 88001,
  }: {
    type?: MediaType;
    is4k?: boolean;
    status?: MediaRequestStatus;
    ownerEmail?: string;
    tmdbId?: number;
  } = {}) {
    const owner = await getRepository(User).findOneOrFail({
      where: { email: ownerEmail },
    });
    const media = await getRepository(Media).save(
      new Media({
        mediaType: type,
        tmdbId,
        tvdbId: type === MediaType.TV ? tmdbId + 1000 : undefined,
        status: is4k ? MediaStatus.UNKNOWN : MediaStatus.PROCESSING,
        status4k: is4k ? MediaStatus.PROCESSING : MediaStatus.UNKNOWN,
        serviceId: is4k ? null : 1,
        externalServiceId: is4k ? null : 501,
        serviceId4k: is4k ? 0 : null,
        externalServiceId4k: is4k ? 601 : null,
      })
    );
    const mediaRequest = await getRepository(MediaRequest).save(
      new MediaRequest({
        type,
        status,
        media,
        requestedBy: owner,
        is4k,
        serverId: is4k ? 0 : 1,
        profileId: 1,
        seasons:
          type === MediaType.TV
            ? [
                new SeasonRequest({
                  seasonNumber: 1,
                  status,
                }),
              ]
            : [],
      })
    );
    return { media, mediaRequest, owner };
  }

  const movie = (overrides: Partial<RadarrMovie> = {}): RadarrMovie => ({
    id: 501,
    title: 'Test Movie',
    isAvailable: false,
    monitored: true,
    tmdbId: 88001,
    imdbId: '',
    titleSlug: 'test-movie',
    folderName: 'Test Movie',
    path: '/test/Test Movie',
    profileId: 1,
    qualityProfileId: 1,
    added: new Date().toISOString(),
    hasFile: false,
    tags: [],
    ...overrides,
  });

  const series = (overrides: Partial<SonarrSeries> = {}): SonarrSeries => ({
    title: 'Test Series',
    sortTitle: 'test series',
    seasonCount: 1,
    status: 'continuing',
    overview: '',
    network: '',
    airTime: '',
    images: [],
    remotePoster: '',
    seasons: [{ seasonNumber: 1, monitored: true }],
    year: 2020,
    path: '/test/Test Series',
    profileId: 1,
    languageProfileId: 1,
    seasonFolder: true,
    monitored: true,
    monitorNewItems: 'all',
    useSceneNumbering: false,
    runtime: 60,
    tvdbId: 89001,
    tvRageId: 0,
    tvMazeId: 0,
    firstAired: '2020-01-01',
    seriesType: 'standard',
    cleanTitle: 'testseries',
    imdbId: '',
    titleSlug: 'test-series',
    certification: '',
    genres: [],
    tags: [],
    added: new Date().toISOString(),
    ratings: { votes: 0, value: 0 },
    qualityProfileId: 1,
    id: 501,
    statistics: {
      seasonCount: 1,
      episodeFileCount: 0,
      episodeCount: 10,
      totalEpisodeCount: 10,
      sizeOnDisk: 0,
      releaseGroups: [],
      percentOfEpisodes: 0,
    },
    ...overrides,
  });

  it('removes a fileless 1080p movie from Radarr before clearing Seerr', async (t) => {
    const { media, mediaRequest } = await seedCancellationRequest();
    t.mock.method(RadarrAPI.prototype, 'getMovieIfExists', async () => movie());
    t.mock.method(
      RadarrAPI.prototype,
      'getQueueForCancellation',
      async () => []
    );
    const remove = t.mock.method(
      RadarrAPI.prototype,
      'deleteMovieById',
      async () => 'removed' as const
    );
    const pushover = t.mock.method(
      PushoverAgent.prototype,
      'send',
      async () => true
    );

    const agent = await loginAs('friend@seerr.dev', 'test1234');
    const res = await agent.post(`/request/${mediaRequest.id}/cancel`);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.arrRemoval, 'removed');
    assert.strictEqual(remove.mock.calls.length, 1);
    assert.strictEqual(pushover.mock.calls.length, 0);
    assert.deepStrictEqual(remove.mock.calls[0].arguments, [
      501,
      {
        deleteFiles: false,
        addImportExclusion: false,
      },
    ]);
    assert.strictEqual(
      await getRepository(MediaRequest).countBy({ id: mediaRequest.id }),
      0
    );
    const updated = await getRepository(Media).findOneOrFail({
      where: { id: media.id },
    });
    assert.strictEqual(updated.serviceId, null);
    assert.strictEqual(updated.externalServiceId, null);
    assert.strictEqual(updated.status, MediaStatus.UNKNOWN);
  });

  it('routes a 4K movie cancellation to the exact 4K server linkage', async (t) => {
    const { mediaRequest } = await seedCancellationRequest({
      is4k: true,
      tmdbId: 88002,
    });
    t.mock.method(RadarrAPI.prototype, 'getMovieIfExists', async (id: number) =>
      movie({ id, tmdbId: 88002 })
    );
    t.mock.method(
      RadarrAPI.prototype,
      'getQueueForCancellation',
      async () => []
    );
    const remove = t.mock.method(
      RadarrAPI.prototype,
      'deleteMovieById',
      async () => 'removed' as const
    );
    const agent = await loginAs('friend@seerr.dev', 'test1234');

    const res = await agent.post(`/request/${mediaRequest.id}/cancel`);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(remove.mock.calls[0].arguments[0], 601);
  });

  it('refuses non-owners without contacting Radarr', async (t) => {
    const { mediaRequest } = await seedCancellationRequest({
      ownerEmail: 'admin@seerr.dev',
    });
    const lookup = t.mock.method(
      RadarrAPI.prototype,
      'getMovieIfExists',
      async () => movie()
    );
    const agent = await loginAs('friend@seerr.dev', 'test1234');

    const res = await agent.post(`/request/${mediaRequest.id}/cancel`);

    assert.strictEqual(res.status, 403);
    assert.strictEqual(lookup.mock.calls.length, 0);
    assert.strictEqual(
      await getRepository(MediaRequest).countBy({ id: mediaRequest.id }),
      1
    );
  });

  for (const unsafe of ['files', 'queue', 'shared'] as const) {
    it(`leaves Radarr and Seerr unchanged when ${unsafe} make cancellation unsafe`, async (t) => {
      const { media, mediaRequest, owner } = await seedCancellationRequest();
      if (unsafe === 'shared') {
        await getRepository(MediaRequest).save(
          new MediaRequest({
            type: MediaType.MOVIE,
            status: MediaRequestStatus.PENDING,
            media,
            requestedBy: owner,
            is4k: false,
            serverId: 1,
            seasons: [],
          })
        );
      }
      const lookup = t.mock.method(
        RadarrAPI.prototype,
        'getMovieIfExists',
        async () =>
          movie(
            unsafe === 'files'
              ? {
                  hasFile: true,
                  movieFile: {
                    id: 1,
                    movieId: 501,
                    size: 1,
                    dateAdded: new Date().toISOString(),
                    mediaInfo: {
                      id: 1,
                      audioBitrate: 0,
                      audioChannels: 0,
                      audioStreamCount: 0,
                      videoBitDepth: 0,
                      videoBitrate: 0,
                      videoFps: 0,
                    },
                    qualityCutoffNotMet: false,
                  },
                }
              : {}
          )
      );
      t.mock.method(RadarrAPI.prototype, 'getQueueForCancellation', async () =>
        unsafe === 'queue' ? [{ movieId: 501 }] : []
      );
      const remove = t.mock.method(
        RadarrAPI.prototype,
        'deleteMovieById',
        async () => 'removed' as const
      );
      const agent = await loginAs('friend@seerr.dev', 'test1234');

      const res = await agent.post(`/request/${mediaRequest.id}/cancel`);

      assert.strictEqual(res.status, 409);
      assert.strictEqual(remove.mock.calls.length, 0);
      assert.strictEqual(
        await getRepository(MediaRequest).countBy({ id: mediaRequest.id }),
        1
      );
      assert.strictEqual(lookup.mock.calls.length, unsafe === 'shared' ? 0 : 1);
    });
  }

  it('cleans Seerr when the exact Radarr record is already missing', async (t) => {
    const { mediaRequest } = await seedCancellationRequest();
    t.mock.method(RadarrAPI.prototype, 'getMovieIfExists', async () => null);
    t.mock.method(
      RadarrAPI.prototype,
      'getQueueForCancellation',
      async () => []
    );
    const remove = t.mock.method(
      RadarrAPI.prototype,
      'deleteMovieById',
      async () => 'removed' as const
    );
    const agent = await loginAs('friend@seerr.dev', 'test1234');

    const res = await agent.post(`/request/${mediaRequest.id}/cancel`);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.arrRemoval, 'missing');
    assert.strictEqual(remove.mock.calls.length, 0);
    assert.strictEqual(
      await getRepository(MediaRequest).countBy({ id: mediaRequest.id }),
      0
    );
  });

  it('leaves Seerr unchanged on a Radarr deletion failure', async (t) => {
    const { media, mediaRequest } = await seedCancellationRequest();
    t.mock.method(RadarrAPI.prototype, 'getMovieIfExists', async () => movie());
    t.mock.method(
      RadarrAPI.prototype,
      'getQueueForCancellation',
      async () => []
    );
    t.mock.method(RadarrAPI.prototype, 'deleteMovieById', async () => {
      throw new Error('Radarr unavailable');
    });
    const agent = await loginAs('friend@seerr.dev', 'test1234');

    const res = await agent.post(`/request/${mediaRequest.id}/cancel`);

    assert.strictEqual(res.status, 502);
    assert.strictEqual(
      await getRepository(MediaRequest).countBy({ id: mediaRequest.id }),
      1
    );
    const unchanged = await getRepository(Media).findOneOrFail({
      where: { id: media.id },
    });
    assert.strictEqual(unchanged.externalServiceId, 501);
  });

  it('removes a fileless queue-free TV series with no other seasons', async (t) => {
    const { mediaRequest } = await seedCancellationRequest({
      type: MediaType.TV,
      tmdbId: 88001,
    });
    t.mock.method(SonarrAPI.prototype, 'getSeriesIfExists', async () =>
      series()
    );
    t.mock.method(
      SonarrAPI.prototype,
      'getQueueForCancellation',
      async () => []
    );
    t.mock.method(SonarrAPI.prototype, 'getEpisodes', async () => []);
    const remove = t.mock.method(
      SonarrAPI.prototype,
      'deleteSeriesById',
      async () => 'removed' as const
    );
    const agent = await loginAs('friend@seerr.dev', 'test1234');

    const res = await agent.post(`/request/${mediaRequest.id}/cancel`);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(remove.mock.calls.length, 1);
    assert.strictEqual(
      await getRepository(MediaRequest).countBy({ id: mediaRequest.id }),
      0
    );
  });

  it('refuses TV cancellation when episode files or other monitored seasons exist', async (t) => {
    for (const unsafe of ['files', 'seasons'] as const) {
      const { mediaRequest } = await seedCancellationRequest({
        type: MediaType.TV,
        tmdbId: unsafe === 'files' ? 88001 : 88002,
      });
      t.mock.method(SonarrAPI.prototype, 'getSeriesIfExists', async () =>
        series({
          tvdbId: unsafe === 'files' ? 89001 : 89002,
          seasons:
            unsafe === 'seasons'
              ? [
                  { seasonNumber: 1, monitored: true },
                  { seasonNumber: 2, monitored: true },
                ]
              : [{ seasonNumber: 1, monitored: true }],
        })
      );
      t.mock.method(
        SonarrAPI.prototype,
        'getQueueForCancellation',
        async () => []
      );
      t.mock.method(SonarrAPI.prototype, 'getEpisodes', async () =>
        unsafe === 'files'
          ? [
              {
                seriesId: 501,
                episodeFileId: 1,
                seasonNumber: 1,
                episodeNumber: 1,
                title: '',
                airDate: '',
                airDateUtc: '',
                overview: '',
                hasFile: true,
                monitored: true,
                absoluteEpisodeNumber: 1,
                unverifiedSceneNumbering: false,
                id: 1,
              },
            ]
          : []
      );
      const remove = t.mock.method(
        SonarrAPI.prototype,
        'deleteSeriesById',
        async () => 'removed' as const
      );
      const agent = await loginAs('friend@seerr.dev', 'test1234');

      const res = await agent.post(`/request/${mediaRequest.id}/cancel`);

      assert.strictEqual(res.status, 409);
      assert.strictEqual(remove.mock.calls.length, 0);
      assert.strictEqual(
        await getRepository(MediaRequest).countBy({ id: mediaRequest.id }),
        1
      );
      t.mock.restoreAll();
    }
  });

  it('serializes concurrent cancellation attempts', async (t) => {
    const { mediaRequest } = await seedCancellationRequest();
    t.mock.method(RadarrAPI.prototype, 'getMovieIfExists', async () => movie());
    t.mock.method(
      RadarrAPI.prototype,
      'getQueueForCancellation',
      async () => []
    );
    const remove = t.mock.method(
      RadarrAPI.prototype,
      'deleteMovieById',
      async () => 'removed' as const
    );
    const first = await loginAs('friend@seerr.dev', 'test1234');
    const second = await loginAs('friend@seerr.dev', 'test1234');

    const responses = await Promise.all([
      first.post(`/request/${mediaRequest.id}/cancel`),
      second.post(`/request/${mediaRequest.id}/cancel`),
    ]);

    assert.deepStrictEqual(
      responses.map((response) => response.status).sort(),
      [200, 404]
    );
    assert.strictEqual(remove.mock.calls.length, 1);
  });
});

describe('POST /request (movie), override rules', () => {
  it('applies an override rule when the default Radarr server id differs from its array index', async () => {
    configureRadarr([{ id: 5, isDefault: true, is4k: false }]);
    getSettings().sonarr = [];

    const userRepo = getRepository(User);
    const friend = await userRepo.findOneOrFail({
      where: { email: 'friend@seerr.dev' },
    });

    const overrideRuleRepo = getRepository(OverrideRule);
    await overrideRuleRepo.save(
      new OverrideRule({
        radarrServiceId: 5,
        users: String(friend.id),
        rootFolder: '/overridden/movies',
      })
    );

    const agent = await loginAs('friend@seerr.dev', 'test1234');
    const res = await agent.post('/request').send({
      mediaType: MediaType.MOVIE,
      mediaId: 88001,
    });

    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.rootFolder, '/overridden/movies');
  });

  it('applies an override rule when the default Radarr server id matches its array index (sanity check)', async () => {
    configureRadarr([{ id: 0, isDefault: true, is4k: false }]);
    getSettings().sonarr = [];

    const userRepo = getRepository(User);
    const friend = await userRepo.findOneOrFail({
      where: { email: 'friend@seerr.dev' },
    });

    const overrideRuleRepo = getRepository(OverrideRule);
    await overrideRuleRepo.save(
      new OverrideRule({
        radarrServiceId: 0,
        users: String(friend.id),
        rootFolder: '/overridden/movies',
      })
    );

    const agent = await loginAs('friend@seerr.dev', 'test1234');
    const res = await agent.post('/request').send({
      mediaType: MediaType.MOVIE,
      mediaId: 88002,
    });

    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.rootFolder, '/overridden/movies');
  });

  it('does not apply an unrelated override rule when there is no default Radarr server configured', async () => {
    getSettings().radarr = [];
    getSettings().sonarr = [];

    const userRepo = getRepository(User);
    const friend = await userRepo.findOneOrFail({
      where: { email: 'friend@seerr.dev' },
    });

    const overrideRuleRepo = getRepository(OverrideRule);
    await overrideRuleRepo.save(
      new OverrideRule({
        radarrServiceId: 999,
        users: String(friend.id),
        rootFolder: '/overridden/movies',
      })
    );

    const agent = await loginAs('friend@seerr.dev', 'test1234');
    const res = await agent.post('/request').send({
      mediaType: MediaType.MOVIE,
      mediaId: 88005,
    });

    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.rootFolder, null);
  });
});

describe('POST /request (tv), override rules', () => {
  it('applies an override rule when the default Sonarr server id differs from its array index', async () => {
    configureSonarr([{ id: 5, isDefault: true, is4k: false }]);
    getSettings().radarr = [];

    const userRepo = getRepository(User);
    const friend = await userRepo.findOneOrFail({
      where: { email: 'friend@seerr.dev' },
    });

    const overrideRuleRepo = getRepository(OverrideRule);
    await overrideRuleRepo.save(
      new OverrideRule({
        sonarrServiceId: 5,
        users: String(friend.id),
        rootFolder: '/overridden/tv',
      })
    );

    const agent = await loginAs('friend@seerr.dev', 'test1234');
    const res = await agent.post('/request').send({
      mediaType: MediaType.TV,
      mediaId: 88003,
      seasons: [1],
    });

    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.rootFolder, '/overridden/tv');
  });

  it('applies an override rule when the default Sonarr server id matches its array index (sanity check)', async () => {
    configureSonarr([{ id: 0, isDefault: true, is4k: false }]);
    getSettings().radarr = [];

    const userRepo = getRepository(User);
    const friend = await userRepo.findOneOrFail({
      where: { email: 'friend@seerr.dev' },
    });

    const overrideRuleRepo = getRepository(OverrideRule);
    await overrideRuleRepo.save(
      new OverrideRule({
        sonarrServiceId: 0,
        users: String(friend.id),
        rootFolder: '/overridden/tv',
      })
    );

    const agent = await loginAs('friend@seerr.dev', 'test1234');
    const res = await agent.post('/request').send({
      mediaType: MediaType.TV,
      mediaId: 88004,
      seasons: [1],
    });

    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.rootFolder, '/overridden/tv');
  });

  it('does not apply an unrelated override rule when there is no default Sonarr server configured', async () => {
    getSettings().radarr = [];
    getSettings().sonarr = [];

    const userRepo = getRepository(User);
    const friend = await userRepo.findOneOrFail({
      where: { email: 'friend@seerr.dev' },
    });

    const overrideRuleRepo = getRepository(OverrideRule);
    await overrideRuleRepo.save(
      new OverrideRule({
        sonarrServiceId: 999,
        users: String(friend.id),
        rootFolder: '/overridden/tv',
      })
    );

    const agent = await loginAs('friend@seerr.dev', 'test1234');
    const res = await agent.post('/request').send({
      mediaType: MediaType.TV,
      mediaId: 88006,
      seasons: [1],
    });

    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.rootFolder, null);
  });
});
