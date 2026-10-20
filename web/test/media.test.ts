import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_SYNC, expectedPosition, initialCorr, planTick, type CorrState } from '../src/engine.js';
import { YT_SYNC, youtubeAdapter } from '../src/media.js';
import type { PlaybackState } from '../src/protocol.js';
import { YT_STATE, type YtPlayerLike } from '../src/youtube.js';

/** A fake IFrame player whose behaviour we control. */
function fakePlayer(init: Partial<{ state: number; time: number; videoId: string; rates: number[]; duration: number }> = {}) {
  const s = { state: init.state ?? YT_STATE.PAUSED, time: init.time ?? 0, id: init.videoId ?? 'AAAAAAAAAAA', rate: 1, calls: [] as string[], vol: 100, muted: false };
  const p: YtPlayerLike = {
    playVideo: () => s.calls.push('play'),
    pauseVideo: () => ((s.state = YT_STATE.PAUSED), s.calls.push('pause')),
    seekTo: (t) => ((s.time = t), s.calls.push('seek:' + t)),
    getCurrentTime: () => s.time,
    getDuration: () => init.duration ?? 212,
    getPlayerState: () => s.state,
    getPlaybackRate: () => s.rate,
    setPlaybackRate: (r) => ((s.rate = r), s.calls.push('rate:' + r)),
    getAvailablePlaybackRates: () => init.rates ?? [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2],
    getVideoLoadedFraction: () => 0.4,
    getVideoData: () => ({ video_id: s.id, title: 't' }),
    setVolume: (v) => (s.vol = v),
    mute: () => (s.muted = true),
    unMute: () => (s.muted = false),
    destroy: () => {},
  };
  return { s, p };
}

describe('YouTube adapter', () => {
  it('reports state, time and snaps rates to what YouTube offers', () => {
    const { s, p } = fakePlayer({ state: YT_STATE.PLAYING, time: 12.5 });
    const a = youtubeAdapter(p, { videoId: 'AAAAAAAAAAA' });
    assert.equal(a.running(), true);
    assert.equal(a.playable(), true);
    assert.equal(a.time(), 12.5);
    assert.equal(a.duration(), 212);
    assert.equal(a.snapRate(1.07), 1);
    assert.equal(a.snapRate(1.4), 1.5);
    assert.equal(a.snapRate(9), 2);
    a.setRate(1.3);
    assert.equal(s.rate, 1.25);
    a.setVolume(0.5, true);
    assert.deepEqual([s.vol, s.muted], [50, true]);
    assert.equal(a.canNudge, false);
  });

  it('treats a different video id as an ad: held, not playable, not corrected', () => {
    const { s, p } = fakePlayer({ state: YT_STATE.PLAYING });
    const a = youtubeAdapter(p, { videoId: 'AAAAAAAAAAA' });
    s.id = 'ADADADADADA';
    assert.equal(a.ad(), true);
    assert.equal(a.playable(), false);
    s.id = 'AAAAAAAAAAA';
    assert.equal(a.ad(), false);
    assert.equal(a.playable(), true);
  });

  it('seeking() is true only while buffering right after our own seek', () => {
    let t = 0;
    const { s, p } = fakePlayer({ state: YT_STATE.PLAYING });
    const a = youtubeAdapter(p, { videoId: 'AAAAAAAAAAA', now: () => t });
    assert.equal(a.seeking(), false);
    a.seek(40);
    s.state = YT_STATE.BUFFERING;
    assert.equal(a.seeking(), true);
    t = 6000;
    assert.equal(a.seeking(), false, 'a stuck buffer is not "seeking" forever');
    s.state = YT_STATE.PLAYING;
    assert.equal(a.seeking(), false);
  });

  it('play() resolves once playing, rejects as NotAllowedError when autoplay is refused, and de-duplicates calls', async () => {
    let t = 0;
    const timers: (() => void)[] = [];
    const { s, p } = fakePlayer({ state: YT_STATE.CUED });
    const a = youtubeAdapter(p, { videoId: 'AAAAAAAAAAA', now: () => t, setTimer: (fn) => timers.push(fn) });
    const first = a.play();
    const second = a.play();
    assert.equal(first, second, 'concurrent calls share one attempt');
    assert.equal(s.calls.filter((c) => c === 'play').length, 1);
    t = 5000; // never started
    timers.shift()!();
    await assert.rejects(first, (e: Error) => e.name === 'NotAllowedError');
    // later, it does start
    s.state = YT_STATE.CUED;
    const third = a.play();
    s.state = YT_STATE.PLAYING;
    t = 5100;
    timers.shift()!();
    await third;
  });

  it('play() when the player is already playing synchronously does not leave a stale pending attempt (regression)', async () => {
    const { s, p } = fakePlayer({ state: YT_STATE.PLAYING });
    const a = youtubeAdapter(p, { videoId: 'AAAAAAAAAAA', now: () => 0, setTimer: () => {} });
    await a.play();
    s.state = YT_STATE.PAUSED;
    void a.play().catch(() => {}); // must call the player again, not return the old resolved promise
    assert.equal(s.calls.filter((c) => c === 'play').length, 2);
  });

  it('survives a player that throws (not ready yet)', () => {
    const p = new Proxy({} as YtPlayerLike, { get: () => () => { throw new Error('not ready'); } });
    const a = youtubeAdapter(p, { videoId: 'AAAAAAAAAAA' });
    assert.equal(a.time(), 0);
    assert.equal(a.duration(), 0);
    assert.equal(a.running(), false);
    assert.equal(a.ad(), false);
    assert.equal(a.buffered(), 0);
    assert.doesNotThrow(() => a.setVolume(1, false));
  });
});

// Simulate the real loop with YouTube behaviour: no speed nudging, seek-only, coarse precision.
const pb = (o: Partial<PlaybackState> = {}): PlaybackState => ({ v: 1, playing: true, position: 0, at: 0, rate: 1, hardSeq: 0, by: null, ...o });

describe('sync policy for YouTube (seek-only)', () => {
  function simulate(startDrift: number, seekError = 0, seconds = 40) {
    const base = pb();
    let st: CorrState = initialCorr();
    let actual = -startDrift; // we are behind by startDrift
    let now = 0;
    let seeks = 0;
    let rateChanges = 0;
    let lastRate = 1;
    for (let i = 0; i < seconds * 2; i++) {
      now += 500;
      actual += 0.5; // real time passes at speed 1, then we decide
      const exp = expectedPosition(base, now);
      const plan = planTick({ drift: exp - actual, baseRate: 1, state: st, now, playable: true, cfg: YT_SYNC });
      st = plan.state;
      if (plan.action === 'seek') {
        actual = exp + seekError;
        seeks++;
      }
      if (plan.rate !== lastRate) ((rateChanges++), (lastRate = plan.rate));
    }
    const drift = expectedPosition(base, now) - actual;
    return { drift, seeks, rateChanges };
  }

  it('never touches the playback speed, whatever the drift', () => {
    for (const d of [0.1, 0.4, 0.7, 1.5, 6, -0.9, -4]) assert.equal(simulate(d).rateChanges, 0, `drift ${d}`);
  });
  it('leaves drift under the threshold alone (no seek spam)', () => {
    for (const d of [0.1, 0.3, 0.6, -0.5]) assert.equal(simulate(d).seeks, 0, `drift ${d}`);
  });
  it('fixes big drift with one seek and stays quiet afterwards', () => {
    for (const d of [1.2, 5, -2, -8]) {
      const r = simulate(d, 0.1);
      assert.equal(r.seeks, 1, `drift ${d}`);
      assert.ok(Math.abs(r.drift) < 0.5, `ends within 0.5s (${r.drift})`);
    }
  });
  it('does not seek forever when YouTube seeks imprecisely: bounded by cooldown and back-off', () => {
    const r = simulate(3, 2.5, 120); // every seek lands 2.5 s off
    assert.ok(r.seeks <= 24, `seeks=${r.seeks}`);
  });
  it('file playback keeps its smooth correction (policy untouched)', () => {
    assert.ok(DEFAULT_SYNC.maxRateDelta > 0 && YT_SYNC.maxRateDelta === 0);
  });
});
