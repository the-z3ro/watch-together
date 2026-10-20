import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { DEFAULT_GESTURES, GestureTracker, clampZoom, scrubSpan, seekFromDrag, volumeFromDrag, zoneOf, type GestureEvent, type Timers } from '../src/gestures.js';

/** Deterministic clock + timers. */
function rig() {
  let now = 10_000;
  const timers: { at: number; fn: () => void; id: number }[] = [];
  let nextId = 1;
  const fake: Timers = {
    set: (fn, ms) => {
      const id = nextId++;
      timers.push({ at: now + ms, fn, id });
      return id;
    },
    clear: (h) => {
      const i = timers.findIndex((t) => t.id === h);
      if (i >= 0) timers.splice(i, 1);
    },
  };
  const events: GestureEvent[] = [];
  const g = new GestureTracker((e) => events.push(e), () => ({ w: 400, h: 225 }), DEFAULT_GESTURES, () => now, fake);
  const advance = (ms: number) => {
    const end = now + ms;
    for (;;) {
      const next = timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      timers.splice(timers.indexOf(next), 1);
      now = next.at;
      next.fn();
    }
    now = end;
  };
  const tap = (x: number, y = 100, id = 1) => {
    g.down(id, x, y);
    advance(40);
    g.up(id, x, y);
  };
  return { g, events, advance, tap };
}

describe('taps', () => {
  let r: ReturnType<typeof rig>;
  beforeEach(() => (r = rig()));

  it('a single tap fires once, after the double-tap window', () => {
    r.tap(200);
    assert.deepEqual(r.events, []);
    r.advance(350);
    assert.deepEqual(r.events, [{ type: 'tap' }]);
  });

  it('double-tap right / left / centre', () => {
    r.tap(340);
    r.advance(120);
    r.tap(340);
    r.advance(1000);
    assert.deepEqual(r.events, [{ type: 'doubletap', zone: 'right', count: 1 }]);
    r.events.length = 0;
    r.tap(60);
    r.advance(100);
    r.tap(62);
    r.advance(1000);
    assert.deepEqual(r.events, [{ type: 'doubletap', zone: 'left', count: 1 }]);
    r.events.length = 0;
    r.tap(200);
    r.advance(100);
    r.tap(200);
    r.advance(1000);
    assert.deepEqual(r.events, [{ type: 'doubletap', zone: 'center', count: 1 }]);
  });

  it('keeps adding steps while tapping the same side, then stops', () => {
    r.tap(340);
    r.advance(100);
    r.tap(340);
    r.advance(200);
    r.tap(340);
    r.advance(200);
    r.tap(340);
    assert.deepEqual(r.events.map((e) => (e.type === 'doubletap' ? e.count : e.type)), [1, 2, 3]);
    r.advance(1500); // window over
    r.events.length = 0;
    r.tap(340);
    r.advance(400);
    assert.deepEqual(r.events, [{ type: 'tap' }], 'a lone tap later is a plain tap');
  });

  it('taps on different sides are not a double-tap', () => {
    r.tap(60);
    r.advance(100);
    r.tap(340);
    r.advance(1000);
    assert.deepEqual(r.events.map((e) => e.type), ['tap', 'tap']);
  });

  it('two slow taps are two plain taps', () => {
    r.tap(200);
    r.advance(500);
    r.tap(200);
    r.advance(500);
    assert.deepEqual(r.events.map((e) => e.type), ['tap', 'tap']);
  });

  it('centre taps never enter multi-seek mode', () => {
    r.tap(200);
    r.advance(100);
    r.tap(200);
    r.advance(100);
    r.tap(200);
    r.advance(1000);
    assert.deepEqual(r.events.map((e) => e.type), ['doubletap', 'tap']);
  });
});

describe('drags', () => {
  it('vertical drag on the right half is volume; frac is positive upwards', () => {
    const r = rig();
    r.g.down(1, 350, 150);
    r.g.move(1, 350, 140);
    r.g.move(1, 351, 90);
    r.g.up(1, 351, 90);
    const types = r.events.map((e) => e.type);
    assert.deepEqual(types, ['vol-start', 'vol', 'vol-end']);
    const last = r.events.filter((e) => e.type === 'vol').at(-1) as { frac: number };
    assert.ok(last.frac > 0.3 && last.frac < 0.4, String(last.frac)); // 60px of 180 = 0.33
    r.advance(1000);
    assert.equal(r.events.filter((e) => e.type === 'tap').length, 0, 'a drag is never also a tap');
  });

  it('vertical drag on the left half does nothing (no brightness gesture)', () => {
    const r = rig();
    r.g.down(1, 100, 150);
    r.g.move(1, 100, 60);
    r.g.up(1, 100, 60);
    r.advance(1000);
    assert.deepEqual(r.events, []);
  });

  it('horizontal drag scrubs and reports totals; ends cleanly', () => {
    const r = rig();
    r.g.down(1, 100, 100);
    r.g.move(1, 130, 102);
    r.g.move(1, 220, 104);
    r.g.up(1, 220, 104);
    assert.deepEqual(r.events.map((e) => e.type), ['scrub-start', 'scrub', 'scrub', 'scrub-end']);
    assert.equal((r.events[2] as { dx: number }).dx, 120);
    assert.equal((r.events[3] as { cancelled: boolean }).cancelled, false);
  });

  it('a tiny wobble inside the slop is still a tap', () => {
    const r = rig();
    r.g.down(1, 200, 100);
    r.g.move(1, 204, 103);
    r.g.up(1, 204, 103);
    r.advance(400);
    assert.deepEqual(r.events, [{ type: 'tap' }]);
  });

  it('cancel() ends an active drag without committing and leaves no stuck state', () => {
    const r = rig();
    r.g.down(1, 100, 100);
    r.g.move(1, 200, 100);
    r.g.cancel();
    assert.deepEqual(r.events.map((e) => e.type), ['scrub-start', 'scrub', 'scrub-end']);
    assert.equal((r.events.at(-1) as { cancelled: boolean }).cancelled, true);
    r.events.length = 0;
    r.tap(200);
    r.advance(400);
    assert.deepEqual(r.events, [{ type: 'tap' }], 'works normally afterwards');
  });
});

describe('edges and multi-touch', () => {
  it('ignores touches that start at the screen edge (OS back swipe)', () => {
    const r = rig();
    r.g.down(1, 4, 100);
    r.g.move(1, 150, 100);
    r.g.up(1, 150, 100);
    r.g.down(1, 398, 100);
    r.g.up(1, 398, 100);
    r.advance(1000);
    assert.deepEqual(r.events, []);
  });

  it('pinch reports scale and ends once; the leftover finger does nothing', () => {
    const r = rig();
    r.g.down(1, 150, 100);
    r.g.down(2, 250, 100);
    r.g.move(2, 350, 100);
    r.g.up(2, 350, 100);
    r.g.up(1, 150, 100);
    r.advance(1000);
    assert.deepEqual(r.events.map((e) => e.type), ['pinch', 'pinch-end']);
    assert.equal((r.events[0] as { scale: number }).scale, 2);
  });

  it('a second finger cancels a drag in progress', () => {
    const r = rig();
    r.g.down(1, 100, 100);
    r.g.move(1, 200, 100);
    r.g.down(2, 300, 100);
    assert.equal((r.events.at(-1) as { type: string; cancelled?: boolean }).type, 'scrub-end');
    assert.equal((r.events.at(-1) as { cancelled: boolean }).cancelled, true);
  });

  it('events for unknown pointers are ignored', () => {
    const r = rig();
    r.g.move(9, 1, 1);
    r.g.up(9, 1, 1);
    assert.deepEqual(r.events, []);
  });
});

describe('mappers', () => {
  it('zones', () => {
    assert.deepEqual([0, 100, 160, 200, 241, 399].map((x) => zoneOf(x, 400)), ['left', 'left', 'center', 'center', 'right', 'right']);
  });
  it('volume clamps', () => {
    assert.equal(volumeFromDrag(0.5, 0.25), 0.75);
    assert.equal(volumeFromDrag(0.9, 0.5), 1);
    assert.equal(volumeFromDrag(0.1, -0.5), 0);
  });
  it('scrub: long films scrub faster, results stay inside the media', () => {
    assert.equal(scrubSpan(30), 60);
    assert.equal(scrubSpan(5400), 300);
    assert.equal(seekFromDrag(100, 200, 400, 5400), 250);
    assert.equal(seekFromDrag(10, -400, 400, 5400), 0);
    assert.equal(seekFromDrag(5300, 400, 400, 5400), 5399.5);
    assert.equal(seekFromDrag(0, 100, 0, 100), 99.5); // zero width is guarded (no NaN) and clamped inside the media
  });
  it('zoom clamps and snaps to fit', () => {
    assert.equal(clampZoom(1.05), 1);
    assert.equal(clampZoom(2), 2);
    assert.equal(clampZoom(9), 3);
    assert.equal(clampZoom(0.4), 1);
  });
});
