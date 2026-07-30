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

const OPPOSITE_QUALITY_OVERRIDE_USER_IDS = new Set([1, 11]);

export const canBypassOppositeQualityRequestConflict = (
  userId: number | undefined
): boolean =>
  userId !== undefined && OPPOSITE_QUALITY_OVERRIDE_USER_IDS.has(userId);

export type OppositeQualityConflict =
  | 'requested'
  | 'partiallyAvailable'
  | 'available'
  | 'mixed';

export const classifyOppositeQualityConflict = (
  statuses: (MediaStatus | undefined)[]
): OppositeQualityConflict | undefined => {
  const conflicts = new Set<Exclude<OppositeQualityConflict, 'mixed'>>();

  for (const status of statuses) {
    if (status === MediaStatus.PENDING || status === MediaStatus.PROCESSING) {
      conflicts.add('requested');
    } else if (status === MediaStatus.PARTIALLY_AVAILABLE) {
      conflicts.add('partiallyAvailable');
    } else if (status === MediaStatus.AVAILABLE) {
      conflicts.add('available');
    }
  }

  if (conflicts.size > 1) {
    return 'mixed';
  }

  return conflicts.values().next().value;
};
