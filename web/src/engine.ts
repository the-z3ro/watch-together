// Pure synchronisation maths. No DOM, no sockets — everything here is unit-tested and simulated.
import type { FileInfo, PlaybackState } from './protocol.js';

/** All tunables in one place. Times in seconds unless the name ends in Ms. */
export interface SyncConfig {
  /** How often the correction loop runs while playing. */
  tickMs: number;
  /** Drift below this is ignored entirely. */
  deadband: number;
  /** Start gentle speed correction above this drift… */
  engage: number;
  /** …and keep going until drift falls below this (hysteresis stops chatter around the threshold). */
  release: number;
  /** At or above this drift speed correction is too slow to be comfortable: hard seek. */
  hardSeek: number;
  /** Largest speed change, as a fraction of the intended rate (0.05 = ±5%, hard to notice). */
  maxRateDelta: number;
  /** Speed change per second of drift (proportional control). */
  gain: number;
  /** Largest change of the speed offset per tick — keeps speed changes smooth. */
  slew: number;
  /** Minimum time between automatic hard seeks. */
  seekCooldownMs: number;
  /** After this many seeks in a row without converging, stop seeking for a while. */
  maxSeeks: number;
  backoffMs: number;
  /** Playing but not progressing for this long counts as stalled (buffering / throttled). */
  stallMs: number;
}

export const DEFAULT_SYNC: SyncConfig = {
  tickMs: 500,
  deadband: 0.05,
  engage: 0.12,
  release: 0.05,
  hardSeek: 1.0,
  maxRateDelta: 0.05,
  gain: 0.3,
  slew: 0.01,
  seekCooldownMs: 3000,
  maxSeeks: 3,
  backoffMs: 12_000,
  stallMs: 1500,
};

export interface CorrState {
  /** Current speed offset as a fraction of the intended rate (+ = faster). */
  delta: number;
  correcting: boolean;
  lastSeekAt: number;
  /** Consecutive automatic hard seeks without having converged. */
  seeks: number;
  backoffUntil: number;
  /** Consecutive backoffs; each one doubles the pause (up to 8x) so a hopeless seek loop quiets down. */
  backoffs: number;
}

export const initialCorr = (): CorrState => ({ delta: 0, correcting: false, lastSeekAt: -Infinity, seeks: 0, backoffUntil: 0, backoffs: 0 });

export type SyncStatus = 'synced' | 'catching-up' | 'holding' | 'struggling';

export interface Plan {
  action: 'none' | 'rate' | 'seek' | 'hold';
  /** The playbackRate the element should have after this tick. */
  rate: number;
  status: SyncStatus;
  state: CorrState;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Where the media should be at server time `serverNow`. */
export function expectedPosition(pb: Pick<PlaybackState, 'playing' | 'position' | 'at' | 'rate'>, serverNow: number): number {
  if (!pb.playing) return pb.position;
  return Math.max(0, pb.position + (Math.max(0, serverNow - pb.at) / 1000) * pb.rate);
}

export interface TickInput {
  /** expected − actual, in seconds. Positive = this viewer is behind. */
  drift: number;
  /** The room's intended rate (set by owner/controllers). Corrections are made around it, never to it. */
  baseRate: number;
  state: CorrState;
  now: number;
  /** False while buffering, seeking, hidden-throttled or otherwise unable to progress: no corrections then. */
  playable: boolean;
  /** Explicit user/owner Hard Sync: seek now regardless of thresholds and cooldowns. */
  force?: boolean;
  cfg?: SyncConfig;
}

/** Decide what to do this tick. Two-sided: behind → a little faster, ahead → a little slower. */
export function planTick(i: TickInput): Plan {
  const cfg = i.cfg ?? DEFAULT_SYNC;
  const s: CorrState = { ...i.state };
  const abs = Math.abs(i.drift);

  if (!i.playable) {
    // Never fight a player that cannot progress; return to the intended speed and wait.
    s.delta = 0;
    s.correcting = false;
    return { action: 'hold', rate: i.baseRate, status: 'holding', state: s };
  }

  if (i.force) {
    Object.assign(s, { delta: 0, correcting: false, lastSeekAt: i.now, seeks: 0, backoffUntil: 0, backoffs: 0 });
    return { action: 'seek', rate: i.baseRate, status: 'catching-up', state: s };
  }

  const backingOff = i.now < s.backoffUntil;
  if (abs >= cfg.hardSeek && !backingOff && i.now - s.lastSeekAt >= cfg.seekCooldownMs) {
    s.seeks += 1;
    s.lastSeekAt = i.now;
    s.delta = 0;
    s.correcting = false;
    if (s.seeks <= cfg.maxSeeks) return { action: 'seek', rate: i.baseRate, status: 'catching-up', state: s };
    // Seeking is not helping (slow media, failing seeks…): stop hammering it and fall back to gentle correction.
    s.backoffUntil = i.now + cfg.backoffMs * 2 ** Math.min(s.backoffs, 3);
    s.backoffs += 1;
    s.seeks = 0;
  }
  if (abs < cfg.engage) {
    // converged enough: forgive earlier seeks and backoffs
    s.seeks = 0;
    s.backoffs = 0;
  }

  let target = 0;
  if (abs >= cfg.engage || (s.correcting && abs >= cfg.release)) {
    s.correcting = true;
    target = clamp(i.drift * cfg.gain, -cfg.maxRateDelta, cfg.maxRateDelta);
  } else {
    s.correcting = false;
  }
  if (abs < cfg.deadband) target = 0;

  s.delta += clamp(target - s.delta, -cfg.slew, cfg.slew);
  if (!s.correcting && Math.abs(s.delta) < 0.0005) {
    s.delta = 0;
    return { action: 'none', rate: i.baseRate, status: 'synced', state: s };
  }
  const struggling = abs >= cfg.hardSeek && (backingOff || s.seeks > 0 || i.now < s.backoffUntil);
  return {
    action: 'rate',
    rate: clamp(i.baseRate * (1 + s.delta), 0.1, 4),
    status: struggling ? 'struggling' : s.correcting ? 'catching-up' : 'synced',
    state: s,
  };
}

/** True when a player that should be playing has not progressed (≈ buffering or throttled). */
export function isStalled(prev: { t: number; wall: number }, cur: { t: number; wall: number }, rate: number, cfg: SyncConfig = DEFAULT_SYNC): boolean {
  const wall = cur.wall - prev.wall;
  if (wall < cfg.stallMs) return false;
  const progressed = cur.t - prev.t;
  return progressed < 0.2 * (wall / 1000) * rate;
}

// ---------- clock sync ----------

/** Estimate (serverTime − localTime) in ms from several pings; the lowest-RTT sample is the most trustworthy. */
export async function measureOffset(
  ping: (cb: (serverNow: number) => void) => void,
  samples = 6,
): Promise<{ rtt: number; offset: number } | null> {
  let best: { rtt: number; offset: number } | null = null;
  for (let i = 0; i < samples; i++) {
    const t0 = Date.now();
    const server = await new Promise<number | null>((res) => {
      const timer = setTimeout(() => res(null), 3000);
      ping((t) => (clearTimeout(timer), res(t)));
    });
    const t1 = Date.now();
    if (server === null) continue;
    const rtt = t1 - t0;
    if (!best || rtt < best.rtt) best = { rtt, offset: server - (t0 + rtt / 2) };
    await new Promise((r) => setTimeout(r, 120));
  }
  return best;
}

// ---------- file comparison & formatting ----------

export type FileMatch = 'match' | 'maybe' | 'mismatch' | 'waiting';

/** Never trust file names: compare size + duration. */
export function compareFiles(a: FileInfo | null | undefined, b: FileInfo | null | undefined): FileMatch {
  if (!a || !b || !a.duration || !b.duration) return 'waiting';
  const sameDuration = Math.abs(a.duration - b.duration) <= 1;
  if (a.size === b.size && sameDuration) return 'match';
  if (sameDuration) return 'maybe'; // same length, different bytes (re-encode?) — usually still fine
  return 'mismatch';
}

export function fmtTime(s: number): string {
  if (!Number.isFinite(s)) return '–:––';
  s = Math.max(0, Math.floor(s));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h ? h + ':' : ''}${h ? String(m).padStart(2, '0') : String(m)}:${String(s % 60).padStart(2, '0')}`;
}

export function fmtSize(bytes: number): string {
  if (!bytes) return '';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (bytes >= 1024 && i < u.length - 1) {
    bytes /= 1024;
    i++;
  }
  return `${bytes.toFixed(i > 1 ? 1 : 0)} ${u[i]}`;
}
