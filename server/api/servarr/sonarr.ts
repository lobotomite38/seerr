import { Notification } from '@server/lib/notifications';
import PushoverAgent from '@server/lib/notifications/agents/pushover';
import logger from '@server/logger';
import type { AxiosResponse } from 'axios';
import ServarrBase from './base';

const NEW_SERIES_REFRESH_ATTEMPTS = 40;
const NEW_SERIES_REFRESH_INTERVAL_MS = 250;

export interface SonarrSeason {
  seasonNumber: number;
  monitored: boolean;
  statistics?: {
    previousAiring?: string;
    episodeFileCount: number;
    episodeCount: number;
    totalEpisodeCount: number;
    sizeOnDisk: number;
    percentOfEpisodes: number;
  };
}
interface EpisodeResult {
  seriesId: number;
  episodeFileId: number;
  seasonNumber: number;
  episodeNumber: number;
  title: string;
  airDate: string;
  airDateUtc: string;
  overview: string;
  hasFile: boolean;
  monitored: boolean;
  absoluteEpisodeNumber: number;
  unverifiedSceneNumbering: boolean;
  id: number;
}

export type SonarrWantedEpisode = EpisodeResult;

export interface SonarrSeries {
  title: string;
  sortTitle: string;
  seasonCount: number;
  status: string;
  overview: string;
  network: string;
  airTime: string;
  images: {
    coverType: string;
    url: string;
  }[];
  remotePoster: string;
  seasons: SonarrSeason[];
  year: number;
  path: string;
  profileId: number;
  languageProfileId: number;
  seasonFolder: boolean;
  monitored: boolean;
  monitorNewItems: 'all' | 'none';
  useSceneNumbering: boolean;
  runtime: number;
  tvdbId: number;
  tvRageId: number;
  tvMazeId: number;
  firstAired: string;
  lastInfoSync?: string;
  seriesType: 'standard' | 'daily' | 'anime';
  cleanTitle: string;
  imdbId: string;
  titleSlug: string;
  certification: string;
  genres: string[];
  tags: number[];
  added: string;
  ratings: {
    votes: number;
    value: number;
  };
  qualityProfileId: number;
  id?: number;
  rootFolderPath?: string;
  addOptions?: {
    ignoreEpisodesWithFiles?: boolean;
    ignoreEpisodesWithoutFiles?: boolean;
    searchForMissingEpisodes?: boolean;
  };
  statistics: {
    seasonCount: number;
    episodeFileCount: number;
    episodeCount: number;
    totalEpisodeCount: number;
    sizeOnDisk: number;
    releaseGroups: string[];
    percentOfEpisodes: number;
  };
}

export interface AddSeriesOptions {
  tvdbid: number;
  title: string;
  profileId: number;
  languageProfileId?: number;
  seasons: number[];
  seasonFolder: boolean;
  rootFolderPath: string;
  tags?: number[];
  seriesType: SonarrSeries['seriesType'];
  monitored?: boolean;
  monitorNewItems?: SonarrSeries['monitorNewItems'];
  searchNow?: boolean;
}

export interface LanguageProfile {
  id: number;
  name: string;
}

class SonarrAPI extends ServarrBase<{
  seriesId: number;
  episodeId: number;
  episode: EpisodeResult;
}> {
  constructor({ url, apiKey }: { url: string; apiKey: string }) {
    super({ url, apiKey, apiName: 'Sonarr', cacheName: 'sonarr' });
  }

  public async getSeries(): Promise<SonarrSeries[]> {
    try {
      const response = await this.axios.get<SonarrSeries[]>('/series');

      return response.data;
    } catch (e) {
      throw new Error(`[Sonarr] Failed to retrieve series: ${e.message}`, {
        cause: e,
      });
    }
  }

  public async getSeriesById(id: number): Promise<SonarrSeries> {
    try {
      const response = await this.axios.get<SonarrSeries>(`/series/${id}`);

      return response.data;
    } catch (e) {
      throw new Error(
        `[Sonarr] Failed to retrieve series by ID: ${e.message}`,
        { cause: e }
      );
    }
  }

  public async getSeriesByTitle(title: string): Promise<SonarrSeries[]> {
    try {
      const response = await this.axios.get<SonarrSeries[]>('/series/lookup', {
        params: {
          term: title,
        },
      });

      if (!response.data[0]) {
        throw new Error('No series found');
      }

      return response.data;
    } catch (e) {
      logger.error('Error retrieving series by series title', {
        label: 'Sonarr API',
        errorMessage: e.message,
        title,
      });
      throw new Error('No series found', { cause: e });
    }
  }

  public async getSeriesByTvdbId(id: number): Promise<SonarrSeries> {
    let response: AxiosResponse<SonarrSeries[]>;
    try {
      response = await this.axios.get<SonarrSeries[]>('/series/lookup', {
        params: {
          term: `tvdb:${id}`,
        },
      });
    } catch (e) {
      logger.error('Error retrieving series by tvdb ID', {
        label: 'Sonarr API',
        errorMessage: e.message,
        tvdbId: id,
      });
      throw e;
    }

    if (!response.data[0]) {
      throw new Error('Series not found');
    }

    return response.data[0];
  }

  public async addSeries(options: AddSeriesOptions): Promise<SonarrSeries> {
    try {
      const series = await this.getSeriesByTvdbId(options.tvdbid);

      // If the series already exists, we will simply just update it
      if (series.id) {
        series.monitored = options.monitored ?? series.monitored;
        series.seriesType = options.seriesType;
        series.tags = options.tags
          ? Array.from(new Set([...series.tags, ...options.tags]))
          : series.tags;
        series.seasons = this.buildSeasonList(options.seasons, series.seasons);

        const newSeriesResponse = await this.axios.put<SonarrSeries>(
          '/series',
          series
        );

        if (newSeriesResponse.data.id) {
          logger.info('Updated existing series in Sonarr.', {
            label: 'Sonarr',
            seriesId: newSeriesResponse.data.id,
            seriesTitle: newSeriesResponse.data.title,
          });
          logger.debug('Sonarr update details', {
            label: 'Sonarr',
            series: newSeriesResponse.data,
          });

          try {
            const episodes = await this.getEpisodes(newSeriesResponse.data.id);
            const episodeIdsToMonitor = episodes
              .filter(
                (ep) =>
                  options.seasons.includes(ep.seasonNumber) && !ep.monitored
              )
              .map((ep) => ep.id);

            if (episodeIdsToMonitor.length > 0) {
              logger.debug(
                'Re-monitoring unmonitored episodes for requested seasons.',
                {
                  label: 'Sonarr',
                  seriesId: newSeriesResponse.data.id,
                  episodeCount: episodeIdsToMonitor.length,
                }
              );
              await this.monitorEpisodes(episodeIdsToMonitor);
            }
          } catch (e) {
            logger.warn('Failed to re-monitor episodes', {
              label: 'Sonarr',
              errorMessage: e.message,
              seriesId: newSeriesResponse.data.id,
            });
          }

          if (options.searchNow) {
            await this.searchRequestedSeasons(
              newSeriesResponse.data,
              options.seasons
            );
          }

          return newSeriesResponse.data;
        } else {
          logger.error('Failed to update series in Sonarr', {
            label: 'Sonarr',
            options,
          });
          throw new Error('Failed to update series in Sonarr');
        }
      }

      const createdSeriesResponse = await this.axios.post<SonarrSeries>(
        '/series',
        {
          tvdbId: options.tvdbid,
          title: options.title,
          qualityProfileId: options.profileId,
          languageProfileId: options.languageProfileId,
          seasons: this.buildSeasonList(
            options.seasons,
            series.seasons.map((season) => ({
              seasonNumber: season.seasonNumber,
              // We force all seasons to false if its the first request
              monitored: false,
            }))
          ),
          tags: options.tags,
          seasonFolder: options.seasonFolder,
          monitored: options.monitored,
          monitorNewItems: options.monitorNewItems,
          rootFolderPath: options.rootFolderPath,
          seriesType: options.seriesType,
          addOptions: {
            ignoreEpisodesWithFiles: true,
            // Sonarr's add-time search is series-wide. Requested seasons are
            // searched explicitly after the series has been accepted instead.
            searchForMissingEpisodes: false,
          },
        } as Partial<SonarrSeries>
      );

      if (createdSeriesResponse.data.id) {
        logger.info('Sonarr accepted request', { label: 'Sonarr' });
        logger.debug('Sonarr add details', {
          label: 'Sonarr',
          series: createdSeriesResponse.data,
        });

        if (options.searchNow) {
          const refreshedSeries = await this.waitForNewSeriesRefresh(
            createdSeriesResponse.data,
            options.seasons
          );
          await this.searchRequestedSeasons(refreshedSeries, options.seasons);
        }
      } else {
        logger.error('Failed to add series to Sonarr', {
          label: 'Sonarr',
          options,
        });
        throw new Error('Failed to add series to Sonarr');
      }

      return createdSeriesResponse.data;
    } catch (e) {
      logger.error('Something went wrong while adding a series to Sonarr.', {
        label: 'Sonarr API',
        errorMessage: e.message,
        options,
        response: e?.response?.data,
      });
      throw new Error('Failed to add series', { cause: e });
    }
  }

  public async getLanguageProfiles(): Promise<LanguageProfile[]> {
    try {
      const data = await this.getRolling<LanguageProfile[]>(
        '/languageprofile',
        undefined,
        3600
      );

      return data;
    } catch (e) {
      logger.error(
        'Something went wrong while retrieving Sonarr language profiles.',
        {
          label: 'Sonarr API',
          errorMessage: e.message,
        }
      );

      throw new Error('Failed to get language profiles', { cause: e });
    }
  }

  public async searchSeries(seriesId: number): Promise<void> {
    logger.info('Executing series search command.', {
      label: 'Sonarr API',
      seriesId,
    });

    try {
      await this.runCommand('MissingEpisodeSearch', { seriesId });
    } catch (e) {
      logger.error(
        'Something went wrong while executing Sonarr missing episode search.',
        {
          label: 'Sonarr API',
          errorMessage: e.message,
          seriesId,
        }
      );
    }
  }

  private async searchRequestedSeasons(
    series: SonarrSeries,
    requestedSeasons: number[]
  ): Promise<void> {
    if (!series.id) {
      return;
    }

    const seasonsToSearch = this.getSeasonsNeedingSearch(
      requestedSeasons,
      series.seasons
    );

    if (seasonsToSearch.length === 0) {
      logger.debug(
        'All requested seasons are complete; skipping Sonarr search.',
        {
          label: 'Sonarr API',
          seriesId: series.id,
          requestedSeasons,
        }
      );
      return;
    }

    if (this.canUseAnimeSeriesSearch(series, seasonsToSearch)) {
      logger.info(
        'Executing anime series search so Sonarr considers season packs first.',
        {
          label: 'Sonarr API',
          seriesId: series.id,
          seasonNumbers: seasonsToSearch,
        }
      );

      try {
        await this.runCommand('SeriesSearch', {
          seriesId: series.id,
        });
      } catch (e) {
        logger.error(
          'Something went wrong while executing Sonarr anime series search.',
          {
            label: 'Sonarr API',
            errorMessage: e.message,
            seriesId: series.id,
            seasonNumbers: seasonsToSearch,
          }
        );
      }
      return;
    }

    logger.info('Executing requested season search commands.', {
      label: 'Sonarr API',
      seriesId: series.id,
      seasonNumbers: seasonsToSearch,
    });

    try {
      for (const seasonNumber of seasonsToSearch) {
        await this.runCommand('SeasonSearch', {
          seriesId: series.id,
          seasonNumber,
        });
      }
    } catch (e) {
      logger.error(
        'Something went wrong while executing Sonarr season search.',
        {
          label: 'Sonarr API',
          errorMessage: e.message,
          seriesId: series.id,
          seasonNumbers: seasonsToSearch,
        }
      );
    }
  }

  private canUseAnimeSeriesSearch(
    series: SonarrSeries,
    requestedIncompleteSeasons: number[]
  ): boolean {
    if (series.seriesType !== 'anime') {
      return false;
    }

    const requestedSeasonNumbers = new Set(requestedIncompleteSeasons);

    // Sonarr's anime SeasonSearch fans out into slow per-episode searches,
    // while SeriesSearch considers season packs immediately. SeriesSearch is
    // safe only when it cannot reach another monitored, incomplete season.
    return series.seasons.every(
      (season) =>
        !season.monitored ||
        this.isSeasonDefinitivelyComplete(season) ||
        requestedSeasonNumbers.has(season.seasonNumber)
    );
  }

  private isSeasonDefinitivelyComplete(season?: SonarrSeason): boolean {
    const statistics = season?.statistics;

    return Boolean(
      statistics &&
      statistics.episodeCount > 0 &&
      statistics.episodeFileCount >= statistics.episodeCount
    );
  }

  private async waitForNewSeriesRefresh(
    series: SonarrSeries,
    requestedSeasons: number[],
    attempts = NEW_SERIES_REFRESH_ATTEMPTS,
    intervalMs = NEW_SERIES_REFRESH_INTERVAL_MS
  ): Promise<SonarrSeries> {
    if (!series.id) {
      return series;
    }

    const seasonsToWaitFor = Array.from(new Set(requestedSeasons)).filter(
      (seasonNumber) => Number.isInteger(seasonNumber) && seasonNumber >= 0
    );

    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const refreshedSeries = await this.getSeriesById(series.id);
        const requestedSeasonsArePopulated = seasonsToWaitFor.every(
          (seasonNumber) => {
            const statistics = refreshedSeries.seasons.find(
              (season) => season.seasonNumber === seasonNumber
            )?.statistics;

            return Boolean(
              statistics &&
              (statistics.episodeCount > 0 || statistics.totalEpisodeCount > 0)
            );
          }
        );

        if (requestedSeasonsArePopulated) {
          logger.debug(
            'New Sonarr series refresh completed before requested search.',
            {
              label: 'Sonarr API',
              seriesId: series.id,
              seasonNumbers: seasonsToWaitFor,
              attempts: attempt + 1,
            }
          );
          return refreshedSeries;
        }
      } catch (e) {
        logger.warn('Failed to inspect new Sonarr series refresh state.', {
          label: 'Sonarr API',
          errorMessage: e.message,
          seriesId: series.id,
          seasonNumbers: seasonsToWaitFor,
          attempt: attempt + 1,
        });
      }

      if (attempt < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
      }
    }

    logger.warn(
      'Timed out waiting for new Sonarr series refresh; searching requested seasons fail-open.',
      {
        label: 'Sonarr API',
        seriesId: series.id,
        seasonNumbers: seasonsToWaitFor,
      }
    );
    await this.sendNewSeriesRefreshTimeoutAlert(series, seasonsToWaitFor);
    return series;
  }

  private async sendNewSeriesRefreshTimeoutAlert(
    series: SonarrSeries,
    seasonNumbers: number[]
  ): Promise<void> {
    const pushoverAgent = new PushoverAgent();

    if (!pushoverAgent.shouldSend()) {
      logger.warn('Sonarr refresh timeout Pushover was not sent.', {
        label: 'Sonarr API',
        reason: 'Pushover agent is not configured or enabled',
        seriesId: series.id,
        seasonNumbers,
      });
      return;
    }

    try {
      const sent = await pushoverAgent.send(Notification.TEST_NOTIFICATION, {
        event: 'Seerr Sonarr search review required',
        subject: series.title,
        message:
          'Sonarr did not populate the requested season within 10 seconds. Seerr attempted the season-scoped search fail-open. Verify the Sonarr command history and that the title enters the download queue.',
        extra: [
          { name: 'Series ID', value: String(series.id) },
          { name: 'Seasons', value: seasonNumbers.join(', ') },
        ],
        notifySystem: true,
        notifyAdmin: false,
      });

      if (!sent) {
        logger.error('Sonarr refresh timeout Pushover failed.', {
          label: 'Sonarr API',
          seriesId: series.id,
          seasonNumbers,
        });
      }
    } catch (e) {
      logger.error('Sonarr refresh timeout Pushover failed.', {
        label: 'Sonarr API',
        errorMessage: e.message,
        seriesId: series.id,
        seasonNumbers,
      });
    }
  }

  private getSeasonsNeedingSearch(
    requestedSeasons: number[],
    seriesSeasons?: SonarrSeason[]
  ): number[] {
    const uniqueSeasonNumbers = Array.from(new Set(requestedSeasons)).filter(
      (seasonNumber) => Number.isInteger(seasonNumber) && seasonNumber >= 0
    );

    if (!seriesSeasons) {
      return uniqueSeasonNumbers;
    }

    return uniqueSeasonNumbers.filter((seasonNumber) => {
      // A positive episode count with at least that many files is the only
      // definitive complete signal. Missing/empty statistics fail open.
      return !this.isSeasonDefinitivelyComplete(
        seriesSeasons.find((season) => season.seasonNumber === seasonNumber)
      );
    });
  }

  public async getEpisodes(seriesId: number): Promise<EpisodeResult[]> {
    try {
      const response = await this.axios.get<EpisodeResult[]>('/episode', {
        params: { seriesId },
      });
      return response.data;
    } catch (e) {
      logger.error('Failed to retrieve episodes', {
        label: 'Sonarr API',
        errorMessage: e.message,
        seriesId,
      });
      throw new Error('Failed to get episodes', { cause: e });
    }
  }

  public async getWantedMissingEpisodes(): Promise<SonarrWantedEpisode[]> {
    try {
      const response = await this.axios.get<
        SonarrWantedEpisode[] | { records?: SonarrWantedEpisode[] }
      >('/wanted/missing', {
        params: {
          page: 1,
          pageSize: 1000,
          sortKey: 'episodes.airDateUtc',
          sortDirection: 'descending',
        },
      });

      return Array.isArray(response.data)
        ? response.data
        : (response.data.records ?? []);
    } catch (e) {
      logger.error('Failed to retrieve Sonarr wanted/missing episodes', {
        label: 'Sonarr API',
        errorMessage: e.message,
      });
      throw new Error('Failed to get Sonarr wanted/missing episodes', {
        cause: e,
      });
    }
  }

  public async monitorEpisodes(episodeIds: number[]): Promise<void> {
    try {
      await this.axios.put('/episode/monitor', {
        episodeIds,
        monitored: true,
      });
    } catch (e) {
      logger.error('Failed to monitor episodes', {
        label: 'Sonarr API',
        errorMessage: e.message,
        episodeIds,
      });
      throw new Error('Failed to monitor episodes', { cause: e });
    }
  }

  private buildSeasonList(
    seasons: number[],
    existingSeasons?: SonarrSeason[]
  ): SonarrSeason[] {
    if (existingSeasons) {
      const newSeasons = existingSeasons.map((season) => {
        if (seasons.includes(season.seasonNumber)) {
          season.monitored = true;
        }
        return season;
      });

      return newSeasons;
    }

    const newSeasons = seasons.map(
      (seasonNumber): SonarrSeason => ({
        seasonNumber,
        monitored: true,
      })
    );

    return newSeasons;
  }
  public removeSeries = async (tvdbId: number): Promise<void> => {
    const { id, title } = await this.getSeriesByTvdbId(tvdbId);

    if (!id) {
      logger.info(`[Sonarr] Series not in library, nothing to remove`, {
        tvdbId,
      });
      return;
    }

    try {
      await this.axios.delete(`/series/${id}`, {
        params: {
          deleteFiles: true,
          addImportExclusion: false,
        },
      });
      logger.info(`[Sonarr] Removed series ${title}`);
    } catch (e) {
      if (e?.response?.status === 404) {
        logger.info(`[Sonarr] Series already removed from Sonarr`, {
          tvdbId,
        });
        return;
      }
      throw e;
    }
  };

  public clearCache = ({
    tvdbId,
    externalId,
    title,
  }: {
    tvdbId?: number | null;
    externalId?: number | null;
    title?: string | null;
  }) => {
    if (tvdbId) {
      this.removeCache('/series/lookup', {
        term: `tvdb:${tvdbId}`,
      });
    }
    if (externalId) {
      this.removeCache(`/series/${externalId}`);
    }
    if (title) {
      this.removeCache('/series/lookup', {
        term: title,
      });
    }
  };
}

export default SonarrAPI;
