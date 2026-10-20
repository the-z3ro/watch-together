// YouTube helpers: link parsing (pure, unit-tested) and a tiny typed wrapper around the official IFrame Player API.
// Nothing here downloads or proxies video — each browser plays its own embedded copy; only the timeline is shared.
import { YT_ID } from './protocol.js';

const HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtube-nocookie.com', 'www.youtube-nocookie.com', 'youtu.be', 'www.youtu.be']);
const MAX_START = 86_400;

export interface YouTubeRef {
  videoId: string;
  startAt: number;
}

/** "90", "90s", "1m30s", "1h2m3s" → seconds. */
export function parseTimeParam(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const s = raw.trim().toLowerCase();
  if (/^\d+$/.test(s)) return Math.min(MAX_START, Number(s));
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(s);
  if (!m || (!m[1] && !m[2] && !m[3])) return null;
  const total = Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
  return total > MAX_START ? null : total;
}

/**
 * Accepts the link forms people actually paste: watch?v=, youtu.be/, /shorts/, /embed/, /live/, /v/, m. and music. hosts,
 * with or without a scheme, plus an optional start time (t=, start=, #t=). Anything else — including playlists-only links,
 * other websites and bare words — returns null.
 */
export function parseYouTubeInput(input: string): YouTubeRef | null {
  const text = (input ?? '').trim();
  if (!text || text.length > 300 || /\s/.test(text)) return null;
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : 'https://' + text);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.username || url.password) return null;
  const host = url.hostname.toLowerCase();
  if (!HOSTS.has(host)) return null;

  let id: string | null = null;
  const parts = url.pathname.split('/').filter(Boolean);
  if (host.endsWith('youtu.be')) id = parts[0] ?? null;
  else if (parts[0] === 'watch') id = url.searchParams.get('v');
  else if (parts[0] && ['embed', 'shorts', 'live', 'v'].includes(parts[0])) id = parts[1] ?? null;
  if (!id || !YT_ID.test(id)) return null;

  const hash = new URLSearchParams(url.hash.replace(/^#/, ''));
  const startAt = parseTimeParam(url.searchParams.get('t')) ?? parseTimeParam(url.searchParams.get('start')) ?? parseTimeParam(hash.get('t')) ?? 0;
  return { videoId: id, startAt };
}

// ---------------------------------------------------------------- IFrame API (minimal typing)

export const YT_STATE = { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 } as const;

export interface YtPlayerLike {
  playVideo(): void;
  pauseVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  getCurrentTime(): number;
  getDuration(): number;
  getPlayerState(): number;
  getPlaybackRate(): number;
  setPlaybackRate(rate: number): void;
  getAvailablePlaybackRates(): number[];
  getVideoLoadedFraction(): number;
  getVideoData?(): { video_id?: string; title?: string; isLive?: boolean };
  setVolume(volume: number): void;
  mute(): void;
  unMute(): void;
  destroy(): void;
  /** Captions module (unofficial but long-stable parts of the IFrame API). */
  loadModule?(name: string): void;
  unloadModule?(name: string): void;
  getOption?(module: string, option: string): unknown;
  setOption?(module: string, option: string, value: unknown): void;
}

export interface YtPlayerOptions {
  host: string;
  videoId: string;
  width: string;
  height: string;
  playerVars: Record<string, string | number>;
  events: {
    onReady?: (e: { target: YtPlayerLike }) => void;
    onStateChange?: (e: { data: number; target: YtPlayerLike }) => void;
    onError?: (e: { data: number }) => void;
    onPlaybackRateChange?: () => void;
  };
}

type YtNamespace = { Player: new (el: HTMLElement, opts: YtPlayerOptions) => YtPlayerLike };
declare global {
  interface Window {
    YT?: YtNamespace;
    onYouTubeIframeAPIReady?: () => void;
  }
}

let apiPromise: Promise<YtNamespace> | null = null;

/** Loads https://www.youtube.com/iframe_api once. Rejects (and allows a retry) if YouTube can't be reached. */
export function loadYouTubeApi(timeoutMs = 15_000): Promise<YtNamespace> {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (apiPromise) return apiPromise;
  apiPromise = new Promise<YtNamespace>((resolve, reject) => {
    const prev = window.onYouTubeIframeAPIReady;
    const timer = setTimeout(() => fail(new Error('timeout')), timeoutMs);
    const fail = (e: Error) => {
      clearTimeout(timer);
      apiPromise = null;
      reject(e);
    };
    window.onYouTubeIframeAPIReady = () => {
      prev?.();
      clearTimeout(timer);
      window.YT?.Player ? resolve(window.YT) : fail(new Error('no api'));
    };
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.async = true;
    s.onerror = () => {
      s.remove();
      fail(new Error('blocked'));
    };
    document.head.appendChild(s);
  });
  return apiPromise;
}

/** Map a YouTube error code to what we tell the room. */
export function issueFromError(code: number): 'blocked' | 'unavailable' {
  return code === 101 || code === 150 ? 'blocked' : 'unavailable';
}

export function errorText(code: number): string {
  if (code === 101 || code === 150) return 'The video’s owner doesn’t allow it to be played outside YouTube.';
  if (code === 100) return 'That video is private, removed or not available in your country.';
  if (code === 2) return 'That doesn’t look like a valid YouTube video.';
  return 'YouTube couldn’t play this video here.';
}
