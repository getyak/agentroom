import { describe, expect, it } from 'vitest';
import { acceptPlaySnapshot } from '../../personal/src/play-types';

describe('playroom snapshots', () => {
  it('does not replace a newly selected room with a previous room response', () => {
    const current = { id: 'new-room', version: 2 };
    expect(acceptPlaySnapshot(current, { id: 'old-room', version: 40 })).toBe(current);
    expect(acceptPlaySnapshot(null, { id: 'old-room', version: 40 })).toBeNull();
  });
  it('keeps a committed board update when an older poll arrives late', () => {
    const current = { id: 'room', version: 4, notes: 'new' };
    expect(acceptPlaySnapshot(current, { id: 'room', version: 3, notes: 'old' })).toBe(current);
    expect(acceptPlaySnapshot(current, { id: 'room', version: 5, notes: 'latest' })?.notes).toBe('latest');
  });
});
