import Icon from './Icon.js';
import type { ToastKind } from './useRoom.js';

export interface ToastItem {
  id: number;
  text: string;
  kind: ToastKind;
}

/** Lives inside the fullscreen "theater" element so messages stay visible in fullscreen. */
export default function Toasts({ items }: { items: ToastItem[] }) {
  return (
    <div className="toasts" role="status" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} className={'toast ' + t.kind}>
          {t.kind !== 'info' && <Icon name="alert" size={16} />}
          <span>{t.text}</span>
        </div>
      ))}
    </div>
  );
}
