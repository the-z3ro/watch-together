import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { judgeSnapshot } from '../src/versions.js';

describe('snapshot ordering', () => {
  const cur = { epoch: 'a', rev: 10 };
  it('accepts newer revisions (including a jump that means we missed events)', () => {
    assert.equal(judgeSnapshot(cur, { epoch: 'a', rev: 11 }), 'newer');
    assert.equal(judgeSnapshot(cur, { epoch: 'a', rev: 25 }), 'newer');
  });
  it('ignores heartbeats, duplicates and delayed older messages', () => {
    assert.equal(judgeSnapshot(cur, { epoch: 'a', rev: 10 }), 'stale');
    assert.equal(judgeSnapshot(cur, { epoch: 'a', rev: 9 }), 'stale');
    assert.equal(judgeSnapshot(cur, { epoch: 'a', rev: 1 }), 'stale');
  });
  it('a new epoch (server restart) is accepted even though its rev is lower', () => {
    assert.equal(judgeSnapshot(cur, { epoch: 'b', rev: 1 }), 'new-epoch');
  });
  it('replaying an out-of-order sequence never moves backwards', () => {
    let state = { epoch: 'a', rev: 0 };
    const applied: number[] = [];
    for (const rev of [3, 1, 5, 4, 5, 2, 6]) {
      const v = judgeSnapshot(state, { epoch: 'a', rev });
      if (v !== 'stale') {
        state = { epoch: 'a', rev };
        applied.push(rev);
      }
    }
    assert.deepEqual(applied, [3, 5, 6]);
  });
});
