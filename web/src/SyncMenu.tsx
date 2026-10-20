import { useState } from 'react';
import Icon from './Icon.js';
import { fmtTime } from './engine.js';

interface Props {
  /** Owner (or a permitted controller) may sync everyone. */
  canSyncAll: boolean;
  isOwner: boolean;
  others: number;
  /** The viewer's own current position, shown in the confirmation. */
  position: number;
  startConfirm?: boolean;
  onSyncMe: () => void;
  onSyncAll: () => void;
  onClose: () => void;
}

/** Two clearly different actions: sync only me vs. sync everyone (the latter asks for confirmation). */
export default function SyncMenu({ canSyncAll, isOwner, others, position, startConfirm, onSyncMe, onSyncAll, onClose }: Props) {
  const [confirm, setConfirm] = useState(!!startConfirm && canSyncAll);

  return (
    <div className="syncmenu">
      {!confirm ? (
        <>
          <button className="pitem" onClick={() => (onSyncMe(), onClose())}>
            <Icon name="sync" size={18} />
            <span>
              <b>Sync me to the room</b>
              <small>Only your player jumps to where everyone is. Nobody else is affected.</small>
            </span>
          </button>
          {canSyncAll && (
            <button className="pitem warn" onClick={() => setConfirm(true)} disabled={others === 0}>
              <Icon name="users" size={18} />
              <span>
                <b>Sync everyone to me{isOwner ? '' : ' (allowed by owner)'}</b>
                <small>{others === 0 ? 'Nobody else is here yet.' : `Moves ${others} other ${others === 1 ? 'person' : 'people'} to your position.`}</small>
              </span>
            </button>
          )}
        </>
      ) : (
        <div className="confirm">
          <b>Move everyone to {fmtTime(position)}?</b>
          <p>
            {others} other {others === 1 ? 'person' : 'people'} will jump to your current position. Yours won’t change.
          </p>
          <div className="row2">
            <button className="btn" onClick={() => (canSyncAll ? setConfirm(false) : onClose())}>
              Back
            </button>
            <button className="btn primary" onClick={() => (onSyncAll(), onClose())} autoFocus>
              Sync everyone
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
