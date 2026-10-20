// One interface for "something that plays", so the sync loop in Player.tsx is identical for a local <video> file and a
// YouTube embed. Everything the loop needs is here; nothing about the room, sockets or React.
import { YT_STATE, type YtPlayerLike } from './youtube.js';
import { DEFAULT_SYNC, type SyncConfig } from './engine.js';

export interface MediaAdapter {
  readonly kind: 'file' | 'youtube';
  /** Can playback speed be nudged by a few percent? (HTML video: yes. YouTube only has fixed speeds: no.) */
  readonly canNudge: boolean;
  /** Smallest position error worth correcting while paused. */
  readonly pausedEps: number;
  /** Seconds a seek typically takes before playback is really running again (initial guess). */
  readonly seekGuess: number;
  time(): number;
  /** 0 until known. */
  duration(): number;
  /** Is it running (or trying to)? */
  running(): boolean;
  seeking(): boolean;
  /** Able to make progress right now (enough data, not in an ad)? */
  playable(): boolean;
  /** A third-party ad is on screen: hold, don't correct. */
  ad(): boolean;
  play(): Promise<void>;
  pause(): void;
  seek(t: number): void;
  rate(): number;
  setRate(r: number): void;
  snapRate(r: number): number;
  rates(): number[];
  setVolume(v: number, muted: boolean): void;
  /** 0‥1 of the media already buffered ahead of the playhead's start (for the progress bar). */
  buffered(): number;
}

/** Gentle correction is impossible on YouTube (fixed speeds), so only hard seeks, with a wider tolerance. */
export const YT_SYNC: SyncConfig = {
  ...DEFAULT_SYNC,
  deadband: 0.3,
  engage: 0.75,
  release: 0.75,
  hardSeek: 0.75,
  maxRateDelta: 0,
  seekCooldownMs: 3500,
  backoffMs: 15_000,
  stallMs: 2000,
};

// ------------------------------------------------------------------ local file

export function htmlAdapter(get: () => HTMLVideoElement | null): MediaAdapter {
  const v = () => get();
  return {
    kind: 'file',
    canNudge: true,
    pausedEps: 0.05,
    seekGuess: 0.1,
    time: () => v()?.currentTime ?? 0,
    duration: () => {
      const d = v()?.duration ?? 0;
      return Number.isFinite(d) ? d : 0;
    },
    running: () => !!v() && !v()!.paused,
    seeking: () => !!v()?.seeking,
    playable: () => !!v() && v()!.readyState >= 3 && !v()!.seeking,
    ad: () => false,
    play: async () => {
      await v()?.play();
    },
    pause: () => v()?.pause(),
    seek: (t) => {
      const el = v();
      if (!el) return;
      const max = Number.isFinite(el.duration) ? Math.max(0, el.duration - 0.05) : t;
      el.currentTime = Math.min(Math.max(0, t), max);
    },
    rate: () => v()?.playbackRate ?? 1,
    setRate: (r) => {
      const el = v();
      if (el) el.playbackRate = r;
    },
    snapRate: (r) => r,
    rates: () => [0.5, 0.75, 1, 1.25, 1.5, 2],
    setVolume: (vol, muted) => {
      const el = v();
      if (el) ((el.muted = muted), (el.volume = vol));
    },
    buffered: () => {
      const el = v();
      if (!el || !(el.duration > 0) || !el.buffered.length) return 0;
      const t = el.currentTime;
      for (let i = 0; i < el.buffered.length; i++) if (el.buffered.start(i) <= t + 0.5 && el.buffered.end(i) >= t) return Math.min(1, el.buffered.end(i) / el.duration);
      return 0;
    },
  };
}

// ------------------------------------------------------------------ YouTube

export interface YtAdapterOptions {
  videoId: string;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
}

export function youtubeAdapter(player: YtPlayerLike, o: YtAdapterOptions): MediaAdapter {
  const now = o.now ?? (() => performance.now());
  const later = o.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  let seekAt = -Infinity;
  let pending: Promise<void> | null = null;
  let ratesCache: number[] | null = null;

  const state = (): number => {
    try {
      return player.getPlayerState();
    } catch {
      return YT_STATE.UNSTARTED;
    }
  };
  const available = (): number[] => {
    if (ratesCache) return ratesCache;
    try {
      const r = player.getAvailablePlaybackRates();
      if (Array.isArray(r) && r.length) return (ratesCache = [...r].sort((a, b) => a - b));
    } catch {
      /* not ready yet */
    }
    return [0.5, 1, 1.5, 2];
  };
  const snap = (r: number): number => available().reduce((best, x) => (Math.abs(x - r) < Math.abs(best - r) ? x : best), 1);
  /** During an ad the player reports the ad's own video id. Heuristic: callers also offer a manual "interact" escape hatch. */
  const adNow = (): boolean => {
    try {
      const id = player.getVideoData?.().video_id;
      return !!id && id !== o.videoId;
    } catch {
      return false;
    }
  };

  return {
    kind: 'youtube',
    canNudge: false,
    pausedEps: 0.4,
    seekGuess: 0.35,
    time: () => {
      try {
        return player.getCurrentTime() || 0;
      } catch {
        return 0;
      }
    },
    duration: () => {
      try {
        const d = player.getDuration();
        return Number.isFinite(d) && d > 0 ? d : 0;
      } catch {
        return 0;
      }
    },
    running: () => {
      const s = state();
      return s === YT_STATE.PLAYING || s === YT_STATE.BUFFERING;
    },
    seeking: () => state() === YT_STATE.BUFFERING && now() - seekAt < 5000,
    playable: () => state() === YT_STATE.PLAYING && !adNow(),
    ad: adNow,
    play: () => {
      if (pending) return pending;
      player.playVideo();
      const t0 = now();
      let settle: { resolve: () => void; reject: (e: Error) => void } = { resolve: () => {}, reject: () => {} };
      const mine = new Promise<void>((resolve, reject) => (settle = { resolve, reject }));
      pending = mine;
      const poll = () => {
        const s = state();
        if (s === YT_STATE.PLAYING || s === YT_STATE.BUFFERING || s === YT_STATE.ENDED) {
          if (pending === mine) pending = null;
          return settle.resolve();
        }
        if (now() - t0 > 4000) {
          if (pending === mine) pending = null;
          // Still not started: the browser refused autoplay (needs a tap).
          return settle.reject(Object.assign(new Error('autoplay blocked'), { name: 'NotAllowedError' }));
        }
        later(poll, 150);
      };
      poll();
      return mine;
    },
    pause: () => player.pauseVideo(),
    seek: (t) => {
      seekAt = now();
      player.seekTo(Math.max(0, t), true);
    },
    rate: () => {
      try {
        return player.getPlaybackRate() || 1;
      } catch {
        return 1;
      }
    },
    setRate: (r) => player.setPlaybackRate(snap(r)),
    snapRate: snap,
    rates: available,
    setVolume: (vol, muted) => {
      try {
        player.setVolume(Math.round(Math.min(1, Math.max(0, vol)) * 100));
        muted ? player.mute() : player.unMute();
      } catch {
        /* not ready yet */
      }
    },
    buffered: () => {
      try {
        return Math.min(1, Math.max(0, player.getVideoLoadedFraction() || 0));
      } catch {
        return 0;
      }
    },
  };
}
