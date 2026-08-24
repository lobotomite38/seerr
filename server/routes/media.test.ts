import assert from 'node:assert/strict';
import { before, beforeEach, describe, it } from 'node:test';

import RadarrAPI, { type RadarrMovie } from '@server/api/servarr/radarr';
import { MediaStatus, MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { Notification } from '@server/lib/notifications';
import PushoverAgent from '@server/lib/notifications/agents/pushover';
import { getSettings } from '@server/lib/settings';
import { checkUser } from '@server/middleware/auth';
import { setupTestDb } from '@server/test/db';
import type { Express } from 'express';
import express from 'express';
import session from 'express-session';
import request from 'supertest';
import authRoutes from './auth';
import mediaRoutes from './media';

let app: Express;

before(() => {
  app = express();
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
  app.use('/media', mediaRoutes);
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
});

setupTestDb();

beforeEach(() => {
  getSettings().radarr = [
    {
      id: 1,
      name: 'Radarr 1080p',
      hostname: '127.0.0.1',
      port: 9999,
      apiKey: 'test',
      useSsl: false,
      activeProfileId: 1,
      activeProfileName: 'Test',
      activeDirectory: '/test',
      tags: [],
      is4k: false,
      isDefault: true,
      externalUrl: '',
      syncEnabled: true,
      preventSearch: true,
      tagRequests: false,
      overrideRule: [],
      minimumAvailability: 'released',
    },
  ];
});

async function loginAsAdmin() {
  const settings = getSettings();
  const priorLocalLogin = settings.main.localLogin;
  settings.main.localLogin = true;
  try {
    const agent = request.agent(app);
    const res = await agent.post('/auth/local').send({
      email: 'admin@seerr.dev',
      password: 'test1234',
    });
    assert.strictEqual(res.status, 200);
    return agent;
  } finally {
    settings.main.localLogin = priorLocalLogin;
  }
}

describe('GET /media', () => {
  const saveMedia = async () =>
    getRepository(Media).save([
      new Media({
        mediaType: MediaType.MOVIE,
        tmdbId: 99101,
        status: MediaStatus.AVAILABLE,
        status4k: MediaStatus.UNKNOWN,
        mediaAddedAt: new Date('2026-01-01T00:00:00.000Z'),
      }),
      new Media({
        mediaType: MediaType.TV,
        tmdbId: 99102,
        status: MediaStatus.UNKNOWN,
        status4k: MediaStatus.PARTIALLY_AVAILABLE,
        mediaAddedAt: new Date('2026-01-02T00:00:00.000Z'),
      }),
      new Media({
        mediaType: MediaType.MOVIE,
        tmdbId: 99103,
        status: MediaStatus.PROCESSING,
        status4k: MediaStatus.PENDING,
        mediaAddedAt: new Date('2026-01-03T00:00:00.000Z'),
      }),
      new Media({
        mediaType: MediaType.TV,
        tmdbId: 99104,
        status: MediaStatus.PARTIALLY_AVAILABLE,
        status4k: MediaStatus.UNKNOWN,
        mediaAddedAt: new Date('2026-01-04T00:00:00.000Z'),
      }),
      new Media({
        mediaType: MediaType.MOVIE,
        tmdbId: 99105,
        status: MediaStatus.UNKNOWN,
        status4k: MediaStatus.AVAILABLE,
        mediaAddedAt: new Date('2026-01-05T00:00:00.000Z'),
      }),
      new Media({
        mediaType: MediaType.TV,
        tmdbId: 99106,
        status: MediaStatus.AVAILABLE,
        status4k: MediaStatus.AVAILABLE,
        mediaAddedAt: new Date('2026-01-06T00:00:00.000Z'),
      }),
    ]);

  it('includes available and partially available media from either quality', async () => {
    await saveMedia();

    const res = await request(app).get(
      '/media?filter=allavailable&sort=mediaAdded&take=20'
    );

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.pageInfo.results, 5);
    assert.deepStrictEqual(
      res.body.results.map((media: { tmdbId: number }) => media.tmdbId),
      [99106, 99105, 99104, 99102, 99101]
    );
  });

  it('preserves media-added ordering and pagination for both qualities', async () => {
    await saveMedia();

    const res = await request(app).get(
      '/media?filter=allavailable&sort=mediaAdded&take=2&skip=2'
    );

    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body.pageInfo, {
      pages: 3,
      pageSize: 2,
      results: 5,
      page: 2,
    });
    assert.deepStrictEqual(
      res.body.results.map((media: { tmdbId: number }) => media.tmdbId),
      [99104, 99102]
    );
  });
});

describe('DELETE /media/:id/file', () => {
  it('audits the destructive removal and sends one owner-routed Pushover', async (t) => {
    const media = await getRepository(Media).save(
      new Media({
        mediaType: MediaType.MOVIE,
        tmdbId: 99001,
        status: MediaStatus.AVAILABLE,
        status4k: MediaStatus.UNKNOWN,
        serviceId: 1,
        externalServiceId: 77,
      })
    );
    const arrMovie: RadarrMovie = {
      id: 77,
      title: 'Destructive Test',
      isAvailable: true,
      monitored: true,
      tmdbId: 99001,
      imdbId: '',
      titleSlug: 'destructive-test',
      folderName: 'Destructive Test',
      path: '/test/Destructive Test',
      profileId: 1,
      qualityProfileId: 1,
      added: new Date().toISOString(),
      hasFile: true,
      tags: [],
    };
    t.mock.method(
      RadarrAPI.prototype,
      'getMovieIfExists',
      async () => arrMovie
    );
    const remove = t.mock.method(
      RadarrAPI.prototype,
      'removeMovie',
      async () => undefined
    );
    const pushover = t.mock.method(
      PushoverAgent.prototype,
      'send',
      async () => true
    );
    const agent = await loginAsAdmin();

    const res = await agent.delete(`/media/${media.id}/file?is4k=false`);

    assert.strictEqual(res.status, 204);
    assert.strictEqual(remove.mock.calls.length, 1);
    assert.strictEqual(pushover.mock.calls.length, 1);
    assert.strictEqual(
      pushover.mock.calls[0].arguments[0],
      Notification.TEST_NOTIFICATION
    );
    const updated = await getRepository(Media).findOneOrFail({
      where: { id: media.id },
    });
    assert.strictEqual(updated.status, MediaStatus.DELETED);
    assert.strictEqual(updated.serviceId, null);
    assert.strictEqual(updated.externalServiceId, null);
  });
});
