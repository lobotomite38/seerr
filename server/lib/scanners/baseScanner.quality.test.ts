import { MediaStatus, MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import BaseScanner, {
  type ProcessableSeason,
} from '@server/lib/scanners/baseScanner';
import { getSettings } from '@server/lib/settings';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

class TestScanner extends BaseScanner<never> {
  public constructor() {
    super('Test Scanner');
  }

  public start(): string {
    return this.startRun();
  }

  public processTestShow(
    tmdbId: number,
    tvdbId: number,
    seasons: ProcessableSeason[],
    is4k: boolean
  ): Promise<void> {
    return this.processShow(tmdbId, tvdbId, seasons, { is4k });
  }
}

setupTestDb();

describe('BaseScanner.processShow', () => {
  beforeEach(() => {
    const settings = getSettings();
    settings.sonarr = [
      {
        id: 0,
        name: '4K Sonarr',
        hostname: 'localhost',
        port: 8989,
        apiKey: 'test-key',
        useSsl: false,
        baseUrl: '',
        activeProfileId: 1,
        activeProfileName: 'Test',
        activeDirectory: '/tv/4k',
        activeLanguageProfileId: 1,
        tags: [],
        is4k: true,
        isDefault: true,
        syncEnabled: true,
        preventSearch: false,
        tagRequests: false,
        overrideRule: [],
        seriesType: 'standard',
        animeSeriesType: 'anime',
        enableSeasonFolders: true,
        monitorNewItems: 'all',
      },
    ];
    settings.radarr = [];
  });

  it('preserves 4K processing while a standard scan adds library seasons', async () => {
    const mediaRepository = getRepository(Media);
    const media = await mediaRepository.save(
      new Media({
        mediaType: MediaType.TV,
        tmdbId: 387,
        tvdbId: 75886,
        status: MediaStatus.UNKNOWN,
        status4k: MediaStatus.PROCESSING,
        seasons: [],
      })
    );
    const scanner = new TestScanner();
    scanner.start();

    await scanner.processTestShow(
      media.tmdbId,
      media.tvdbId as number,
      [
        {
          seasonNumber: 1,
          episodes: 0,
          episodes4k: 0,
          totalEpisodes: 41,
        },
        {
          seasonNumber: 2,
          episodes: 36,
          episodes4k: 0,
          totalEpisodes: 36,
        },
      ],
      false
    );

    const updated = await mediaRepository.findOneOrFail({
      where: { id: media.id },
    });
    assert.equal(updated.status, MediaStatus.PARTIALLY_AVAILABLE);
    assert.equal(updated.status4k, MediaStatus.PROCESSING);
  });

  it('preserves standard processing while a 4K scan adds library seasons', async () => {
    const mediaRepository = getRepository(Media);
    const media = await mediaRepository.save(
      new Media({
        mediaType: MediaType.TV,
        tmdbId: 388,
        tvdbId: 75887,
        status: MediaStatus.PROCESSING,
        status4k: MediaStatus.UNKNOWN,
        seasons: [],
      })
    );
    const scanner = new TestScanner();
    scanner.start();

    await scanner.processTestShow(
      media.tmdbId,
      media.tvdbId as number,
      [
        {
          seasonNumber: 1,
          episodes: 0,
          episodes4k: 0,
          totalEpisodes: 41,
          is4kOverride: true,
        },
        {
          seasonNumber: 2,
          episodes: 0,
          episodes4k: 36,
          totalEpisodes: 36,
          is4kOverride: true,
        },
      ],
      true
    );

    const updated = await mediaRepository.findOneOrFail({
      where: { id: media.id },
    });
    assert.equal(updated.status, MediaStatus.PROCESSING);
    assert.equal(updated.status4k, MediaStatus.PARTIALLY_AVAILABLE);
  });
});
