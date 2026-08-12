import logger from '@server/logger';

export interface MediaDeletionAudit {
  actorId: number;
  actorName: string;
  mediaId: number;
  mediaType: 'movie' | 'tv';
  tmdbId: number;
  tvdbId?: number;
  quality: '1080p' | '4K';
  requestId?: number;
  arrServerId?: number;
  arrServerName?: string;
  arrItemId?: number;
  preRemovalFileState: 'fileless' | 'has-files' | 'missing' | 'unknown';
  preRemovalFileCount?: number;
  outcome: string;
  reason?: string;
}

export const logMediaDeletionAudit = (audit: MediaDeletionAudit): void => {
  const level = audit.outcome === 'failed' ? 'error' : 'info';
  logger[level]('Media deletion audit', {
    label: 'Media Deletion Audit',
    event: 'media_deletion',
    ...audit,
  });
};
