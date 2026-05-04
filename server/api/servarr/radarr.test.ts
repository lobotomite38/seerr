import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

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

describe('RadarrAPI.addMovie', () => {
  it('recovers when Radarr times out after the movie was added', async () => {
    const api = new RadarrAPI({
      url: 'http://radarr.test/api/v3',
      apiKey: 'test-key',
    });

    const addedMovie = buildMovie();
    let lookupCount = 0;

    (api as unknown as {
      axios: {
        get: (url: string, config?: { params?: { term?: string } }) => Promise<{
          data: RadarrMovie[];
        }>;
        post: () => Promise<never>;
      };
    }).axios = {
      get: async (url, config) => {
        assert.strictEqual(url, '/movie/lookup');
        assert.strictEqual(config?.params?.term, 'tmdb:24021');
        lookupCount += 1;

        return {
          data: lookupCount === 1 ? [] : [addedMovie],
        };
      },
      post: async () => {
        throw new Error('timeout of 10000ms exceeded');
      },
    };

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
    assert.strictEqual(lookupCount, 2);
  });

  it('still throws when the movie is absent after the retry lookup', async () => {
    const api = new RadarrAPI({
      url: 'http://radarr.test/api/v3',
      apiKey: 'test-key',
    });

    let lookupCount = 0;

    (api as unknown as {
      axios: {
        get: () => Promise<{ data: RadarrMovie[] }>;
        post: () => Promise<never>;
      };
    }).axios = {
      get: async () => {
        lookupCount += 1;

        return {
          data: [],
        };
      },
      post: async () => {
        throw new Error('timeout of 10000ms exceeded');
      },
    };

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

    assert.strictEqual(lookupCount, 2);
  });
});
