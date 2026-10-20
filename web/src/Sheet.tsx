import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useBackClose, usePortalTarget } from './hooks.js';
import Icon from './Icon.js';

interface Props {
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** 'bottom': bottom sheet on phones, floating card on large screens. 'right': slide-over drawer. */
  side?: 'bottom' | 'right';
}

/**
 * One overlay for settings, Hard Sync, shortcuts, people… Rendered in a portal (page level, or inside the fullscreen
 * element) so it is never trapped inside a small player. Closes with Escape, the backdrop, a downward swipe on the
 * handle, and the Android Back button.
 */
export default function Sheet({ title, onClose, children, side = 'bottom' }: Props) {
  const target = usePortalTarget();
  useBackClose(true, onClose);
  const [dy, setDy] = useState(0);
  const drag = useRef<{ y: number; id: number } | null>(null);
  const dockEl = useRef<HTMLDivElement>(null);
  // focus the sheet ONCE when it opens (a ref callback would re-run on every render and steal focus from open dropdowns)
  useEffect(() => dockEl.current?.focus({ preventScroll: true }), []);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
    }
  };

  return createPortal(
    <div className={'dock-wrap ' + side} onPointerDown={onClose} onKeyDown={onKey}>
      <div
        className="dock"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        style={dy ? { transform: `translateY(${dy}px)`, transition: 'none' } : undefined}
        onPointerDown={(e) => e.stopPropagation()}
        ref={dockEl}
        tabIndex={-1}
      >
        {side === 'bottom' && (
          <div
            className="grab"
            onPointerDown={(e) => {
              drag.current = { y: e.clientY, id: e.pointerId };
              e.currentTarget.setPointerCapture(e.pointerId);
            }}
            onPointerMove={(e) => drag.current && setDy(Math.max(0, e.clientY - drag.current.y))}
            onPointerUp={() => {
              const moved = dy;
              drag.current = null;
              setDy(0);
              if (moved > 90) onClose();
            }}
            onPointerCancel={() => ((drag.current = null), setDy(0))}
          >
            <span />
          </div>
        )}
        <div className="dock-head">
          <h3>{title}</h3>
          <button className="ic" onClick={onClose} aria-label="Close">
            <Icon name="close" />
          </button>
        </div>
        <div className="dock-body">{children}</div>
      </div>
    </div>,
    target,
  );
}
