export enum MediaRequestStatus {
  PENDING = 1,
  APPROVED,
  DECLINED,
  FAILED,
  COMPLETED,
}

export enum MediaType {
  MOVIE = 'movie',
  TV = 'tv',
}

export enum MediaStatus {
  UNKNOWN = 1,
  PENDING,
  PROCESSING,
  PARTIALLY_AVAILABLE,
  AVAILABLE,
  BLOCKLISTED,
  DELETED,
}

export const isOppositeQualityRequestConflict = (
  status: MediaStatus | undefined
): boolean =>
  status === MediaStatus.PENDING ||
  status === MediaStatus.PROCESSING ||
  status === MediaStatus.PARTIALLY_AVAILABLE ||
  status === MediaStatus.AVAILABLE;
