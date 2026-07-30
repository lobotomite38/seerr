import {
  classifyOppositeQualityConflict,
  MediaStatus,
} from '@server/constants/media';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('classifyOppositeQualityConflict', () => {
  it('classifies pending and processing statuses as requested', () => {
    assert.equal(
      classifyOppositeQualityConflict([
        MediaStatus.PENDING,
        MediaStatus.PROCESSING,
      ]),
      'requested'
    );
  });

  it('classifies partially available statuses', () => {
    assert.equal(
      classifyOppositeQualityConflict([MediaStatus.PARTIALLY_AVAILABLE]),
      'partiallyAvailable'
    );
  });

  it('classifies available statuses', () => {
    assert.equal(
      classifyOppositeQualityConflict([MediaStatus.AVAILABLE]),
      'available'
    );
  });

  it('classifies different conflicting statuses as mixed', () => {
    assert.equal(
      classifyOppositeQualityConflict([
        MediaStatus.PROCESSING,
        MediaStatus.PARTIALLY_AVAILABLE,
        MediaStatus.AVAILABLE,
      ]),
      'mixed'
    );
  });

  it('ignores non-conflicting statuses', () => {
    assert.equal(
      classifyOppositeQualityConflict([
        undefined,
        MediaStatus.UNKNOWN,
        MediaStatus.BLOCKLISTED,
        MediaStatus.DELETED,
      ]),
      undefined
    );
    assert.equal(
      classifyOppositeQualityConflict([
        MediaStatus.UNKNOWN,
        MediaStatus.AVAILABLE,
      ]),
      'available'
    );
  });
});
