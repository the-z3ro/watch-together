import { useRef, useState } from 'react';
import { fmtTime } from './engine.js';

interface Props {
  /** Current position and length in seconds. */
  value: number;
  max: number;
  /** 0‥1 of the media buffered. */
  buffered: number;
  disabled: boolean;
  /** Called continuously while dragging (preview) and once on release (commit). */
  onPreview: (t: number) => void;
  onCommit: (t: number) => void;
  onCancel: () => void;
  onDenied: () => void;
}

/** Progress bar with buffered range, large touch target, time bubble while dragging. */
export default function Scrubber({ value, max, buffered, disabled, onPreview, onCommit, onCancel, onDenied }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const active = useRef<number | null>(null);

  const posFrom = (clientX: number): number => {
    const r = ref.current?.getBoundingClientRect();
    if (!r || r.width <= 0 || !(max > 0)) return 0;
    return Math.min(1, Math.max(0, (clientX - r.left) / r.width)) * max;
  };
  const frac = max > 0 ? Math.min(1, Math.max(0, (drag ?? value) / max)) : 0;

  return (
    <div
      ref={ref}
      className={'scrub' + (disabled ? ' off' : '') + (drag !== null ? ' drag' : '')}
      role="slider"
      aria-label="Seek"
      aria-valuemin={0}
      aria-valuemax={Math.round(max)}
      aria-valuenow={Math.round(value)}
      aria-valuetext={`${fmtTime(value)} of ${fmtTime(max)}`}
      aria-disabled={disabled}
      onPointerDown={(e) => {
        e.stopPropagation();
        if (disabled) return onDenied();
        active.current = e.pointerId;
        e.currentTarget.setPointerCapture(e.pointerId);
        const t = posFrom(e.clientX);
        setDrag(t);
        onPreview(t);
      }}
      onPointerMove={(e) => {
        if (active.current !== e.pointerId) return;
        const t = posFrom(e.clientX);
        setDrag(t);
        onPreview(t);
      }}
      onPointerUp={(e) => {
        if (active.current !== e.pointerId) return;
        active.current = null;
        const t = posFrom(e.clientX);
        setDrag(null);
        onCommit(t);
      }}
      onPointerCancel={() => {
        active.current = null;
        setDrag(null);
        onCancel();
      }}
    >
      <div className="scrub-track">
        <div className="scrub-buf" style={{ width: buffered * 100 + '%' }} />
        <div className="scrub-fill" style={{ width: frac * 100 + '%' }} />
        <div className="scrub-thumb" style={{ left: frac * 100 + '%' }} />
      </div>
      {drag !== null && (
        <div className="scrub-tip" style={{ left: `clamp(28px, ${frac * 100}%, calc(100% - 28px))` }}>
          {fmtTime(drag)}
        </div>
      )}
    </div>
  );
}
