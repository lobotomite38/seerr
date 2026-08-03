import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';

import type { AxiosInstance } from 'axios';
import RadarrAPI, { type RadarrMovie } from './radarr';

const buildMovie = (overrides: Partial<RadarrMovie> = {}): RadarrMovie => ({
  id: 236,
  title: 'The Twilight Saga: Eclipse',
  isAvailable: true,
  monitored: true,
  tmdbId: 24021,
  imdbId: 'tt1325004',
  titleSlug: '24021',
  folderName: '/movies/The Twilight Saga - Eclipse (2010)',
  path: '/movies/The Twilight Saga - Eclipse (2010)',
  profileId: 12,
  qualityProfileId: 12,
  added: '2026-04-12T02:58:30Z',
  hasFile: false,
  tags: [],
  ...overrides,
});

const buildRadarr = (): RadarrAPI =>
  new RadarrAPI({ url: 'http://localhost:7878/api/v3', apiKey: 'test' });

const getAxios = (radarr: RadarrAPI): AxiosInstance =>
  (radarr as unknown as { axios: AxiosInstance }).axios;

const useImmediateRecovery = (radarr: RadarrAPI): void => {
  Object.assign(radarr, {
    addRecoveryPollAttempts: 1,
    addRecoveryPollIntervalMs: 0,
  });
};

describe('RadarrAPI.addMovie', () => {
  afterEach(() => mock.restoreAll());

  it('recovers when Radarr times out after the movie was added', async () => {
    const api = buildRadarr();
    useImmediateRecovery(api);
    const addedMovie = buildMovie();
    const axios = getAxios(api);
    const get = mock.method(axios, 'get', async (url: string) => ({
      data:
        url === '/movie/lookup'
          ? [buildMovie({ id: 0, monitored: false })]
          : [addedMovie],
    }));
    const post = mock.method(axios, 'post', async (url: string) => {
      if (url === '/movie') {
        throw new Error('timeout of 10000ms exceeded');
      }
      return { data: { id: 991, name: 'MoviesSearch' } };
    });

    const movie = await api.addMovie({
      title: addedMovie.title,
      tmdbId: addedMovie.tmdbId,
      qualityProfileId: addedMovie.qualityProfileId,
      profileId: addedMovie.profileId,
      year: 2010,
      minimumAvailability: 'inCinemas',
      rootFolderPath: '/movies',
      tags: [],
      monitored: true,
      searchNow: true,
    });

    assert.strictEqual(movie.id, addedMovie.id);
    assert.deepStrictEqual(
      get.mock.calls.map((call) => call.arguments[0]),
      ['/movie/lookup', '/movie']
    );
    assert.strictEqual(post.mock.callCount(), 2);
    assert.deepStrictEqual(post.mock.calls[1].arguments[1], {
      name: 'MoviesSearch',
      movieIds: [addedMovie.id],
    });
  });

  it('still throws when the movie was not installed before the timeout', async () => {
    const api = buildRadarr();
    useImmediateRecovery(api);
    const axios = getAxios(api);
    mock.method(axios, 'get', async (url: string) => ({
      data:
        url === '/movie/lookup'
          ? [buildMovie({ id: 0, monitored: false })]
          : [],
    }));
    mock.method(axios, 'post', async () => {
      throw new Error('timeout of 10000ms exceeded');
    });

    await assert.rejects(
      api.addMovie({
        title: 'Missing Movie',
        tmdbId: 999999,
        qualityProfileId: 12,
        profileId: 12,
        year: 2010,
        minimumAvailability: 'inCinemas',
        rootFolderPath: '/movies',
        tags: [],
        monitored: true,
        searchNow: true,
      }),
      /Failed to add movie to Radarr/
    );
  });

  it('reconciles partial persisted settings before searching', async () => {
    const api = buildRadarr();
    useImmediateRecovery(api);
    const axios = getAxios(api);
    const partial = buildMovie({
      monitored: false,
      qualityProfileId: 3,
      profileId: 3,
      path: '/wrong/The Castle (1997)',
      tags: [4],
    });
    mock.method(axios, 'get', async (url: string) => ({
      data:
        url === '/movie/lookup'
          ? [buildMovie({ id: 0, monitored: false })]
          : [partial],
    }));
    const put = mock.method(
      axios,
      'put',
      async (_url: string, body: unknown) => ({
        data: {
          ...partial,
          ...(body as object),
          path: '/movies/The Castle (1997)',
        },
      })
    );
    const post = mock.method(axios, 'post', async (url: string) => {
      if (url === '/movie') {
        throw new Error('timeout of 10000ms exceeded');
      }
      return { data: { id: 992 } };
    });

    const movie = await api.addMovie({
      title: 'The Castle',
      tmdbId: partial.tmdbId,
      qualityProfileId: 12,
      profileId: 12,
      year: 1997,
      minimumAvailability: 'released',
      rootFolderPath: '/movies',
      tags: [9],
      monitored: true,
      searchNow: true,
    });

    assert.strictEqual(movie.monitored, true);
    assert.strictEqual(put.mock.callCount(), 1);
    assert.deepStrictEqual(
      (put.mock.calls[0].arguments[1] as { tags: number[] }).tags,
      [4, 9]
    );
    assert.strictEqual(post.mock.callCount(), 2);
  });

  it('rejects when the recovered movie search command is not accepted', async () => {
    const api = buildRadarr();
    useImmediateRecovery(api);
    const axios = getAxios(api);
    mock.method(axios, 'get', async (url: string) => ({
      data:
        url === '/movie/lookup'
          ? [buildMovie({ id: 0, monitored: false })]
          : [buildMovie()],
    }));
    mock.method(axios, 'post', async (url: string) => {
      if (url === '/movie') {
        throw new Error('timeout of 10000ms exceeded');
      }
      return { data: {} };
    });

    await assert.rejects(
      api.addMovie({
        title: 'The Castle',
        tmdbId: 24021,
        qualityProfileId: 12,
        profileId: 12,
        year: 1997,
        minimumAvailability: 'released',
        rootFolderPath: '/movies',
        tags: [],
        monitored: true,
        searchNow: true,
      }),
      /Failed to add movie to Radarr/
    );
  });

  it('does not search a recovered movie that already has a file', async () => {
    const api = buildRadarr();
    useImmediateRecovery(api);
    const axios = getAxios(api);
    mock.method(axios, 'get', async (url: string) => ({
      data:
        url === '/movie/lookup'
          ? [buildMovie({ id: 0, monitored: false })]
          : [buildMovie({ hasFile: true })],
    }));
    const post = mock.method(axios, 'post', async () => {
      throw new Error('timeout of 10000ms exceeded');
    });

    await assert.doesNotReject(() =>
      api.addMovie({
        title: 'The Castle',
        tmdbId: 24021,
        qualityProfileId: 12,
        profileId: 12,
        year: 1997,
        minimumAvailability: 'released',
        rootFolderPath: '/movies',
        tags: [],
        monitored: true,
        searchNow: true,
      })
    );
    assert.strictEqual(post.mock.callCount(), 1);
  });
});

describe('RadarrAPI.removeMovie', () => {
  afterEach(() => mock.restoreAll());

  it('removes the movie when it exists in the library', async () => {
    const radarr = buildRadarr();
    mock.method(RadarrAPI.prototype, 'getMovieByTmdbId', async () =>
      buildMovie({ id: 7, title: 'Test Movie' })
    );
    const del = mock.method(getAxios(radarr), 'delete', async () => ({}));

    await radarr.removeMovie(550);

    assert.strictEqual(del.mock.callCount(), 1);
    assert.strictEqual(del.mock.calls[0].arguments[0], '/movie/7');
  });

  it('does nothing when the movie is not in the library', async () => {
    const radarr = buildRadarr();
    mock.method(getAxios(radarr), 'get', async () => ({
      data: [{ id: 0, title: 'Fight Club' }],
    }));
    const del = mock.method(getAxios(radarr), 'delete', async () => ({}));

    await assert.doesNotReject(() => radarr.removeMovie(550));
    assert.strictEqual(del.mock.callCount(), 0);
  });

  it('rejects when the tmdbId is unknown to the lookup', async () => {
    const radarr = buildRadarr();
    mock.method(getAxios(radarr), 'get', async () => ({ data: [] }));
    const del = mock.method(getAxios(radarr), 'delete', async () => ({}));

    await assert.rejects(() => radarr.removeMovie(550), /Movie not found/);
    assert.strictEqual(del.mock.callCount(), 0);
  });

  it('ignores a 404 when the movie was already removed in Radarr', async () => {
    const radarr = buildRadarr();
    mock.method(RadarrAPI.prototype, 'getMovieByTmdbId', async () =>
      buildMovie({ id: 7, title: 'Test Movie' })
    );
    mock.method(getAxios(radarr), 'delete', async () => {
      throw { response: { status: 404 } };
    });

    await assert.doesNotReject(() => radarr.removeMovie(550));
  });

  it('rethrows errors other than 404', async () => {
    const radarr = buildRadarr();
    mock.method(RadarrAPI.prototype, 'getMovieByTmdbId', async () =>
      buildMovie({ id: 7, title: 'Test Movie' })
    );
    mock.method(getAxios(radarr), 'delete', async () => {
      throw { response: { status: 500 } };
    });

    await assert.rejects(() => radarr.removeMovie(550));
  });

  it('rethrows a 404 from the lookup instead of treating it as removed', async () => {
    const radarr = buildRadarr();
    mock.method(getAxios(radarr), 'get', async () => {
      throw { response: { status: 404 } };
    });
    const del = mock.method(getAxios(radarr), 'delete', async () => ({}));

    await assert.rejects(
      () => radarr.removeMovie(550),
      (error: unknown) =>
        (error as { response?: { status?: number } }).response?.status === 404
    );
    assert.strictEqual(del.mock.callCount(), 0);
  });
});

describe('RadarrAPI.getMovieByTmdbId', () => {
  afterEach(() => mock.restoreAll());

  it('rethrows lookup failures with their status intact', async () => {
    const radarr = buildRadarr();
    mock.method(getAxios(radarr), 'get', async () => {
      throw { response: { status: 401 } };
    });

    await assert.rejects(
      () => radarr.getMovieByTmdbId(550),
      (error: unknown) =>
        (error as { response?: { status?: number } }).response?.status === 401
    );
  });

  it('throws "Movie not found" when lookup returns no results', async () => {
    const radarr = buildRadarr();
    mock.method(getAxios(radarr), 'get', async () => ({ data: [] }));

    await assert.rejects(() => radarr.getMovieByTmdbId(550), {
      message: 'Movie not found',
    });
  });
});
