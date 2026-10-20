import { useEffect, useMemo, useRef } from 'react';
import { DEFAULT_GESTURES, GestureTracker, type GestureEvent } from './gestures.js';

/**
 * Wires a GestureTracker to an element's pointer events. Mouse pointers are ignored here (the player uses click /
 * double-click for them). `onGesture` may change every render; the latest one is always used.
 */
export function useGestures(el: React.RefObject<HTMLElement>, onGesture: (e: GestureEvent) => void, enabled: boolean) {
  const cb = useRef(onGesture);
  cb.current = onGesture;
  const tracker = useMemo(
    () =>
      new GestureTracker(
        (e) => cb.current(e),
        () => {
          const r = el.current?.getBoundingClientRect();
          return { w: r?.width ?? 1, h: r?.height ?? 1 };
        },
        DEFAULT_GESTURES,
      ),
    [el],
  );

  useEffect(() => {
    const node = el.current;
    if (!node || !enabled) return;
    const rel = (e: PointerEvent) => {
      const r = node.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top] as const;
    };
    const down = (e: PointerEvent) => {
      if (e.pointerType === 'mouse') return;
      try {
        node.setPointerCapture(e.pointerId);
      } catch {
        /* pointer already gone */
      }
      tracker.down(e.pointerId, ...rel(e));
    };
    const move = (e: PointerEvent) => e.pointerType !== 'mouse' && tracker.move(e.pointerId, ...rel(e));
    const up = (e: PointerEvent) => e.pointerType !== 'mouse' && tracker.up(e.pointerId, ...rel(e));
    const cancel = () => tracker.cancel();
    node.addEventListener('pointerdown', down);
    node.addEventListener('pointermove', move);
    node.addEventListener('pointerup', up);
    node.addEventListener('pointercancel', cancel);
    return () => {
      node.removeEventListener('pointerdown', down);
      node.removeEventListener('pointermove', move);
      node.removeEventListener('pointerup', up);
      node.removeEventListener('pointercancel', cancel);
      tracker.cancel();
    };
  }, [el, tracker, enabled]);
}
