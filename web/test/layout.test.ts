import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CONTROL_PAD, controlWidth, layoutMode, planControls, sizeClass, type CtrlId } from '../src/layout.js';

describe('layoutMode', () => {
  it('classifies real device sizes', () => {
    assert.equal(layoutMode(390, 844), 'stack'); // phone portrait
    assert.equal(layoutMode(360, 640), 'stack');
    assert.equal(layoutMode(844, 390), 'landscape'); // phone landscape
    assert.equal(layoutMode(932, 430), 'landscape');
    assert.equal(layoutMode(667, 375), 'landscape');
    assert.equal(layoutMode(820, 1180), 'stack'); // tablet portrait
    assert.equal(layoutMode(1180, 820), 'wide'); // tablet landscape
    assert.equal(layoutMode(1366, 768), 'wide'); // laptop
    assert.equal(layoutMode(1920, 1080), 'wide');
    assert.equal(layoutMode(900, 700), 'stack'); // narrow desktop window
    assert.equal(layoutMode(1280, 500), 'landscape'); // very short window
  });
  it('is total: never throws, always one of three', () => {
    for (let w = 200; w <= 2600; w += 37) for (let h = 200; h <= 1600; h += 41) assert.ok(['wide', 'stack', 'landscape'].includes(layoutMode(w, h)));
  });
  it('size classes', () => {
    assert.deepEqual([300, 400, 700, 1200].map(sizeClass), ['xs', 'sm', 'md', 'lg']);
  });
});

const ALL: CtrlId[] = ['back', 'play', 'fwd', 'time', 'status', 'rate', 'sync', 'cc', 'mute', 'volume', 'pip', 'settings', 'full'];

describe('planControls never overflows', () => {
  it('for every width, input kind and capability combination', () => {
    const optional = ['cc', 'pip', 'status', 'rate'] as const;
    for (let width = 160; width <= 2200; width += 7) {
      for (const touch of [false, true]) {
        for (const timeChars of [9, 13, 17]) {
         for (const centerCluster of touch ? [false, true] : [false]) {
          for (let mask = 0; mask < 1 << optional.length; mask++) {
            const has: Partial<Record<CtrlId, boolean>> = {};
            optional.forEach((id, i) => (has[id] = !!(mask & (1 << i))));
            const { inline } = planControls({ width, touch, timeChars, has, centerCluster });
            const sum = [...inline].reduce((s, id) => s + controlWidth(id, touch, timeChars), 0);
            for (const m of centerCluster ? (['settings', 'full'] as const) : (['play', 'settings', 'full'] as const)) assert.ok(inline.has(m), `${m} always inline`);
            if (centerCluster) assert.ok(!inline.has('play') && !inline.has('back') && !inline.has('fwd'));
            if (width >= 160) assert.ok(sum + CONTROL_PAD <= width, `w=${width} touch=${touch} sum=${sum}`);
            for (const id of optional) if (has[id] === false) assert.ok(!inline.has(id), `${id} absent`);
            if (inline.has('volume')) assert.ok(!touch && inline.has('mute'));
          }
         }
        }
      }
    }
  });

  it('keeps the important buttons on a small phone and adds more as room grows', () => {
    const phone = planControls({ width: 360, touch: true, timeChars: 13, has: { cc: true, pip: true } }).inline;
    assert.ok(phone.has('sync') && phone.has('mute') && phone.has('settings') && phone.has('full') && phone.has('play'));
    assert.ok(!phone.has('pip') && !phone.has('volume'));
    const laptop = planControls({ width: 1100, touch: false, timeChars: 13, has: { cc: true, pip: true } }).inline;
    for (const id of ALL) assert.ok(laptop.has(id), `${id} on a laptop`);
    let prev = 0;
    for (let w = 160; w <= 1300; w += 10) {
      const n = planControls({ width: w, touch: false, timeChars: 13, has: { cc: true, pip: true } }).inline.size;
      assert.ok(n >= prev, 'monotonic in width');
      prev = n;
    }
  });
});

describe('touch layout on a small phone', () => {
  it('bottom row keeps sync, mute, captions, time, settings and fullscreen at 360px', () => {
    const { inline } = planControls({ width: 360, touch: true, centerCluster: true, timeChars: 13, has: { cc: true } });
    for (const id of ['sync', 'mute', 'cc', 'time', 'settings', 'full'] as const) assert.ok(inline.has(id), id);
  });
});
