import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import type {
  AddSeriesOptions,
  SonarrSeries,
} from '@server/api/servarr/sonarr';
import SonarrAPI from '@server/api/servarr/sonarr';
import TheMovieDb from '@server/api/themoviedb';
import type { TmdbTvDetails } from '@server/api/themoviedb/interfaces';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import Season from '@server/entity/Season';
import SeasonRequest from '@server/entity/SeasonRequest';
import { User } from '@server/entity/User';
import type { SonarrSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import { MediaRequestSubscriber } from '@server/subscriber/MediaRequestSubscriber';
import { setupTestDb } from '@server/test/db';

let addSeriesCalls: AddSeriesOptions[] = [];

Object.defineProperty(SonarrAPI.prototype, 'addSeries', {
  get() {
    return async (options: AddSeriesOptions) => {
      addSeriesCalls.push(options);
      return {
        id: 77,
        title: options.title,
        titleSlug: 'test-show',
      } as SonarrSeries;
    };
  },
  set() {},
  configurable: true,
});

Object.defineProperty(SonarrAPI.prototype, 'clearCache', {
  get() {
    return () => {};
  },
  set() {},
  configurable: true,
});

Object.defineProperty(TheMovieDb.prototype, 'getTvShow', {
  get() {
    return async () =>
      ({
        id: 123,
        name: 'Test Show',
        external_ids: { tvdb_id: 456 },
        keywords: { results: [] },
      }) as unknown as TmdbTvDetails;
  },
  set() {},
  configurable: true,
});

setupTestDb();

function configureSonarr(): void {
  const settings = getSettings();
  settings.sonarr = [
    {
      id: 0,
      name: 'Sonarr',
      hostname: 'localhost',
      port: 8989,
      apiKey: 'test-key',
      useSsl: false,
      baseUrl: '',
      activeProfileId: 1,
      activeProfileName: 'Test',
      activeDirectory: '/tv',
      activeLanguageProfileId: 1,
      tags: [],
      is4k: false,
      isDefault: true,
      syncEnabled: true,
      preventSearch: false,
      tagRequests: false,
      overrideRule: [],
      seriesType: 'standard',
      animeSeriesType: 'anime',
      enableSeasonFolders: true,
      monitorNewItems: 'all',
    } satisfies SonarrSettings,
  ];
}

async function seedTvRequest({
  requestedSeasonStatus,
}: {
  requestedSeasonStatus: MediaStatus;
}): Promise<MediaRequest> {
  const userRepository = getRepository(User);
  const mediaRepository = getRepository(Media);
  const requestRepository = getRepository(MediaRequest);

  const requestedBy = await userRepository.findOneOrFail({
    where: { email: 'admin@seerr.dev' },
  });
  const media = await mediaRepository.save(
    new Media({
      mediaType: MediaType.TV,
      tmdbId: 123,
      tvdbId: 456,
      status: MediaStatus.AVAILABLE,
      status4k: MediaStatus.UNKNOWN,
      seasons: [
        new Season({ seasonNumber: 1, status: MediaStatus.AVAILABLE }),
        new Season({ seasonNumber: 2, status: requestedSeasonStatus }),
      ],
    })
  );

  const request = await requestRepository.save(
    new MediaRequest({
      type: MediaType.TV,
      status: MediaRequestStatus.PENDING,
      media,
      requestedBy,
      is4k: false,
      seasons: [
        new SeasonRequest({
          seasonNumber: 2,
          status: MediaRequestStatus.PENDING,
        }),
      ],
    })
  );

  const seededRequest = await requestRepository.findOneOrFail({
    where: { id: request.id },
  });
  seededRequest.status = MediaRequestStatus.APPROVED;
  seededRequest.seasons.forEach((season) => {
    season.status = MediaRequestStatus.APPROVED;
  });

  return seededRequest;
}

beforeEach(() => {
  addSeriesCalls = [];
  configureSonarr();
});

describe('MediaRequestSubscriber.sendToSonarr', () => {
  it('does not complete a TV season request just because the series is available', async () => {
    const request = await seedTvRequest({
      requestedSeasonStatus: MediaStatus.UNKNOWN,
    });

    await new MediaRequestSubscriber().sendToSonarr(request);

    assert.equal(request.status, MediaRequestStatus.APPROVED);
    assert.equal(request.seasons[0].status, MediaRequestStatus.APPROVED);
    assert.equal(addSeriesCalls.length, 1);
    assert.deepEqual(addSeriesCalls[0].seasons, [2]);
  });

  it('completes a TV season request when the requested season is already available', async () => {
    const request = await seedTvRequest({
      requestedSeasonStatus: MediaStatus.AVAILABLE,
    });

    await new MediaRequestSubscriber().sendToSonarr(request);

    assert.equal(request.status, MediaRequestStatus.COMPLETED);
    assert.equal(request.seasons[0].status, MediaRequestStatus.COMPLETED);
    assert.equal(addSeriesCalls.length, 0);
  });
});
