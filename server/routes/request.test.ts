import assert from 'node:assert/strict';
import { before, beforeEach, describe, it, mock } from 'node:test';

import TheMovieDb from '@server/api/themoviedb';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import Season from '@server/entity/Season';
import type SeasonRequest from '@server/entity/SeasonRequest';
import { User } from '@server/entity/User';
import { Permission } from '@server/lib/permissions';
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

Object.defineProperty(TheMovieDb.prototype, 'getMovie', {
  get() {
    return async ({ movieId }: { movieId: number }) => ({
      id: movieId,
      external_ids: {},
      keywords: { keywords: [] },
      genres: [],
      original_language: 'en',
    });
  },
  set() {},
  configurable: true,
});

Object.defineProperty(TheMovieDb.prototype, 'getTvShow', {
  get() {
    return async ({ tvId }: { tvId: number }) => ({
      id: tvId,
      external_ids: { tvdb_id: tvId + 1000 },
      keywords: { results: [] },
      genres: [],
      original_language: 'en',
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
    });
  },
  set() {},
  configurable: true,
});

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
