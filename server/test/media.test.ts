import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Command, CommandBody } from '../src/protocol.js';
import { Room } from '../src/room.js';
import { parseCommand, parseMedia, parsePatch } from '../src/validate.js';

let n = 0;
const c = (b: CommandBody): Command => ({ id: `m${++n}`, ...b }) as Command;
const T0 = 2_000_000;
const YT = { type: 'media:youtube', videoId: 'dQw4w9WgXcQ', startAt: 0 } as const;

function setup() {
  const room = new Room('ABCDEF', T0, 600);
  room.join('O', 'Olive', 's-O', T0);
  room.join('C', 'Cal', 's-C', T0 + 1);
  room.join('P', 'Pat', 's-P', T0 + 2);
  room.apply('O', c({ type: 'role:set', memberId: 'C', role: 'controller' }), T0);
  return room;
}
const view = (r: Room, id: string) => r.snapshot().members.find((m) => m.id === id)!;

describe('YouTube load permission', () => {
  it('owner can load; controllers and participants cannot by default', () => {
    const r = setup();
    for (const who of ['C', 'P']) {
      const res = r.apply(who, c({ ...YT }), T0 + 10).result;
      assert.equal(res.ok, false, who);
      assert.equal(!res.ok && res.error, 'forbidden');
    }
    assert.equal(r.media.kind, 'file');
    assert.equal(r.apply('O', c({ ...YT }), T0 + 20).result.ok, true);
    assert.deepEqual(r.media, { kind: 'youtube', videoId: 'dQw4w9WgXcQ', startAt: 0 });
  });

  it('a controller can still play/pause/seek without the grant', () => {
    const r = setup();
    assert.equal(r.apply('C', c({ type: 'seek', position: 5 }), T0 + 10).result.ok, true);
  });

  it('only the owner can grant; grant works for controllers and plain participants; revoke is immediate', () => {
    const r = setup();
    for (const who of ['C', 'P']) assert.equal(r.apply(who, c({ type: 'member:grant', memberId: 'P', canLoadMedia: true }), T0 + 5).result.ok, false);
    assert.equal(view(r, 'P').canLoadMedia, false);
    assert.equal(r.apply('O', c({ type: 'member:grant', memberId: 'P', canLoadMedia: true }), T0 + 6).result.ok, true);
    assert.equal(view(r, 'P').canLoadMedia, true);
    assert.equal(r.apply('P', c({ ...YT }), T0 + 7).result.ok, true, 'granted participant loads');
    r.apply('O', c({ type: 'member:grant', memberId: 'P', canLoadMedia: false }), T0 + 8);
    const res = r.apply('P', c({ type: 'media:youtube', videoId: 'aaaaaaaaaaa', startAt: 0 }), T0 + 9).result;
    assert.equal(res.ok, false);
    assert.equal((r.media as { videoId: string }).videoId, 'dQw4w9WgXcQ', 'revoked member must not change media');
  });

  it('owner cannot be granted/changed; transfer clears the ex-owner and keeps others', () => {
    const r = setup();
    assert.equal(r.apply('O', c({ type: 'member:grant', memberId: 'O', canLoadMedia: false }), T0 + 5).result.ok, false);
    r.apply('O', c({ type: 'member:grant', memberId: 'C', canLoadMedia: true }), T0 + 6);
    r.apply('O', c({ type: 'owner:transfer', memberId: 'P' }), T0 + 7);
    assert.equal(view(r, 'O').canLoadMedia, false, 'ex-owner is now an ordinary controller');
    assert.equal(view(r, 'P').canLoadMedia, true, 'new owner always can');
    assert.equal(view(r, 'C').canLoadMedia, true);
  });
});

describe('loading media', () => {
  it('resets playback paused at the start offset, bumps versions, clears member issues', () => {
    const r = setup();
    r.apply('O', c({ type: 'play', position: 40, basePv: r.playback.v }), T0 + 10);
    r.update('P', { mediaIssue: 'blocked' });
    const v0 = r.playback.v;
    const mv0 = r.mediaV;
    r.apply('O', c({ type: 'media:youtube', videoId: 'dQw4w9WgXcQ', startAt: 90 }), T0 + 1000);
    assert.equal(r.playback.playing, false);
    assert.equal(r.playback.position, 90);
    assert.equal(r.playback.rate, 1);
    assert.ok(r.playback.v > v0 && r.mediaV > mv0);
    assert.equal(view(r, 'P').mediaIssue, null);
  });

  it('a play command computed before the swap is rejected as stale', () => {
    const r = setup();
    const basePv = r.playback.v;
    r.apply('O', c({ ...YT }), T0 + 10);
    const res = r.apply('C', c({ type: 'play', position: 99, basePv }), T0 + 20).result;
    assert.equal(!res.ok && res.error, 'stale');
    assert.equal(r.playback.position, 0);
  });

  it('same video twice is a no-op; switching back to files works and is permission-checked', () => {
    const r = setup();
    r.apply('O', c({ ...YT }), T0 + 10);
    const mv = r.mediaV;
    const dup = r.apply('O', c({ ...YT }), T0 + 20).result;
    assert.equal(dup.ok && dup.duplicate, true);
    assert.equal(r.mediaV, mv);
    assert.equal(r.apply('P', c({ type: 'media:file' }), T0 + 30).result.ok, false);
    assert.equal(r.apply('O', c({ type: 'media:file' }), T0 + 40).result.ok, true);
    assert.equal(r.media.kind, 'file');
  });

  it('shared captions are cleared when YouTube loads and cannot be set while on YouTube', () => {
    const r = setup();
    const cues = [{ s: 1, e: 2, t: 'hi' }];
    assert.equal(r.apply('O', c({ type: 'captions:set', name: 'a.srt', cues }), T0 + 5).result.ok, true);
    const res = r.apply('O', c({ ...YT }), T0 + 6);
    assert.equal(r.captions, null);
    assert.equal(res.effects.captions, null);
    assert.equal(r.apply('O', c({ type: 'captions:set', name: 'a.srt', cues }), T0 + 7).result.ok, false);
  });

  it('a retried command id is idempotent', () => {
    const r = setup();
    const cmd = c({ ...YT });
    r.apply('O', cmd, T0 + 10);
    const v = r.playback.v;
    r.apply('O', cmd, T0 + 11);
    assert.equal(r.playback.v, v);
  });

  it('Hard Sync everyone still works on YouTube', () => {
    const r = setup();
    r.apply('O', c({ ...YT }), T0 + 10);
    r.apply('O', c({ type: 'play', position: 0, basePv: r.playback.v }), T0 + 20);
    assert.equal(r.apply('O', c({ type: 'hardSyncAll', position: 12, at: T0 + 2000 }), T0 + 2000).result.ok, true);
    assert.equal(r.playback.hardSeq, 1);
  });

  it('restores media after a server restart', () => {
    const r = new Room('ABCDEF', T0, 600, { position: 33, playing: false, rate: 1, media: { kind: 'youtube', videoId: 'dQw4w9WgXcQ', startAt: 0 } });
    assert.equal(r.snapshot().media.kind, 'youtube');
  });
});

describe('validation of untrusted input', () => {
  const bad = ['', 'short', 'toolongvideoid1', 'dQw4w9WgXc!', '../../etc/pa', '<script>aaa', 'dQw4w9WgXcQ ', 'dQw4w9WgXc\n'];
  it('rejects malformed video ids', () => {
    for (const videoId of bad) assert.equal(parseCommand({ id: 'x', type: 'media:youtube', videoId, startAt: 0 }), null, JSON.stringify(videoId));
    assert.equal(parseCommand({ id: 'x', type: 'media:youtube', videoId: 123, startAt: 0 }), null);
    assert.equal(parseCommand({ id: 'x', type: 'media:youtube' }), null);
  });
  it('rejects bad start offsets, accepts and floors good ones', () => {
    for (const startAt of [-1, NaN, Infinity, 90_000, '10', null]) assert.equal(parseCommand({ id: 'x', type: 'media:youtube', videoId: 'dQw4w9WgXcQ', startAt }), null, String(startAt));
    const ok = parseCommand({ id: 'x', type: 'media:youtube', videoId: 'dQw4w9WgXcQ', startAt: 61.9 });
    assert.deepEqual(ok, { id: 'x', type: 'media:youtube', videoId: 'dQw4w9WgXcQ', startAt: 61 });
  });
  it('validates grants, media state and issues', () => {
    assert.equal(parseCommand({ id: 'x', type: 'member:grant', memberId: 'a', canLoadMedia: 'yes' }), null);
    assert.ok(parseCommand({ id: 'x', type: 'member:grant', memberId: 'a', canLoadMedia: true }));
    assert.equal(parseMedia({ kind: 'youtube', videoId: 'bad' }), null);
    assert.deepEqual(parseMedia({ kind: 'file' }), { kind: 'file' });
    assert.equal(parsePatch({ mediaIssue: 'blocked' })?.mediaIssue, 'blocked');
    assert.equal(parsePatch({ mediaIssue: '<img>' })?.mediaIssue, null);
  });
});
