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
import dataSource, { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import Season from '@server/entity/Season';
import SeasonRequest from '@server/entity/SeasonRequest';
import { User } from '@server/entity/User';
import type { SonarrSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import {
  MediaRequestSubscriber,
  shouldDeferFreshMovieSearch,
  shouldDeferFreshSeriesSearch,
} from '@server/subscriber/MediaRequestSubscriber';
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
        first_air_date: '2020-01-01',
        seasons: [
          {
            id: 2,
            season_number: 2,
            air_date: '2020-01-01',
            episode_count: 10,
            name: 'Season 2',
            overview: '',
          },
        ],
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

describe('fresh release search deferral', () => {
  it('defers movie search when a digital release is inside the freshness window', () => {
    const shouldDefer = shouldDeferFreshMovieSearch(
      {
        release_date: '2026-05-28',
        release_dates: {
          results: [
            {
              iso_3166_1: 'US',
              rating: '',
              release_dates: [
                {
                  certification: '',
                  release_date: '2026-06-16T00:00:00.000Z',
                  type: 4,
                },
              ],
            },
          ],
        },
      },
      new Date('2026-06-18T00:00:00.000Z')
    );

    assert.equal(shouldDefer, true);
  });

  it('does not defer movie search when the latest release signal is old', () => {
    const shouldDefer = shouldDeferFreshMovieSearch(
      {
        release_date: '2026-05-01',
        release_dates: {
          results: [],
        },
      },
      new Date('2026-06-18T00:00:00.000Z')
    );

    assert.equal(shouldDefer, false);
  });

  it('defers series search when a requested season aired inside the freshness window', () => {
    const shouldDefer = shouldDeferFreshSeriesSearch(
      {
        first_air_date: '2020-01-01',
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
            air_date: '2026-06-17',
            episode_count: 10,
            name: 'Season 2',
            overview: '',
          },
        ],
      },
      [2],
      new Date('2026-06-18T00:00:00.000Z')
    );

    assert.equal(shouldDefer, true);
  });

  it('does not defer series search when only unrequested seasons are fresh', () => {
    const shouldDefer = shouldDeferFreshSeriesSearch(
      {
        first_air_date: '2020-01-01',
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
            air_date: '2026-06-17',
            episode_count: 10,
            name: 'Season 2',
            overview: '',
          },
        ],
      },
      [1],
      new Date('2026-06-18T00:00:00.000Z')
    );

    assert.equal(shouldDefer, false);
  });
});

describe('MediaRequestSubscriber.sendToSonarr', () => {
  it('does not complete a TV season request just because the series is available', async () => {
    const request = await seedTvRequest({
      requestedSeasonStatus: MediaStatus.UNKNOWN,
    });

    await new MediaRequestSubscriber().sendToSonarr(
      request,
      dataSource.manager
    );

    assert.equal(request.status, MediaRequestStatus.APPROVED);
    assert.equal(request.seasons[0].status, MediaRequestStatus.APPROVED);
    assert.equal(addSeriesCalls.length, 1);
    assert.deepEqual(addSeriesCalls[0].seasons, [2]);
  });

  it('completes a TV season request when the requested season is already available', async () => {
    const request = await seedTvRequest({
      requestedSeasonStatus: MediaStatus.AVAILABLE,
    });

    await new MediaRequestSubscriber().sendToSonarr(
      request,
      dataSource.manager
    );

    assert.equal(request.status, MediaRequestStatus.COMPLETED);
    assert.equal(request.seasons[0].status, MediaRequestStatus.COMPLETED);
    assert.equal(addSeriesCalls.length, 0);
  });
});

describe('MediaRequestSubscriber.updateParentStatus', () => {
  it('creates processing 4K season state for an approved TV request', async () => {
    const mediaRepository = getRepository(Media);
    const media = await mediaRepository.save(
      new Media({
        mediaType: MediaType.TV,
        tmdbId: 789,
        tvdbId: 987,
        status: MediaStatus.UNKNOWN,
        status4k: MediaStatus.PENDING,
        seasons: [],
      })
    );
    const request = new MediaRequest({
      type: MediaType.TV,
      status: MediaRequestStatus.APPROVED,
      media,
      is4k: true,
      seasons: [
        new SeasonRequest({
          seasonNumber: 1,
          status: MediaRequestStatus.APPROVED,
        }),
      ],
    });

    await new MediaRequestSubscriber().updateParentStatus(
      dataSource.manager,
      request
    );

    const updated = await mediaRepository.findOneOrFail({
      where: { id: media.id },
    });
    assert.equal(updated.status4k, MediaStatus.PROCESSING);
    assert.equal(updated.seasons.length, 1);
    assert.equal(updated.seasons[0].seasonNumber, 1);
    assert.equal(updated.seasons[0].status, MediaStatus.UNKNOWN);
    assert.equal(updated.seasons[0].status4k, MediaStatus.PROCESSING);
  });

  it('creates processing standard season state without changing available 4K state', async () => {
    const mediaRepository = getRepository(Media);
    const media = await mediaRepository.save(
      new Media({
        mediaType: MediaType.TV,
        tmdbId: 790,
        tvdbId: 988,
        status: MediaStatus.PENDING,
        status4k: MediaStatus.AVAILABLE,
        seasons: [],
      })
    );
    const request = new MediaRequest({
      type: MediaType.TV,
      status: MediaRequestStatus.APPROVED,
      media,
      is4k: false,
      seasons: [
        new SeasonRequest({
          seasonNumber: 2,
          status: MediaRequestStatus.APPROVED,
        }),
      ],
    });

    await new MediaRequestSubscriber().updateParentStatus(
      dataSource.manager,
      request
    );

    const updated = await mediaRepository.findOneOrFail({
      where: { id: media.id },
    });
    assert.equal(updated.status, MediaStatus.PROCESSING);
    assert.equal(updated.status4k, MediaStatus.AVAILABLE);
    assert.equal(updated.seasons.length, 1);
    assert.equal(updated.seasons[0].seasonNumber, 2);
    assert.equal(updated.seasons[0].status, MediaStatus.PROCESSING);
    assert.equal(updated.seasons[0].status4k, MediaStatus.UNKNOWN);
  });

  it('marks an existing requested season processing without overwriting its opposite quality', async () => {
    const mediaRepository = getRepository(Media);
    const media = await mediaRepository.save(
      new Media({
        mediaType: MediaType.TV,
        tmdbId: 791,
        tvdbId: 989,
        status: MediaStatus.PARTIALLY_AVAILABLE,
        status4k: MediaStatus.PENDING,
        seasons: [
          new Season({
            seasonNumber: 3,
            status: MediaStatus.AVAILABLE,
            status4k: MediaStatus.UNKNOWN,
          }),
        ],
      })
    );
    const request = new MediaRequest({
      type: MediaType.TV,
      status: MediaRequestStatus.APPROVED,
      media,
      is4k: true,
      seasons: [
        new SeasonRequest({
          seasonNumber: 3,
          status: MediaRequestStatus.APPROVED,
        }),
      ],
    });

    await new MediaRequestSubscriber().updateParentStatus(
      dataSource.manager,
      request
    );

    const updated = await mediaRepository.findOneOrFail({
      where: { id: media.id },
    });
    assert.equal(updated.status, MediaStatus.PARTIALLY_AVAILABLE);
    assert.equal(updated.status4k, MediaStatus.PROCESSING);
    assert.equal(updated.seasons.length, 1);
    assert.equal(updated.seasons[0].status, MediaStatus.AVAILABLE);
    assert.equal(updated.seasons[0].status4k, MediaStatus.PROCESSING);
  });
});
