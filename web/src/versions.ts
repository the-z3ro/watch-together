/** Ordering rule for room snapshots, kept pure so it can be tested. */
export type SnapshotVerdict = 'new-epoch' | 'newer' | 'stale';

/**
 * - different epoch  → the room was re-created (server restart): start over from this snapshot
 * - higher rev       → a real update (or a missed one we are catching up on)
 * - same/lower rev   → heartbeat, duplicate, or delayed message: ignore, it must never roll state back
 */
export function judgeSnapshot(cur: { epoch: string; rev: number }, snap: { epoch: string; rev: number }): SnapshotVerdict {
  if (snap.epoch !== cur.epoch) return 'new-epoch';
  return snap.rev > cur.rev ? 'newer' : 'stale';
}
