import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { layoutMode, type LayoutMode } from './layout.js';

/** Window size → layout mode. Re-evaluated on resize / rotation / mobile browser-bar changes, throttled to a frame. */
export function useLayoutMode(): LayoutMode {
  const read = () => layoutMode(window.innerWidth, window.innerHeight);
  const [mode, setMode] = useState<LayoutMode>(read);
  useEffect(() => {
    let raf = 0;
    const update = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => setMode(read()));
    };
    window.addEventListener('resize', update);
    window.addEventListener('orientationchange', update);
    window.visualViewport?.addEventListener('resize', update);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', update);
      window.removeEventListener('orientationchange', update);
      window.visualViewport?.removeEventListener('resize', update);
    };
  }, []);
  return mode;
}

/** Width of an element, kept current with a ResizeObserver (cleaned up on unmount). */
export function useElementWidth<T extends HTMLElement>(): [React.RefObject<T>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(Math.round(el.getBoundingClientRect().width));
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const width = Math.round(entries[0]?.contentRect.width ?? el.getBoundingClientRect().width);
      setW((prev) => (prev === width ? prev : width));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

/** True on touch-first devices (phones, tablets). Follows changes (e.g. docking a keyboard + mouse). */
export function useCoarsePointer(): boolean {
  const q = '(pointer: coarse)';
  const [coarse, setCoarse] = useState(() => typeof matchMedia !== 'undefined' && matchMedia(q).matches);
  useEffect(() => {
    if (typeof matchMedia === 'undefined') return;
    const m = matchMedia(q);
    const on = () => setCoarse(m.matches);
    m.addEventListener?.('change', on);
    return () => m.removeEventListener?.('change', on);
  }, []);
  return coarse;
}

/** Where overlays must be mounted: inside the fullscreen element while fullscreen (otherwise they would be invisible). */
export function usePortalTarget(): HTMLElement {
  const get = () => (document.fullscreenElement as HTMLElement | null) ?? document.body;
  const [t, setT] = useState<HTMLElement>(get);
  useEffect(() => {
    const on = () => setT(get());
    document.addEventListener('fullscreenchange', on);
    return () => document.removeEventListener('fullscreenchange', on);
  }, []);
  return t;
}

// One shared history entry covers however many overlays are open, so chaining them (settings → Hard Sync) can never
// leave a stray entry behind or close the wrong thing. Android Back closes the top-most overlay.
const overlays = new Set<() => void>();
let entry = false;
let popping = false;
let listening = false;

const onPop = () => {
  if (popping) {
    popping = false;
    return;
  }
  if (!entry) return;
  entry = false;
  const top = [...overlays].pop();
  top?.();
  if (overlays.size > 0) {
    try {
      history.pushState({ ...(history.state ?? {}), wtOverlay: true }, '');
      entry = true;
    } catch {
      /* ignore */
    }
  }
};

function acquireOverlay(close: () => void) {
  if (!listening) {
    window.addEventListener('popstate', onPop);
    listening = true;
  }
  overlays.add(close);
  if (!entry) {
    try {
      history.pushState({ ...(history.state ?? {}), wtOverlay: true }, '');
      entry = true;
    } catch {
      /* ignore */
    }
  }
}

function releaseOverlay(close: () => void) {
  overlays.delete(close);
  if (overlays.size) return;
  setTimeout(() => {
    if (overlays.size === 0 && entry) {
      entry = false;
      popping = true;
      history.back();
    }
  }, 0);
}

/** While `open`, the browser/Android Back button closes the overlay instead of leaving the room. */
export function useBackClose(open: boolean, onClose: () => void): void {
  const cb = useRef(onClose);
  cb.current = onClose;
  useEffect(() => {
    if (!open) return;
    const close = () => cb.current();
    acquireOverlay(close);
    return () => releaseOverlay(close);
  }, [open]);
}

/** Keeps the screen awake while `active` (video playing). Silently does nothing where unsupported. */
export function useWakeLock(active: boolean): void {
  useEffect(() => {
    const nav = navigator as Navigator & { wakeLock?: { request(t: 'screen'): Promise<{ release(): Promise<void>; addEventListener?: (e: string, f: () => void) => void }> } };
    if (!active || !nav.wakeLock) return;
    let lock: { release(): Promise<void> } | null = null;
    let dead = false;
    const acquire = () => {
      if (dead || document.hidden) return;
      nav.wakeLock!
        .request('screen')
        .then((l) => (dead ? void l.release().catch(() => {}) : (lock = l)))
        .catch(() => {});
    };
    acquire();
    const onVis = () => !document.hidden && acquire();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      dead = true;
      document.removeEventListener('visibilitychange', onVis);
      lock?.release().catch(() => {});
    };
  }, [active]);
}
