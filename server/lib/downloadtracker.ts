import RadarrAPI from '@server/api/servarr/radarr';
import { MediaStatus, MediaType } from '@server/constants/media';
import dataSource from '@server/datasource';
import SonarrAPI from '@server/api/servarr/sonarr';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { uniqWith } from 'lodash';

interface EpisodeNumberResult {
  seasonNumber: number;
  episodeNumber: number;
  absoluteEpisodeNumber: number;
  id: number;
}
export interface DownloadingItem {
  mediaType: MediaType;
  externalId: number;
  size: number;
  sizeLeft: number;
  status: string;
  timeLeft: string;
  estimatedCompletionTime: Date;
  title: string;
  downloadId: string;
  episode?: EpisodeNumberResult;
}

class DownloadTracker {
  private radarrServers: Record<number, DownloadingItem[]> = {};
  private radarrPending: Record<number, Set<number>> = {};
  private sonarrServers: Record<number, DownloadingItem[]> = {};

  public getMovieProgress(
    serverId: number,
    externalServiceId: number
  ): DownloadingItem[] {
    if (!this.radarrServers[serverId]) {
      return [];
    }

    return this.radarrServers[serverId].filter(
      (item) => item.externalId === externalServiceId
    );
  }

  public getSeriesProgress(
    serverId: number,
    externalServiceId: number
  ): DownloadingItem[] {
    if (!this.sonarrServers[serverId]) {
      return [];
    }

    return this.sonarrServers[serverId].filter(
      (item) => item.externalId === externalServiceId
    );
  }

  public isMoviePending(serverId: number, externalServiceId: number): boolean {
    return this.radarrPending[serverId]?.has(externalServiceId) ?? false;
  }

  public async resetDownloadTracker() {
    this.radarrServers = {};
    this.radarrPending = {};
    this.sonarrServers = {};
  }

  public updateDownloads() {
    this.updateRadarrDownloads();
    this.updateSonarrDownloads();
  }

  private async updateRadarrDownloads() {
    const settings = getSettings();

    // Remove duplicate servers
    const filteredServers = uniqWith(settings.radarr, (radarrA, radarrB) => {
      return (
        radarrA.hostname === radarrB.hostname &&
        radarrA.port === radarrB.port &&
        radarrA.baseUrl === radarrB.baseUrl
      );
    });

    // Load downloads from Radarr servers
    Promise.all(
      filteredServers.map(async (server) => {
        if (server.syncEnabled) {
          const radarr = new RadarrAPI({
            apiKey: server.apiKey,
            url: RadarrAPI.buildUrl(server, '/api/v3'),
          });

          const matchingServers = settings.radarr.filter(
            (rs) =>
              rs.hostname === server.hostname &&
              rs.port === server.port &&
              rs.baseUrl === server.baseUrl &&
              rs.id !== server.id
          );
          const relatedServiceIds = [server.id, ...matchingServers.map((ms) => ms.id)];

          try {
            await radarr.refreshMonitoredDownloads();
            const queueItems = await radarr.getQueue();

            this.radarrServers[server.id] = queueItems.map((item) => ({
              externalId: item.movieId,
              estimatedCompletionTime: new Date(item.estimatedCompletionTime),
              mediaType: MediaType.MOVIE,
              size: item.size,
              sizeLeft: item.sizeleft,
              status: item.status,
              timeLeft: item.timeleft,
              title: item.title,
              downloadId: item.downloadId,
            }));

            if (queueItems.length > 0) {
              logger.debug(
                `Found ${queueItems.length} item(s) in progress on Radarr server: ${server.name}`,
                { label: 'Download Tracker' }
              );
            }
          } catch {
            logger.error(
              `Unable to get queue from Radarr server: ${server.name}`,
              {
                label: 'Download Tracker',
              }
            );
          }

          try {
            const processingMovieIds =
              await this.getProcessingRadarrMovieIds(relatedServiceIds);
            const pendingMovieIds = await this.getPendingMovieIds(
              radarr,
              processingMovieIds
            );
            this.radarrPending[server.id] = pendingMovieIds;

            if (pendingMovieIds.size > 0) {
              logger.debug(
                `Found ${pendingMovieIds.size} movie(s) pending import on Radarr server: ${server.name}`,
                { label: 'Download Tracker' }
              );
            }
          } catch {
            logger.error(
              `Unable to get pending movie history from Radarr server: ${server.name}`,
              {
                label: 'Download Tracker',
              }
            );
          }

          // Duplicate this data to matching servers
          if (matchingServers.length > 0) {
            logger.debug(
              `Matching download data to ${matchingServers.length} other Radarr server(s)`,
              { label: 'Download Tracker' }
            );
          }

          matchingServers.forEach((ms) => {
            if (ms.syncEnabled) {
              this.radarrServers[ms.id] = this.radarrServers[server.id];
              this.radarrPending[ms.id] = this.radarrPending[server.id];
            }
          });
        }
      })
    );
  }

  private async getProcessingRadarrMovieIds(
    serviceIds: number[]
  ): Promise<number[]> {
    if (!dataSource.isInitialized || serviceIds.length === 0) {
      return [];
    }

    const standardRows = await dataSource
      .createQueryBuilder()
      .select('media.externalServiceId', 'externalServiceId')
      .from('media', 'media')
      .where('media.mediaType = :mediaType', { mediaType: MediaType.MOVIE })
      .andWhere('media.status = :status', { status: MediaStatus.PROCESSING })
      .andWhere('media.serviceId IN (:...serviceIds)', { serviceIds })
      .andWhere('media.externalServiceId IS NOT NULL')
      .getRawMany<{ externalServiceId: number }>();

    const fourKRows = await dataSource
      .createQueryBuilder()
      .select('media.externalServiceId4k', 'externalServiceId')
      .from('media', 'media')
      .where('media.mediaType = :mediaType', { mediaType: MediaType.MOVIE })
      .andWhere('media.status4k = :status', { status: MediaStatus.PROCESSING })
      .andWhere('media.serviceId4k IN (:...serviceIds)', { serviceIds })
      .andWhere('media.externalServiceId4k IS NOT NULL')
      .getRawMany<{ externalServiceId: number }>();

    return [...standardRows, ...fourKRows]
      .map((row) => Number(row.externalServiceId))
      .filter((id) => Number.isInteger(id))
      .filter((id, index, allIds) => allIds.indexOf(id) === index);
  }

  private async getPendingMovieIds(
    radarr: RadarrAPI,
    movieIds: number[]
  ): Promise<Set<number>> {
    const pendingMovieIds = new Set<number>();

    if (movieIds.length === 0) {
      return pendingMovieIds;
    }

    const historyResults = await Promise.all(
      movieIds.map(async (movieId) => {
        try {
          const history = await radarr.getMovieHistory(movieId);
          return { movieId, history };
        } catch (error) {
          logger.warn(`Unable to retrieve Radarr history for movie ${movieId}`, {
            label: 'Download Tracker',
            errorMessage:
              error instanceof Error ? error.message : 'Unknown error',
          });
          return { movieId, history: [] };
        }
      })
    );

    historyResults.forEach(({ movieId, history }) => {
      const latestEvent = [...history]
        .filter((item) => item?.date)
        .sort(
          (left, right) =>
            new Date(right.date).getTime() - new Date(left.date).getTime()
        )[0];

      if (
        latestEvent &&
        String(latestEvent.eventType ?? '').toLowerCase() === 'grabbed'
      ) {
        pendingMovieIds.add(movieId);
      }
    });

    return pendingMovieIds;
  }

  private async updateSonarrDownloads() {
    const settings = getSettings();

    // Remove duplicate servers
    const filteredServers = uniqWith(settings.sonarr, (sonarrA, sonarrB) => {
      return (
        sonarrA.hostname === sonarrB.hostname &&
        sonarrA.port === sonarrB.port &&
        sonarrA.baseUrl === sonarrB.baseUrl
      );
    });

    // Load downloads from Sonarr servers
    Promise.all(
      filteredServers.map(async (server) => {
        if (server.syncEnabled) {
          const sonarr = new SonarrAPI({
            apiKey: server.apiKey,
            url: SonarrAPI.buildUrl(server, '/api/v3'),
          });

          try {
            await sonarr.refreshMonitoredDownloads();
            const queueItems = await sonarr.getQueue();

            this.sonarrServers[server.id] = queueItems.map((item) => ({
              externalId: item.seriesId,
              estimatedCompletionTime: new Date(item.estimatedCompletionTime),
              mediaType: MediaType.TV,
              size: item.size,
              sizeLeft: item.sizeleft,
              status: item.status,
              timeLeft: item.timeleft,
              title: item.title,
              episode: item.episode,
              downloadId: item.downloadId,
            }));

            if (queueItems.length > 0) {
              logger.debug(
                `Found ${queueItems.length} item(s) in progress on Sonarr server: ${server.name}`,
                { label: 'Download Tracker' }
              );
            }
          } catch {
            logger.error(
              `Unable to get queue from Sonarr server: ${server.name}`,
              {
                label: 'Download Tracker',
              }
            );
          }

          // Duplicate this data to matching servers
          const matchingServers = settings.sonarr.filter(
            (ss) =>
              ss.hostname === server.hostname &&
              ss.port === server.port &&
              ss.baseUrl === server.baseUrl &&
              ss.id !== server.id
          );

          if (matchingServers.length > 0) {
            logger.debug(
              `Matching download data to ${matchingServers.length} other Sonarr server(s)`,
              { label: 'Download Tracker' }
            );
          }

          matchingServers.forEach((ms) => {
            if (ms.syncEnabled) {
              this.sonarrServers[ms.id] = this.sonarrServers[server.id];
            }
          });
        }
      })
    );
  }
}

const downloadTracker = new DownloadTracker();

export default downloadTracker;
