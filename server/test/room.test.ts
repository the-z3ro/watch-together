import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Command, CommandBody } from '../src/protocol.js';
import { Room } from '../src/room.js';

let n = 0;
const c = (b: CommandBody): Command => ({ id: `c${++n}`, ...b }) as Command;
const T0 = 1_000_000;

/** owner O, controller C, participant P, all online. */
function setup() {
  const room = new Room('ABCDEF', T0, 600);
  room.join('O', 'Olive', 's-O', T0);
  room.join('C', 'Cal', 's-C', T0 + 1);
  room.join('P', 'Pat', 's-P', T0 + 2);
  assert.equal(room.apply('O', c({ type: 'role:set', memberId: 'C', role: 'controller' }), T0).result.ok, true);
  return room;
}
const play = (r: Room, who: string, pos = 10, at = T0 + 100) => r.apply(who, c({ type: 'play', position: pos, basePv: r.playback.v }), at);

describe('roles & permissions', () => {
  it('first joiner is owner, others participants', () => {
    const r = new Room('ABCDEF', T0, 600);
    r.join('O', 'o', 's1', T0);
    r.join('P', 'p', 's2', T0);
    assert.equal(r.ownerId, 'O');
    assert.deepEqual(r.snapshot().members.map((m) => m.role), ['owner', 'participant']);
  });

  it('owner, controller can play/pause/seek; participant cannot', () => {
    const r = setup();
    assert.equal(play(r, 'O').result.ok, true);
    assert.equal(r.apply('C', c({ type: 'seek', position: 50 }), T0 + 200).result.ok, true);
    const denied = r.apply('P', c({ type: 'pause', position: 1, basePv: r.playback.v }), T0 + 300).result;
    assert.equal(denied.ok, false);
    assert.equal(!denied.ok && denied.error, 'forbidden');
    assert.equal(r.playback.playing, true, 'participant must not change playback');
  });

  it('only owner can appoint controllers, change settings, transfer ownership, close room', () => {
    const r = setup();
    for (const who of ['C', 'P']) {
      for (const body of [
        { type: 'role:set', memberId: 'P', role: 'controller' },
        { type: 'settings', controllerPower: false },
        { type: 'owner:transfer', memberId: who },
        { type: 'room:close' },
      ] as CommandBody[]) {
        const { result, effects } = r.apply(who, c(body), T0 + 50);
        assert.equal(result.ok, false, `${who} ${body.type}`);
        assert.equal(effects.closed, undefined);
      }
    }
    assert.equal(r.ownerId, 'O');
    assert.equal(r.settings.controllerPower, true);
    assert.equal(r.members.get('P')?.role, 'participant');
  });

  it('Controller Power off: controllers lose control immediately, owner keeps it, roles are retained', () => {
    const r = setup();
    assert.equal(play(r, 'C').result.ok, true);
    assert.equal(r.apply('O', c({ type: 'settings', controllerPower: false }), T0 + 10).result.ok, true);
    assert.equal(r.members.get('C')?.role, 'controller');
    assert.equal(r.snapshot().members.find((m) => m.id === 'C')?.canControl, false);
    assert.equal(r.apply('C', c({ type: 'seek', position: 5 }), T0 + 20).result.ok, false);
    assert.equal(r.apply('C', c({ type: 'captions:clear' }), T0 + 20).result.ok, false);
    assert.equal(r.apply('O', c({ type: 'seek', position: 5 }), T0 + 30).result.ok, true);
    r.apply('O', c({ type: 'settings', controllerPower: true }), T0 + 40);
    assert.equal(r.apply('C', c({ type: 'seek', position: 6 }), T0 + 50).result.ok, true);
  });

  it('revoked controller is rejected right away', () => {
    const r = setup();
    r.apply('O', c({ type: 'role:set', memberId: 'C', role: 'participant' }), T0 + 5);
    assert.equal(r.apply('C', c({ type: 'seek', position: 9 }), T0 + 6).result.ok, false);
  });

  it('ownership transfer demotes the old owner to controller', () => {
    const r = setup();
    assert.equal(r.apply('O', c({ type: 'owner:transfer', memberId: 'P' }), T0 + 5).result.ok, true);
    assert.equal(r.ownerId, 'P');
    assert.equal(r.members.get('O')?.role, 'controller');
    assert.equal(r.apply('O', c({ type: 'role:set', memberId: 'C', role: 'participant' }), T0 + 6).result.ok, false);
  });

  it('owner cannot be demoted by role:set, nor target self', () => {
    const r = setup();
    assert.equal(r.apply('O', c({ type: 'role:set', memberId: 'O', role: 'participant' }), T0).result.ok, false);
  });
});

describe('versioned playback', () => {
  it('play is scheduled in the future; pv and rev increase', () => {
    const r = setup();
    const rev0 = r.rev;
    const v0 = r.playback.v;
    play(r, 'O', 12, T0 + 1000);
    assert.equal(r.playback.at, T0 + 1600);
    assert.equal(r.playback.v, v0 + 1);
    assert.ok(r.rev > rev0);
  });

  it('stale play/pause (older basePv) cannot restore an old position', () => {
    const r = setup();
    const stalePv = r.playback.v;
    r.apply('O', c({ type: 'seek', position: 500 }), T0 + 10);
    const res = r.apply('C', c({ type: 'pause', position: 3, basePv: stalePv }), T0 + 20).result;
    assert.equal(res.ok, false);
    assert.equal(!res.ok && res.error, 'stale');
    assert.equal(r.playback.position, 500);
    assert.ok(!res.ok && res.snapshot, 'stale rejection carries fresh state');
  });

  it('duplicate command id applies once and returns duplicate', () => {
    const r = setup();
    const cmd = c({ type: 'seek', position: 77 });
    const v = r.playback.v;
    r.apply('O', cmd, T0 + 1);
    const again = r.apply('O', cmd, T0 + 2).result;
    assert.equal(r.playback.v, v + 1);
    assert.equal(again.ok && again.duplicate, true);
  });

  it('rate change keeps the projected position continuous', () => {
    const r = setup();
    r.apply('O', c({ type: 'seek', position: 100 }), T0 + 1); // paused
    r.apply('O', c({ type: 'play', position: 100, basePv: r.playback.v }), T0 + 1000); // starts at T0+1600
    r.apply('O', c({ type: 'rate', rate: 1.5 }), T0 + 11_600); // 10s later
    assert.ok(Math.abs(r.playback.position - 110) < 0.01);
    assert.equal(r.playback.rate, 1.5);
    assert.ok(Math.abs(r.project(T0 + 13_600) - 113) < 0.01);
  });

  it('seek while playing re-schedules for everyone', () => {
    const r = setup();
    play(r, 'O', 0, T0 + 10);
    r.apply('C', c({ type: 'seek', position: 60 }), T0 + 5000);
    assert.equal(r.playback.at, T0 + 5600);
    assert.equal(r.playback.playing, true);
  });
});

describe('hard sync', () => {
  it('owner hardSyncAll bumps hardSeq and uses the owner position as reference', () => {
    const r = setup();
    play(r, 'O', 0, T0);
    const now = T0 + 10_000;
    const res = r.apply('O', c({ type: 'hardSyncAll', position: 9.2, at: now - 40 }), now).result;
    assert.equal(res.ok, true);
    assert.equal(r.playback.hardSeq, 1);
    assert.equal(r.playback.position, 9.2);
    assert.equal(r.playback.at, now - 40);
    assert.equal(r.playback.by, 'O');
  });

  it('timestamp is clamped so a client cannot project into the far future/past', () => {
    const r = setup();
    play(r, 'O', 0, T0);
    const now = T0 + 10_000;
    r.apply('O', c({ type: 'hardSyncAll', position: 9, at: now + 999_999 }), now);
    assert.equal(r.playback.at, now);
    r.apply('O', c({ type: 'hardSyncAll', position: 9, at: now - 999_999 }), now);
    assert.equal(r.playback.at, now - 3000);
  });

  it('controllers cannot sync everyone unless explicitly permitted; participants never can', () => {
    const r = setup();
    const sync = (who: string) => r.apply(who, c({ type: 'hardSyncAll', position: 1, at: T0 }), T0 + 5).result.ok;
    assert.equal(sync('C'), false);
    assert.equal(sync('P'), false);
    r.apply('O', c({ type: 'settings', controllersCanSyncAll: true }), T0 + 6);
    assert.equal(sync('C'), true);
    assert.equal(sync('P'), false);
    r.apply('O', c({ type: 'settings', controllerPower: false }), T0 + 7);
    assert.equal(sync('C'), false, 'power off beats the sync-all permission');
  });

  it('does not cancel a pending scheduled start', () => {
    const r = setup();
    play(r, 'O', 20, T0 + 100); // at = T0+700
    r.apply('O', c({ type: 'hardSyncAll', position: 20, at: T0 + 200 }), T0 + 200);
    assert.equal(r.playback.at, T0 + 700);
    assert.equal(r.playback.position, 20);
    assert.equal(r.playback.hardSeq, 1);
  });
});

describe('captions', () => {
  const cues = [
    { s: 1, e: 2, t: 'Hello' },
    { s: 3, e: 4.5, t: 'World' },
  ];

  it('controller can set; duplicate import is a no-op; replace bumps version; clear works', () => {
    const r = setup();
    const a = r.apply('C', c({ type: 'captions:set', name: 'a.srt', cues }), T0 + 1);
    assert.equal(a.result.ok, true);
    assert.equal(a.effects.captions?.cues.length, 2);
    const rev = r.rev;
    const dup = r.apply('O', c({ type: 'captions:set', name: 'again.srt', cues }), T0 + 2);
    assert.equal(dup.result.ok && dup.result.duplicate, true);
    assert.equal(r.rev, rev, 'duplicate import must not bump rev');
    const v1 = r.captions?.meta.v ?? 0;
    const b = r.apply('O', c({ type: 'captions:set', name: 'b.srt', cues: [{ s: 0, e: 1, t: 'New' }] }), T0 + 3);
    assert.equal(b.result.ok, true);
    assert.ok((r.captions?.meta.v ?? 0) > v1);
    assert.equal(r.snapshot().captions?.name, 'b.srt');
    const gone = r.apply('C', c({ type: 'captions:clear' }), T0 + 4);
    assert.equal(gone.effects.captions, null);
    assert.equal(r.snapshot().captions, null);
  });

  it('participants cannot import or remove captions', () => {
    const r = setup();
    assert.equal(r.apply('P', c({ type: 'captions:set', name: 'x', cues }), T0).result.ok, false);
    r.apply('O', c({ type: 'captions:set', name: 'x', cues }), T0 + 1);
    assert.equal(r.apply('P', c({ type: 'captions:clear' }), T0 + 2).result.ok, false);
    assert.ok(r.captions);
  });

  it('rejects malformed, empty, junk and oversized tracks', () => {
    const r = setup();
    const bad = (cs: unknown) => r.apply('O', c({ type: 'captions:set', name: 'x', cues: cs as never }), T0).result;
    assert.equal(bad([]).ok, false);
    assert.equal(bad([{ s: 5, e: 1, t: 'backwards' }]).ok, false);
    assert.equal(bad([{ s: 1, e: 2, t: 42 }, { x: 1 }, null]).ok, false);
    const big = Array.from({ length: 20_001 }, (_, i) => ({ s: i, e: i + 0.5, t: 'x' }));
    const res = bad(big);
    assert.equal(!res.ok && res.error, 'too_large');
    assert.equal(r.captions, null);
  });

  it('sanitises text and sorts cues', () => {
    const r = setup();
    r.apply('O', c({ type: 'captions:set', name: 'x', cues: [{ s: 5, e: 6, t: 'b\u0000 --> c' }, { s: 1, e: 2, t: ' a ' }] }), T0);
    assert.deepEqual(r.captions?.cues.map((q) => q.t), ['a', 'b →  c'.replace('  ', ' ')].map((s) => s));
  });
});

describe('ownership lifecycle', () => {
  it('promotes a controller before an ordinary participant, old owner returns as controller', () => {
    const r = setup();
    r.disconnect('O', 's-O', T0 + 10);
    const next = r.promoteOwner();
    assert.equal(next?.id, 'C');
    assert.equal(r.members.get('O')?.role, 'controller');
    r.join('O', 'Olive', 's-O2', T0 + 20);
    assert.equal(r.ownerId, 'C');
  });

  it('leaving owner hands over immediately', () => {
    const r = setup();
    r.leave('O', T0 + 5);
    assert.equal(r.ownerId, 'C');
    assert.equal(r.members.has('O'), false);
  });
});

describe('abuse limits', () => {
  it('rate-limits floods but not normal use', () => {
    const r = setup();
    let limited = 0;
    for (let i = 0; i < 200; i++) {
      const res = r.apply('O', c({ type: 'seek', position: i }), T0 + i).result;
      if (!res.ok && res.error === 'rate_limited') limited++;
    }
    assert.ok(limited > 50);
  });
});
