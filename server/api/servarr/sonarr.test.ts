import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';

import { Notification } from '@server/lib/notifications';
import PushoverAgent from '@server/lib/notifications/agents/pushover';
import type { AxiosInstance } from 'axios';
import SonarrAPI, {
  type AddSeriesOptions,
  type SonarrSeason,
  type SonarrSeries,
} from './sonarr';

interface MockEpisode {
  id: number;
  seasonNumber: number;
  monitored: boolean;
  hasFile: boolean;
}

interface RequestBody extends Record<string, unknown> {
  name?: string;
}

interface MockAxios {
  get: (
    url: string,
    config?: { params?: Record<string, unknown> }
  ) => Promise<{ data: unknown }>;
  put: (url: string, body: unknown) => Promise<{ data: unknown }>;
  post: (url: string, body: RequestBody) => Promise<{ data: unknown }>;
}

const season = (
  seasonNumber: number,
  statistics?: { episodeCount: number; episodeFileCount: number }
): SonarrSeason => ({
  seasonNumber,
  monitored: false,
  statistics: statistics
    ? {
        ...statistics,
        totalEpisodeCount: statistics.episodeCount,
        sizeOnDisk: 0,
        percentOfEpisodes:
          statistics.episodeCount === 0
            ? 0
            : (statistics.episodeFileCount / statistics.episodeCount) * 100,
      }
    : undefined,
});

const buildSeries = (overrides: Partial<SonarrSeries> = {}): SonarrSeries =>
  ({
    id: 47,
    title: 'The Bear',
    titleSlug: 'the-bear',
    tvdbId: 403294,
    tags: [],
    monitored: true,
    seriesType: 'standard',
    seasons: [season(4, { episodeCount: 10, episodeFileCount: 0 })],
    ...overrides,
  }) as SonarrSeries;

const buildOptions = (
  overrides: Partial<AddSeriesOptions> = {}
): AddSeriesOptions => ({
  tvdbid: 403294,
  title: 'The Bear',
  profileId: 8,
  languageProfileId: 1,
  seasons: [4],
  seasonFolder: false,
  rootFolderPath: '/tv/4k',
  tags: [],
  seriesType: 'standard',
  monitored: true,
  monitorNewItems: 'all',
  searchNow: true,
  ...overrides,
});

const configureApi = ({
  lookupSeries,
  createdSeries,
  refreshedSeries,
  refreshedSeriesResponses,
  episodes = [],
  onCommand,
}: {
  lookupSeries: SonarrSeries;
  createdSeries?: SonarrSeries;
  refreshedSeries?: SonarrSeries;
  refreshedSeriesResponses?: SonarrSeries[];
  episodes?: MockEpisode[];
  onCommand?: (body: RequestBody) => Promise<void>;
}) => {
  const api = new SonarrAPI({
    url: 'http://sonarr.test/api/v3',
    apiKey: 'test-key',
  });
  const commands: RequestBody[] = [];
  const seriesPosts: RequestBody[] = [];
  let refreshedSeriesRequestCount = 0;

  const axios: MockAxios = {
    get: async (url) => {
      if (url === '/series/lookup') {
        return { data: [structuredClone(lookupSeries)] };
      }
      if (url === '/episode') {
        return { data: structuredClone(episodes) };
      }
      if (url.startsWith('/series/')) {
        const response = refreshedSeriesResponses
          ? refreshedSeriesResponses[
              Math.min(
                refreshedSeriesRequestCount,
                refreshedSeriesResponses.length - 1
              )
            ]
          : (refreshedSeries ?? createdSeries ?? buildSeries());
        refreshedSeriesRequestCount++;
        return { data: structuredClone(response) };
      }
      throw new Error(`Unexpected GET ${url}`);
    },
    put: async (url, body) => {
      if (url === '/series') {
        return { data: body };
      }
      if (url === '/episode/monitor') {
        return { data: {} };
      }
      throw new Error(`Unexpected PUT ${url}`);
    },
    post: async (url, body) => {
      if (url === '/series') {
        seriesPosts.push(body);
        return {
          data:
            createdSeries ??
            buildSeries({
              ...body,
              id: 47,
              seriesType: body.seriesType as SonarrSeries['seriesType'],
              seasons: body.seasons as SonarrSeason[],
            }),
        };
      }
      if (url === '/command') {
        commands.push(structuredClone(body));
        await onCommand?.(body);
        return { data: {} };
      }
      throw new Error(`Unexpected POST ${url}`);
    },
  };

  (api as unknown as { axios: MockAxios }).axios = axios;

  return { api, commands, seriesPosts };
};

describe('SonarrAPI.addSeries', () => {
  it('adds a new series without a whole-series search and searches the requested season', async () => {
    const lookupSeries = buildSeries({ id: undefined });
    const { api, commands, seriesPosts } = configureApi({ lookupSeries });

    await api.addSeries(buildOptions());

    assert.equal(seriesPosts.length, 1);
    assert.deepEqual(seriesPosts[0].addOptions, {
      ignoreEpisodesWithFiles: true,
      searchForMissingEpisodes: false,
    });
    assert.deepEqual(commands, [
      { name: 'SeasonSearch', seriesId: 47, seasonNumber: 4 },
    ]);
  });

  it('waits for a new series refresh to populate the requested season before searching', async () => {
    const lookupSeries = buildSeries({ id: undefined });
    const unrefreshedSeries = buildSeries({
      seasons: [season(4)],
    });
    const refreshedSeries = buildSeries({
      seasons: [season(4, { episodeCount: 10, episodeFileCount: 0 })],
    });
    const { api, commands } = configureApi({
      lookupSeries,
      createdSeries: unrefreshedSeries,
      refreshedSeriesResponses: [unrefreshedSeries, refreshedSeries],
    });

    const addPromise = api.addSeries(buildOptions());
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(commands, []);

    await addPromise;
    assert.deepEqual(commands, [
      { name: 'SeasonSearch', seriesId: 47, seasonNumber: 4 },
    ]);
  });

  it('alerts through Pushover when a new series refresh times out', async () => {
    const lookupSeries = buildSeries({ id: undefined });
    const unrefreshedSeries = buildSeries({
      title: 'Friends',
      seasons: [season(1)],
    });
    const { api } = configureApi({
      lookupSeries,
      createdSeries: unrefreshedSeries,
      refreshedSeries: unrefreshedSeries,
    });
    const shouldSend = mock.method(
      PushoverAgent.prototype,
      'shouldSend',
      () => true
    );
    const send = mock.method(PushoverAgent.prototype, 'send', async () => true);

    try {
      await (
        api as unknown as {
          waitForNewSeriesRefresh: (
            series: SonarrSeries,
            seasonNumbers: number[],
            attempts: number,
            intervalMs: number
          ) => Promise<SonarrSeries>;
        }
      ).waitForNewSeriesRefresh(unrefreshedSeries, [1], 1, 0);

      assert.equal(shouldSend.mock.callCount(), 1);
      assert.equal(send.mock.callCount(), 1);
      assert.equal(
        send.mock.calls[0].arguments[0],
        Notification.TEST_NOTIFICATION
      );
      assert.deepEqual(send.mock.calls[0].arguments[1], {
        event: 'Seerr Sonarr search review required',
        subject: 'Friends',
        message:
          'Sonarr did not populate the requested season within 10 seconds. Seerr attempted the season-scoped search fail-open. Verify the Sonarr command history and that the title enters the download queue.',
        extra: [
          { name: 'Series ID', value: '47' },
          { name: 'Seasons', value: '1' },
        ],
        notifySystem: true,
        notifyAdmin: false,
      });
    } finally {
      mock.restoreAll();
    }
  });

  it('updates an existing series and waits for Sonarr to accept the season search', async () => {
    let acceptCommand: (() => void) | undefined;
    const commandAccepted = new Promise<void>((resolve) => {
      acceptCommand = resolve;
    });
    const { api, commands } = configureApi({
      lookupSeries: buildSeries(),
      onCommand: async () => commandAccepted,
    });
    let settled = false;

    const addPromise = api.addSeries(buildOptions()).finally(() => {
      settled = true;
    });
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(settled, false);
    assert.deepEqual(commands, [
      { name: 'SeasonSearch', seriesId: 47, seasonNumber: 4 },
    ]);

    acceptCommand?.();
    await addPromise;
    assert.equal(settled, true);
  });

  it('keeps rapid separate season requests scoped to their own seasons', async () => {
    const { api, commands } = configureApi({
      lookupSeries: buildSeries({
        seasons: [
          season(4, { episodeCount: 10, episodeFileCount: 0 }),
          season(5, { episodeCount: 8, episodeFileCount: 0 }),
        ],
      }),
    });

    await Promise.all([
      api.addSeries(buildOptions({ seasons: [4] })),
      api.addSeries(buildOptions({ seasons: [5] })),
    ]);

    assert.deepEqual(
      commands
        .map((command) => command.seasonNumber)
        .sort((left, right) => Number(left) - Number(right)),
      [4, 5]
    );
    assert.ok(commands.every((command) => command.name === 'SeasonSearch'));
  });

  it('skips only definitively complete seasons and fails open on unknown statistics', async () => {
    const { api, commands } = configureApi({
      lookupSeries: buildSeries({
        seasons: [
          season(3, { episodeCount: 10, episodeFileCount: 10 }),
          season(4, { episodeCount: 10, episodeFileCount: 4 }),
          season(5),
          season(6, { episodeCount: 0, episodeFileCount: 0 }),
        ],
      }),
    });

    await api.addSeries(buildOptions({ seasons: [3, 4, 5, 6] }));

    assert.deepEqual(
      commands.map((command) => command.seasonNumber),
      [4, 5, 6]
    );
  });

  it('uses a fast anime series search for a new requested season pack', async () => {
    const lookupSeries = buildSeries({
      id: undefined,
      seriesType: 'anime',
    });
    const refreshedSeries = buildSeries({
      seriesType: 'anime',
      seasons: [
        {
          ...season(4, { episodeCount: 10, episodeFileCount: 0 }),
          monitored: true,
        },
      ],
    });
    const { api, commands } = configureApi({
      lookupSeries,
      createdSeries: refreshedSeries,
      refreshedSeries,
    });

    await api.addSeries(buildOptions({ seriesType: 'anime' }));

    assert.deepEqual(commands, [{ name: 'SeriesSearch', seriesId: 47 }]);
  });

  it('uses a fast anime series search when only requested seasons are incomplete', async () => {
    const { api, commands } = configureApi({
      lookupSeries: buildSeries({ seriesType: 'anime' }),
    });

    await api.addSeries(buildOptions({ seriesType: 'anime' }));

    assert.deepEqual(commands, [{ name: 'SeriesSearch', seriesId: 47 }]);
  });

  it('corrects an existing series type before choosing the anime fast path', async () => {
    const { api, commands } = configureApi({
      lookupSeries: buildSeries({ seriesType: 'standard' }),
    });

    const updated = await api.addSeries(buildOptions({ seriesType: 'anime' }));

    assert.equal(updated.seriesType, 'anime');
    assert.deepEqual(commands, [{ name: 'SeriesSearch', seriesId: 47 }]);
  });

  it('keeps anime season-scoped when another monitored season is incomplete', async () => {
    const { api, commands } = configureApi({
      lookupSeries: buildSeries({
        seriesType: 'anime',
        seasons: [
          season(3, { episodeCount: 10, episodeFileCount: 0 }),
          season(4, { episodeCount: 10, episodeFileCount: 0 }),
        ].map((item) => ({ ...item, monitored: true })),
      }),
    });

    await api.addSeries(buildOptions({ seriesType: 'anime', seasons: [4] }));

    assert.deepEqual(commands, [
      { name: 'SeasonSearch', seriesId: 47, seasonNumber: 4 },
    ]);
  });

  it('ignores complete monitored anime seasons when choosing fast search', async () => {
    const { api, commands } = configureApi({
      lookupSeries: buildSeries({
        seriesType: 'anime',
        seasons: [
          season(3, { episodeCount: 10, episodeFileCount: 10 }),
          season(4, { episodeCount: 10, episodeFileCount: 0 }),
        ].map((item) => ({ ...item, monitored: true })),
      }),
    });

    await api.addSeries(buildOptions({ seriesType: 'anime', seasons: [4] }));

    assert.deepEqual(commands, [{ name: 'SeriesSearch', seriesId: 47 }]);
  });

  it('preserves searchNow=false deferral without issuing any search command', async () => {
    const { api, commands, seriesPosts } = configureApi({
      lookupSeries: buildSeries({ id: undefined }),
    });

    await api.addSeries(buildOptions({ searchNow: false }));

    assert.equal(seriesPosts.length, 1);
    assert.deepEqual(seriesPosts[0].addOptions, {
      ignoreEpisodesWithFiles: true,
      searchForMissingEpisodes: false,
    });
    assert.deepEqual(commands, []);
  });
});

const buildSonarr = (): SonarrAPI =>
  new SonarrAPI({ url: 'http://localhost:8989/api/v3', apiKey: 'test' });

const getSonarrAxios = (sonarr: SonarrAPI): AxiosInstance =>
  (sonarr as unknown as { axios: AxiosInstance }).axios;

describe('SonarrAPI.removeSeries', () => {
  afterEach(() => mock.restoreAll());

  it('removes the series when it exists in the library', async () => {
    const sonarr = buildSonarr();
    mock.method(SonarrAPI.prototype, 'getSeriesByTvdbId', async () =>
      buildSeries({ id: 9, title: 'Test Series' })
    );
    const del = mock.method(getSonarrAxios(sonarr), 'delete', async () => ({}));

    await sonarr.removeSeries(1234);

    assert.strictEqual(del.mock.callCount(), 1);
    assert.strictEqual(del.mock.calls[0].arguments[0], '/series/9');
  });

  it('does nothing when the series is not in the library', async () => {
    const sonarr = buildSonarr();
    mock.method(getSonarrAxios(sonarr), 'get', async () => ({
      data: [{ id: 0, title: 'Breaking Bad' }],
    }));
    const del = mock.method(getSonarrAxios(sonarr), 'delete', async () => ({}));

    await assert.doesNotReject(() => sonarr.removeSeries(1234));
    assert.strictEqual(del.mock.callCount(), 0);
  });

  it('rejects when the tvdbId is unknown to the lookup', async () => {
    const sonarr = buildSonarr();
    mock.method(getSonarrAxios(sonarr), 'get', async () => ({ data: [] }));
    const del = mock.method(getSonarrAxios(sonarr), 'delete', async () => ({}));

    await assert.rejects(() => sonarr.removeSeries(1234), /Series not found/);
    assert.strictEqual(del.mock.callCount(), 0);
  });

  it('ignores a 404 when the series was already removed in Sonarr', async () => {
    const sonarr = buildSonarr();
    mock.method(SonarrAPI.prototype, 'getSeriesByTvdbId', async () =>
      buildSeries({ id: 9, title: 'Test Series' })
    );
    mock.method(getSonarrAxios(sonarr), 'delete', async () => {
      throw { response: { status: 404 } };
    });

    await assert.doesNotReject(() => sonarr.removeSeries(1234));
  });

  it('rethrows errors other than 404', async () => {
    const sonarr = buildSonarr();
    mock.method(SonarrAPI.prototype, 'getSeriesByTvdbId', async () =>
      buildSeries({ id: 9, title: 'Test Series' })
    );
    mock.method(getSonarrAxios(sonarr), 'delete', async () => {
      throw { response: { status: 500 } };
    });

    await assert.rejects(() => sonarr.removeSeries(1234));
  });

  it('rethrows a 404 from the lookup instead of treating it as removed', async () => {
    const sonarr = buildSonarr();
    mock.method(getSonarrAxios(sonarr), 'get', async () => {
      throw { response: { status: 404 } };
    });
    const del = mock.method(getSonarrAxios(sonarr), 'delete', async () => ({}));

    await assert.rejects(
      () => sonarr.removeSeries(1234),
      (error: unknown) =>
        (error as { response?: { status?: number } }).response?.status === 404
    );
    assert.strictEqual(del.mock.callCount(), 0);
  });
});

describe('SonarrAPI.getSeriesByTvdbId', () => {
  afterEach(() => mock.restoreAll());

  it('rethrows lookup failures with their status intact', async () => {
    const sonarr = buildSonarr();
    mock.method(getSonarrAxios(sonarr), 'get', async () => {
      throw { response: { status: 401 } };
    });

    await assert.rejects(
      () => sonarr.getSeriesByTvdbId(1234),
      (error: unknown) =>
        (error as { response?: { status?: number } }).response?.status === 401
    );
  });

  it('throws "Series not found" when lookup returns no results', async () => {
    const sonarr = buildSonarr();
    mock.method(getSonarrAxios(sonarr), 'get', async () => ({ data: [] }));

    await assert.rejects(() => sonarr.getSeriesByTvdbId(1234), {
      message: 'Series not found',
    });
  });
});
