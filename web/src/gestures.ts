// Touch gesture recogniser (YouTube / MX-player style). Pure: pointer coordinates in, semantic events out.
// Time and timers are injected so the tests are deterministic.

export type Zone = 'left' | 'center' | 'right';

export type GestureEvent =
  | { type: 'tap' }
  | { type: 'doubletap'; zone: Zone; count: number }
  | { type: 'vol-start' }
  /** frac: drag travel as a fraction of the useful height; positive = upwards. */
  | { type: 'vol'; frac: number }
  | { type: 'vol-end'; cancelled: boolean }
  | { type: 'scrub-start' }
  | { type: 'scrub'; dx: number; width: number }
  | { type: 'scrub-end'; cancelled: boolean }
  | { type: 'pinch'; scale: number }
  | { type: 'pinch-end'; scale: number };

export interface GestureConfig {
  /** Movement below this (px) still counts as a tap. */
  slop: number;
  /** Max gap between the two taps of a double-tap. */
  doubleTapMs: number;
  doubleTapDist: number;
  /** After a double-tap, further single taps in the same zone keep adding steps for this long. */
  multiMs: number;
  /** Touches starting this close to the left/right screen edge are ignored (OS back-swipe area). */
  edge: number;
  /** Fraction of the player height that equals a full 0→100 % volume sweep. */
  volSpan: number;
}

export const DEFAULT_GESTURES: GestureConfig = { slop: 10, doubleTapMs: 300, doubleTapDist: 80, multiMs: 600, edge: 18, volSpan: 0.8 };

export const zoneOf = (x: number, width: number): Zone => (x < width * 0.4 ? 'left' : x > width * 0.6 ? 'right' : 'center');

export interface Timers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}
const realTimers: Timers = { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) };

interface Pt {
  x0: number;
  y0: number;
  x: number;
  y: number;
}

type Mode = 'idle' | 'press' | 'vol' | 'scrub' | 'pinch' | 'dead';

export class GestureTracker {
  private pts = new Map<number, Pt>();
  private mode: Mode = 'idle';
  private pinchStart = 0;
  private lastScale = 1;
  private lastTap: { t: number; x: number; y: number; zone: Zone } | null = null;
  private tapTimer: unknown = null;
  private multi: { zone: Zone; count: number; until: number } | null = null;

  constructor(
    private readonly emit: (e: GestureEvent) => void,
    private readonly size: () => { w: number; h: number },
    private readonly cfg: GestureConfig = DEFAULT_GESTURES,
    private readonly now: () => number = () => Date.now(),
    private readonly timers: Timers = realTimers,
  ) {}

  private clearTapTimer() {
    if (this.tapTimer !== null) this.timers.clear(this.tapTimer);
    this.tapTimer = null;
  }

  down(id: number, x: number, y: number): void {
    const { w } = this.size();
    if (this.pts.size === 0 && (x < this.cfg.edge || x > w - this.cfg.edge)) {
      this.mode = 'dead'; // edge touch: ignored until it lifts
      this.pts.set(id, { x0: x, y0: y, x, y });
      return;
    }
    this.pts.set(id, { x0: x, y0: y, x, y });
    if (this.pts.size >= 2) {
      this.endActive(true);
      this.clearTapTimer();
      this.lastTap = null;
      this.mode = 'pinch';
      this.pinchStart = this.spread() || 1;
      this.lastScale = 1;
    } else if (this.mode === 'idle') this.mode = 'press';
  }

  private spread(): number {
    const [a, b] = [...this.pts.values()];
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  }

  move(id: number, x: number, y: number): void {
    const p = this.pts.get(id);
    if (!p) return;
    p.x = x;
    p.y = y;
    const { w, h } = this.size();
    switch (this.mode) {
      case 'press': {
        const dx = x - p.x0;
        const dy = y - p.y0;
        if (Math.hypot(dx, dy) <= this.cfg.slop) return;
        this.clearTapTimer();
        this.lastTap = null;
        if (Math.abs(dy) > Math.abs(dx) * 1.2) {
          if (p.x0 > w / 2) {
            this.mode = 'vol';
            this.emit({ type: 'vol-start' });
          } else this.mode = 'dead'; // vertical swipe on the left half does nothing
        } else {
          this.mode = 'scrub';
          this.emit({ type: 'scrub-start' });
        }
        if (this.mode === 'vol') this.emit({ type: 'vol', frac: -(y - p.y0) / (h * this.cfg.volSpan) });
        if (this.mode === 'scrub') this.emit({ type: 'scrub', dx, width: w });
        return;
      }
      case 'vol':
        return this.emit({ type: 'vol', frac: -(y - p.y0) / (h * this.cfg.volSpan) });
      case 'scrub':
        return this.emit({ type: 'scrub', dx: x - p.x0, width: w });
      case 'pinch': {
        this.lastScale = this.spread() / this.pinchStart;
        return this.emit({ type: 'pinch', scale: this.lastScale });
      }
      default:
    }
  }

  private endActive(cancelled: boolean) {
    if (this.mode === 'vol') this.emit({ type: 'vol-end', cancelled });
    else if (this.mode === 'scrub') this.emit({ type: 'scrub-end', cancelled });
    else if (this.mode === 'pinch') this.emit({ type: 'pinch-end', scale: this.lastScale });
  }

  up(id: number, x: number, y: number): void {
    const p = this.pts.get(id);
    if (!p) return;
    this.pts.delete(id);
    const mode = this.mode;
    if (mode === 'pinch') {
      if (this.pts.size < 2) {
        this.emit({ type: 'pinch-end', scale: this.lastScale });
        this.mode = this.pts.size ? 'dead' : 'idle';
      }
      return;
    }
    if (mode === 'vol' || mode === 'scrub') {
      this.endActive(false);
      this.mode = this.pts.size ? 'dead' : 'idle';
      return;
    }
    if (mode === 'dead') {
      if (!this.pts.size) this.mode = 'idle';
      return;
    }
    if (mode === 'press') {
      this.mode = this.pts.size ? 'dead' : 'idle';
      this.tap(p.x0, p.y0, x, y);
    }
  }

  private tap(x: number, y: number, _ux: number, _uy: number): void {
    const { w } = this.size();
    const zone = zoneOf(x, w);
    const t = this.now();
    const m = this.multi;
    if (m && t < m.until && m.zone === zone && zone !== 'center') {
      m.count++;
      m.until = t + this.cfg.multiMs;
      this.emit({ type: 'doubletap', zone, count: m.count });
      return;
    }
    const lt = this.lastTap;
    if (lt && t - lt.t <= this.cfg.doubleTapMs && lt.zone === zone && Math.hypot(x - lt.x, y - lt.y) <= this.cfg.doubleTapDist) {
      this.clearTapTimer();
      this.lastTap = null;
      this.multi = zone === 'center' ? null : { zone, count: 1, until: t + this.cfg.multiMs };
      this.emit({ type: 'doubletap', zone, count: 1 });
      return;
    }
    // A different, earlier tap is still waiting for its double-tap window: it was a plain tap — deliver it now, don't drop it.
    if (this.tapTimer !== null) {
      this.clearTapTimer();
      this.emit({ type: 'tap' });
    }
    this.lastTap = { t, x, y, zone };
    this.tapTimer = this.timers.set(() => {
      this.tapTimer = null;
      this.lastTap = null;
      this.emit({ type: 'tap' });
    }, this.cfg.doubleTapMs);
  }

  /** Pointer lost (system gesture, tab switch…): end whatever was in progress without committing it. */
  cancel(): void {
    this.endActive(true);
    this.clearTapTimer();
    this.pts.clear();
    this.mode = 'idle';
    this.lastTap = null;
    this.multi = null;
  }
}

// ---------- pure mappers used by the player ----------

/** New volume from the one the swipe started at. */
export const volumeFromDrag = (startVol: number, frac: number): number => Math.min(1, Math.max(0, startVol + frac));

/** How far a horizontal swipe scrubs: a full-width swipe covers `span` seconds (long films scrub faster, short clips slower). */
export function scrubSpan(duration: number): number {
  return Math.min(300, Math.max(60, duration * 0.25));
}
export function seekFromDrag(startTime: number, dx: number, width: number, duration: number): number {
  const target = startTime + (dx / Math.max(1, width)) * scrubSpan(duration);
  return Math.min(Math.max(0, target), Math.max(0, duration - 0.5));
}

/** Pinch zoom is clamped to 1×–3× and snaps back to "fit" when nearly closed. */
export const clampZoom = (z: number): number => (z < 1.08 ? 1 : Math.min(3, z));
