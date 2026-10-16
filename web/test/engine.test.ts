import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_SYNC, compareFiles, expectedPosition, initialCorr, isStalled, planTick, type SyncConfig } from '../src/engine.js';

/** Deterministic pseudo-random noise so the simulation is repeatable. */
function rng(seed = 7) {
  return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 2 - 1;
}

interface SimOpts {
  startDrift: number; // expected − actual at t=0 (+ = viewer behind)
  baseRate?: number;
  seconds?: number;
  noise?: number; // ± measurement noise (s)
  cfg?: SyncConfig;
  /** [from, to) seconds during which the player cannot progress (buffering) */
  stall?: [number, number];
  /** make every hard seek fail (position does not change) */
  seeksFail?: boolean;
}

function simulate(o: SimOpts) {
  const cfg = o.cfg ?? DEFAULT_SYNC;
  const base = o.baseRate ?? 1;
  const dt = cfg.tickMs / 1000;
  const rand = rng();
  let t = 0;
  let expected = 100;
  let actual = expected - o.startDrift;
  let rate = base;
  let state = initialCorr();
  const log = { seekTimes: [] as number[], seeks: 0, maxDelta: 0, signFlips: 0, holds: 0, finalDrift: 0, convergedAt: Infinity, ratesDuringStall: new Set<number>() };
  let prevSign = 0;

  for (let step = 0; step * dt < (o.seconds ?? 90); step++) {
    t = step * dt;
    const stalled = !!o.stall && t >= o.stall[0] && t < o.stall[1];
    // world advances over one tick
    expected += base * dt;
    if (!stalled) actual += rate * dt;
    const measured = expected - actual + (o.noise ?? 0) * rand();
    const plan = planTick({ drift: measured, baseRate: base, state, now: t * 1000, playable: !stalled, cfg });
    state = plan.state;
    if (plan.action === 'seek') {
      log.seeks++;
      log.seekTimes.push(t);
      if (!o.seeksFail) actual = expected;
      rate = base;
    } else {
      rate = plan.rate;
    }
    if (plan.action === 'hold') log.holds++;
    if (stalled) log.ratesDuringStall.add(rate);
    log.maxDelta = Math.max(log.maxDelta, Math.abs(rate / base - 1));
    const sign = Math.sign(rate - base) * (Math.abs(rate - base) > 1e-9 ? 1 : 0);
    if (sign !== 0 && prevSign !== 0 && sign !== prevSign) log.signFlips++;
    if (sign !== 0) prevSign = sign;
    if (Math.abs(expected - actual) < 0.1 && log.convergedAt === Infinity && !stalled) log.convergedAt = t;
  }
  log.finalDrift = expected - actual;
  return { ...log, rate, state };
}

describe('expectedPosition', () => {
  const pb = { playing: true, position: 10, at: 5000, rate: 1.5 };
  it('accounts for elapsed time and rate', () => assert.equal(expectedPosition(pb, 7000), 13));
  it('does not run before a scheduled start', () => assert.equal(expectedPosition(pb, 4000), 10));
  it('is fixed while paused', () => assert.equal(expectedPosition({ ...pb, playing: false }, 9000), 10));
});

describe('two-sided gentle speed correction', () => {
  for (const startDrift of [0.3, -0.3, 0.8, -0.8]) {
    it(`converges from ${startDrift > 0 ? 'behind' : 'ahead'} by ${Math.abs(startDrift)}s without seeking, within the speed bounds`, () => {
      const r = simulate({ startDrift, noise: 0.015 });
      assert.equal(r.seeks, 0, 'no seeking for small drift');
      assert.ok(Math.abs(r.finalDrift) < 0.08, `final drift ${r.finalDrift}`);
      assert.ok(r.convergedAt < 30, `converged at ${r.convergedAt}s`);
      assert.ok(r.maxDelta <= DEFAULT_SYNC.maxRateDelta + 1e-9, `max speed change ${r.maxDelta}`);
      assert.ok(r.signFlips <= 1, `no oscillation, saw ${r.signFlips} direction flips`);
      assert.equal(r.rate, 1, 'back to the intended speed');
    });
  }

  it('behind => faster, ahead => slower', () => {
    const behind = planTick({ drift: 0.5, baseRate: 1, state: initialCorr(), now: 0, playable: true });
    const ahead = planTick({ drift: -0.5, baseRate: 1, state: initialCorr(), now: 0, playable: true });
    assert.ok(behind.rate > 1 && ahead.rate < 1);
  });

  it('ignores negligible drift entirely', () => {
    for (const d of [0.03, -0.04, 0.1, -0.1]) {
      const p = planTick({ drift: d, baseRate: 1, state: initialCorr(), now: 0, playable: true });
      assert.equal(p.action, 'none', 'drift ' + d);
      assert.equal(p.rate, 1);
    }
  });

  it('speed changes are smooth: never more than one slew step per tick', () => {
    let state = initialCorr();
    let prev = 1;
    for (let i = 0; i < 30; i++) {
      const p = planTick({ drift: 0.9, baseRate: 1, state, now: i * 500, playable: true });
      assert.ok(Math.abs(p.rate - prev) <= DEFAULT_SYNC.slew + 1e-9);
      prev = p.rate;
      state = p.state;
    }
    assert.ok(Math.abs(prev - 1.05) < 1e-9, 'saturates at +5%');
  });

  it('works around a non-1 intended speed and does not alter it', () => {
    const r = simulate({ startDrift: 0.6, baseRate: 1.25 });
    assert.equal(r.rate, 1.25);
    assert.ok(Math.abs(r.finalDrift) < 0.08);
    assert.ok(r.maxDelta <= DEFAULT_SYNC.maxRateDelta + 1e-9);
  });

  it('stays quiet for a viewer that is already in sync (noise only)', () => {
    const r = simulate({ startDrift: 0, noise: 0.03, seconds: 120 });
    assert.equal(r.seeks, 0);
    assert.equal(r.maxDelta, 0);
  });
});

describe('hard seek', () => {
  it('large drift => exactly one seek, then in sync', () => {
    for (const d of [3, -5, 40]) {
      const r = simulate({ startDrift: d, noise: 0.01 });
      assert.equal(r.seeks, 1, 'drift ' + d);
      assert.ok(Math.abs(r.finalDrift) < 0.08);
    }
  });

  it('forced Hard Sync seeks even for tiny drift and ignores cooldown/backoff', () => {
    const state = { ...initialCorr(), lastSeekAt: 0, backoffUntil: 1e9 };
    const p = planTick({ drift: 0.2, baseRate: 1, state, now: 10, playable: true, force: true });
    assert.equal(p.action, 'seek');
    assert.equal(p.state.backoffUntil, 0);
  });

  it('does not seek repeatedly: respects the cooldown', () => {
    let state = initialCorr();
    let seeks = 0;
    for (let i = 0; i < 6; i++) {
      const p = planTick({ drift: 5, baseRate: 1, state, now: i * 500, playable: true });
      state = p.state;
      if (p.action === 'seek') seeks++;
    }
    assert.equal(seeks, 1, 'only one seek inside the 3s cooldown');
  });

  it('seeks that never help trigger backoff instead of an endless seek loop', () => {
    const r = simulate({ startDrift: 10, seeksFail: true, seconds: 600 });
    const early = r.seekTimes.filter((t) => t < 200).length;
    const late = r.seekTimes.filter((t) => t >= 400).length;
    assert.ok(r.seeks <= 20, `seeks over 10 minutes: ${r.seeks}`);
    assert.ok(late < early, `seek attempts taper off (early ${early}, late ${late})`);
    assert.ok(r.maxDelta <= DEFAULT_SYNC.maxRateDelta + 1e-9, 'meanwhile only gentle speed changes');
  });
});

describe('buffering / unplayable', () => {
  it('holds (no speed change, no seeks) while the player cannot progress, then recovers with one seek', () => {
    const r = simulate({ startDrift: 0.2, stall: [10, 25], seconds: 60 });
    assert.deepEqual([...r.ratesDuringStall], [1], 'rate stays at the intended speed while stalled');
    assert.ok(r.holds > 20);
    assert.equal(r.seeks, 1, 'one seek after the stall ends');
    assert.ok(Math.abs(r.finalDrift) < 0.08);
  });

  it('isStalled detects a player that is not progressing', () => {
    assert.equal(isStalled({ t: 10, wall: 0 }, { t: 10.02, wall: 2000 }, 1), true);
    assert.equal(isStalled({ t: 10, wall: 0 }, { t: 12, wall: 2000 }, 1), false);
    assert.equal(isStalled({ t: 10, wall: 0 }, { t: 10, wall: 500 }, 1), false, 'window too short to judge');
  });
});

describe('configurable', () => {
  it('a gentler config changes the bounds', () => {
    const cfg = { ...DEFAULT_SYNC, maxRateDelta: 0.02 };
    const r = simulate({ startDrift: 0.8, cfg, seconds: 120 });
    assert.ok(r.maxDelta <= 0.02 + 1e-9);
    assert.ok(Math.abs(r.finalDrift) < 0.1);
  });
});

describe('compareFiles', () => {
  const f = (size: number, duration: number) => ({ name: 'x', size, duration });
  it('uses size and duration, never the name', () => {
    assert.equal(compareFiles(f(100, 60), { ...f(100, 60.4), name: 'other.mp4' }), 'match');
    assert.equal(compareFiles(f(100, 60), f(90, 60.2)), 'maybe');
    assert.equal(compareFiles(f(100, 60), f(100, 75)), 'mismatch');
    assert.equal(compareFiles(f(100, 60), null), 'waiting');
    assert.equal(compareFiles(f(100, 0), f(100, 0)), 'waiting');
  });
});
