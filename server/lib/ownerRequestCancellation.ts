import RadarrAPI, { type RadarrMovie } from '@server/api/servarr/radarr';
import SonarrAPI, { type SonarrSeries } from '@server/api/servarr/sonarr';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import dataSource, { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import type { User } from '@server/entity/User';
import { logMediaDeletionAudit } from '@server/lib/mediaDeletionAudit';
import { getSettings, type DVRSettings } from '@server/lib/settings';
import AsyncLock from '@server/utils/asyncLock';

const cancellationLock = new AsyncLock();
const UNRESOLVED_STATUSES = [
  MediaRequestStatus.PENDING,
  MediaRequestStatus.APPROVED,
  MediaRequestStatus.FAILED,
];

export class OwnerCancellationError extends Error {
  public constructor(
    message: string,
    public readonly status: number
  ) {
    super(message);
  }
}

type CancellationResult = {
  requestId: number;
  arrRemoval: 'removed' | 'missing';
};

const findService = (
  request: MediaRequest
): { settings: DVRSettings; name: string } => {
  const settings = getSettings();
  const servers =
    request.type === MediaType.MOVIE ? settings.radarr : settings.sonarr;
  const server = servers.find(
    (candidate) =>
      candidate.id === request.serverId && candidate.is4k === request.is4k
  );

  if (!server) {
    throw new OwnerCancellationError(
      'The exact Radarr/Sonarr server for this request is unavailable.',
      409
    );
  }

  return { settings: server, name: server.name };
};

const getLinkedServiceId = (request: MediaRequest): number | null | undefined =>
  request.media[request.is4k ? 'serviceId4k' : 'serviceId'];

const getLinkedItemId = (request: MediaRequest): number | null | undefined =>
  request.media[request.is4k ? 'externalServiceId4k' : 'externalServiceId'];

const loadRequest = async (requestId: number): Promise<MediaRequest> => {
  const request = await getRepository(MediaRequest).findOne({
    where: { id: requestId },
  });
  if (!request) {
    throw new OwnerCancellationError('Request not found.', 404);
  }
  return request;
};

const ensureOwnerAndUnresolved = (request: MediaRequest, actor: User): void => {
  if (request.requestedBy.id !== actor.id) {
    throw new OwnerCancellationError(
      'Only the request owner can cancel this request.',
      403
    );
  }
  const mediaStatus = request.media[request.is4k ? 'status4k' : 'status'];
  if (
    !UNRESOLVED_STATUSES.includes(request.status) ||
    mediaStatus === MediaStatus.AVAILABLE ||
    mediaStatus === MediaStatus.PARTIALLY_AVAILABLE
  ) {
    throw new OwnerCancellationError(
      'Only unresolved requests can be safely cancelled.',
      409
    );
  }
};

const ensureNoSharedRequest = async (request: MediaRequest): Promise<void> => {
  const shared = await getRepository(MediaRequest)
    .createQueryBuilder('request')
    .where('request.mediaId = :mediaId', { mediaId: request.media.id })
    .andWhere('request.is4k = :is4k', { is4k: request.is4k })
    .andWhere('request.id != :requestId', { requestId: request.id })
    .andWhere('request.status IN (:...statuses)', {
      statuses: UNRESOLVED_STATUSES,
    })
    .getCount();

  if (shared > 0) {
    throw new OwnerCancellationError(
      'Another request depends on this Radarr/Sonarr item.',
      409
    );
  }
};

const resolveMovie = async (
  radarr: RadarrAPI,
  request: MediaRequest,
  linkedItemId: number | null | undefined
): Promise<RadarrMovie | null> => {
  if (linkedItemId) {
    const movie = await radarr.getMovieIfExists(linkedItemId);
    if (movie && movie.tmdbId !== request.media.tmdbId) {
      throw new OwnerCancellationError(
        'The linked Radarr item does not match this request.',
        409
      );
    }
    return movie;
  }

  const matches = (await radarr.getMovies()).filter(
    (movie) => movie.tmdbId === request.media.tmdbId
  );
  if (matches.length > 1) {
    throw new OwnerCancellationError(
      'Multiple matching Radarr items were found.',
      409
    );
  }
  return matches[0] ?? null;
};

const resolveSeries = async (
  sonarr: SonarrAPI,
  request: MediaRequest,
  linkedItemId: number | null | undefined
): Promise<SonarrSeries | null> => {
  if (!request.media.tvdbId) {
    throw new OwnerCancellationError('This request has no TVDB ID.', 409);
  }
  if (linkedItemId) {
    const series = await sonarr.getSeriesIfExists(linkedItemId);
    if (series && series.tvdbId !== request.media.tvdbId) {
      throw new OwnerCancellationError(
        'The linked Sonarr item does not match this request.',
        409
      );
    }
    return series;
  }

  const matches = (await sonarr.getSeries()).filter(
    (series) => series.tvdbId === request.media.tvdbId
  );
  if (matches.length > 1) {
    throw new OwnerCancellationError(
      'Multiple matching Sonarr items were found.',
      409
    );
  }
  return matches[0] ?? null;
};

const clearSeerrRequest = async (
  request: MediaRequest,
  actor: User,
  linkedServiceId: number | null | undefined,
  linkedItemId: number | null | undefined
): Promise<void> => {
  await dataSource.transaction(async (manager) => {
    const current = await manager.findOne(MediaRequest, {
      where: { id: request.id },
    });
    if (!current) {
      throw new OwnerCancellationError('Request not found.', 404);
    }
    ensureOwnerAndUnresolved(current, actor);
    if (
      getLinkedServiceId(current) !== linkedServiceId ||
      getLinkedItemId(current) !== linkedItemId
    ) {
      throw new OwnerCancellationError(
        'The request linkage changed during cancellation.',
        409
      );
    }

    const media = await manager.findOneOrFail(Media, {
      where: { id: current.media.id },
    });
    if (current.is4k) {
      media.serviceId4k = null;
      media.externalServiceId4k = null;
      media.externalServiceSlug4k = null;
      media.status4k = MediaStatus.UNKNOWN;
    } else {
      media.serviceId = null;
      media.externalServiceId = null;
      media.externalServiceSlug = null;
      media.status = MediaStatus.UNKNOWN;
    }
    if (current.type === MediaType.TV) {
      for (const season of media.seasons) {
        season[current.is4k ? 'status4k' : 'status'] = MediaStatus.UNKNOWN;
      }
    }
    await manager.save(media);
    await manager.remove(current);
  });
};

export const cancelOwnedRequest = async (
  requestId: number,
  actor: User
): Promise<CancellationResult> => {
  let result: CancellationResult | undefined;

  await cancellationLock.dispatch(requestId, async () => {
    const request = await loadRequest(requestId);
    ensureOwnerAndUnresolved(request, actor);
    await ensureNoSharedRequest(request);

    const { settings, name } = findService(request);
    const linkedServiceId = getLinkedServiceId(request);
    const linkedItemId = getLinkedItemId(request);
    if (linkedServiceId != null && linkedServiceId !== settings.id) {
      throw new OwnerCancellationError(
        'The request is linked to a different Radarr/Sonarr server.',
        409
      );
    }

    const audit = {
      actorId: actor.id,
      actorName: actor.displayName,
      mediaId: request.media.id,
      mediaType: request.type,
      tmdbId: request.media.tmdbId,
      tvdbId: request.media.tvdbId,
      quality: request.is4k ? ('4K' as const) : ('1080p' as const),
      requestId: request.id,
      arrServerId: settings.id,
      arrServerName: name,
    };

    let auditItemId = linkedItemId ?? undefined;
    let auditFileState: 'fileless' | 'has-files' | 'missing' | 'unknown' =
      linkedItemId ? 'unknown' : 'missing';
    let auditFileCount: number | undefined;
    try {
      let arrRemoval: 'removed' | 'missing';
      let arrItemId = linkedItemId ?? undefined;
      let preRemovalFileCount: number | undefined;

      if (request.type === MediaType.MOVIE) {
        const radarr = new RadarrAPI({
          apiKey: settings.apiKey,
          url: RadarrAPI.buildUrl(settings, '/api/v3'),
        });
        const movie = await resolveMovie(radarr, request, linkedItemId);
        arrItemId = movie?.id ?? arrItemId;
        auditItemId = arrItemId;
        auditFileState = movie ? 'fileless' : 'missing';
        const queue = await radarr.getQueueForCancellation();
        if (arrItemId && queue.some((item) => item.movieId === arrItemId)) {
          throw new OwnerCancellationError(
            'The Radarr item still has a queued download.',
            409
          );
        }
        if (movie?.hasFile || movie?.movieFile) {
          auditFileState = 'has-files';
          auditFileCount = 1;
          throw new OwnerCancellationError(
            'The Radarr item has an imported file.',
            409
          );
        }
        preRemovalFileCount = movie ? 0 : undefined;
        arrRemoval = movie
          ? await radarr.deleteMovieById(movie.id, {
              deleteFiles: false,
              addImportExclusion: false,
            })
          : 'missing';
      } else {
        const sonarr = new SonarrAPI({
          apiKey: settings.apiKey,
          url: SonarrAPI.buildUrl(settings, '/api/v3'),
        });
        const series = await resolveSeries(sonarr, request, linkedItemId);
        arrItemId = series?.id ?? arrItemId;
        auditItemId = arrItemId;
        auditFileState = series ? 'fileless' : 'missing';
        const queue = await sonarr.getQueueForCancellation();
        if (arrItemId && queue.some((item) => item.seriesId === arrItemId)) {
          throw new OwnerCancellationError(
            'The Sonarr item still has a queued download.',
            409
          );
        }
        if (series?.id) {
          const episodes = await sonarr.getEpisodes(series.id);
          preRemovalFileCount = episodes.filter(
            (episode) => episode.hasFile || episode.episodeFileId > 0
          ).length;
          auditFileCount = preRemovalFileCount;
          if (
            preRemovalFileCount > 0 ||
            (series.statistics?.episodeFileCount ?? 0) > 0
          ) {
            auditFileState = 'has-files';
            throw new OwnerCancellationError(
              'The Sonarr item has imported episode files.',
              409
            );
          }
          const requestedSeasons = new Set(
            request.seasons.map((season) => season.seasonNumber)
          );
          const otherMonitoredSeasons = series.seasons.filter(
            (season) =>
              season.monitored && !requestedSeasons.has(season.seasonNumber)
          );
          if (otherMonitoredSeasons.length > 0) {
            throw new OwnerCancellationError(
              'Sonarr has other monitored seasons for this series.',
              409
            );
          }
        }
        arrRemoval = series?.id
          ? await sonarr.deleteSeriesById(series.id, {
              deleteFiles: false,
              addImportExclusion: false,
            })
          : 'missing';
      }

      await clearSeerrRequest(request, actor, linkedServiceId, linkedItemId);
      logMediaDeletionAudit({
        ...audit,
        arrItemId,
        preRemovalFileState: arrItemId ? 'fileless' : 'missing',
        preRemovalFileCount,
        outcome: 'owner-cancelled',
      });
      result = { requestId, arrRemoval };
    } catch (e) {
      logMediaDeletionAudit({
        ...audit,
        arrItemId: auditItemId,
        preRemovalFileState: auditFileState,
        preRemovalFileCount: auditFileCount,
        outcome: e instanceof OwnerCancellationError ? 'refused' : 'failed',
        reason: e instanceof Error ? e.message : String(e),
      });
      throw e;
    }
  });

  if (!result) {
    throw new Error('Cancellation completed without a result.');
  }
  return result;
};
