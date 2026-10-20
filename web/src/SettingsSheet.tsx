import Icon from './Icon.js';
import Sheet from './Sheet.js';

export type CapSize = 'S' | 'M' | 'L';

interface Props {
  kind: 'file' | 'youtube';
  touch: boolean;
  canControl: boolean;
  rate: number;
  rates: number[];
  onRate: (r: number) => void;
  hasCaptions: boolean;
  ccOn: boolean;
  onCc: (on: boolean) => void;
  ytCc: boolean;
  onYtCc: (on: boolean) => void;
  ytTracks: { code: string; name: string }[];
  ytLang: string;
  onYtLang: (code: string) => void;
  capSize: CapSize;
  onCapSize: (s: CapSize) => void;
  capBg: boolean;
  onCapBg: (on: boolean) => void;
  fit: 'contain' | 'cover';
  onFit: (f: 'contain' | 'cover') => void;
  canPip: boolean;
  pip: boolean;
  onPip: () => void;
  nativeYt: boolean;
  onNativeYt: (on: boolean) => void;
  statusText: string;
  drift: number | null;
  rtt: number | null;
  onHardSync: () => void;
  onLock: () => void;
  onHelp: () => void;
  onClose: () => void;
}

const fmtRate = (r: number) => (r === 1 ? 'Normal' : r + '×');

function Seg<T extends string | number>({ value, options, onChange, label, disabled }: { value: T; options: { v: T; t: string }[]; onChange: (v: T) => void; label: string; disabled?: boolean }) {
  return (
    <div className="seg" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={String(o.v)} role="radio" aria-checked={o.v === value} className={o.v === value ? 'on' : ''} onClick={() => onChange(o.v)} disabled={disabled}>
          {o.t}
        </button>
      ))}
    </div>
  );
}

function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="switch" aria-label={label}>
      <input type="checkbox" checked={on} onChange={(e) => onChange(e.target.checked)} />
      <span />
    </label>
  );
}

/** Everything that doesn't fit in the control bar lives here, so no control is ever lost on a small screen. */
export default function SettingsSheet(p: Props) {
  const yt = p.kind === 'youtube';
  return (
    <Sheet title="Player settings" onClose={p.onClose}>
      <div className="srow">
        <div>
          <b>Speed</b>
          <small>{p.canControl ? 'Shared — changes it for everyone.' : 'Set by the owner or controllers.'}</small>
        </div>
        <Seg label="Playback speed" value={p.rate} disabled={!p.canControl} onChange={p.onRate} options={p.rates.map((r) => ({ v: r, t: fmtRate(r) }))} />
      </div>

      {!yt && (
        <>
          <div className="srow">
            <div>
              <b>Captions</b>
              <small>{p.hasCaptions ? 'Only affects your screen.' : 'No shared captions yet.'}</small>
            </div>
            <Toggle on={p.ccOn && p.hasCaptions} onChange={p.onCc} label="Captions on" />
          </div>
          <div className="srow">
            <div>
              <b>Caption size</b>
            </div>
            <Seg label="Caption size" value={p.capSize} onChange={p.onCapSize} options={[{ v: 'S', t: 'Small' }, { v: 'M', t: 'Medium' }, { v: 'L', t: 'Large' }]} />
          </div>
          <div className="srow">
            <div>
              <b>Caption background</b>
            </div>
            <Toggle on={p.capBg} onChange={p.onCapBg} label="Caption background" />
          </div>
          <div className="srow">
            <div>
              <b>Picture</b>
              <small>Fill crops the edges to remove black bars.</small>
            </div>
            <Seg label="Picture fit" value={p.fit} onChange={p.onFit} options={[{ v: 'contain', t: 'Fit' }, { v: 'cover', t: 'Fill' }]} />
          </div>
          {p.canPip && (
            <button className="srow link" onClick={() => (p.onPip(), p.onClose())}>
              <div>
                <b>{p.pip ? 'Leave picture-in-picture' : 'Picture-in-picture'}</b>
                <small>Keep watching in a small floating window.</small>
              </div>
              <Icon name="pip" size={18} />
            </button>
          )}
        </>
      )}

      {yt && (
        <>
          <div className="srow">
            <div>
              <b>Captions</b>
              <small>YouTube’s own captions, just for you.</small>
            </div>
            <Toggle on={p.ytCc} onChange={p.onYtCc} label="YouTube captions on" />
          </div>
          {p.ytCc && p.ytTracks.length > 1 && (
            <div className="srow">
              <div>
                <b>Caption language</b>
              </div>
              <select className="field sel" value={p.ytLang || p.ytTracks[0]?.code} onChange={(e) => p.onYtLang(e.target.value)} aria-label="Caption language">
                {p.ytTracks.map((t) => (
                  <option key={t.code} value={t.code}>
                    {t.name}
                  </option>
                ))}
              </select>
            </div>
          )}
        </>
      )}

      {yt && (
        <div className="srow">
          <div>
            <b>Use YouTube’s own controls</b>
            <small>For video quality or skipping ads. Sync keeps working; pause, play and seeking by the owner/controllers are shared.</small>
          </div>
          <Toggle on={p.nativeYt} onChange={p.onNativeYt} label="Use YouTube controls" />
        </div>
      )}

      <button className="srow link" onClick={() => (p.onClose(), p.onHardSync())}>
        <div>
          <b>Hard Sync</b>
          <small>Jump straight to where the room is{' '}(owner can sync everyone).</small>
        </div>
        <Icon name="sync" size={18} />
      </button>
      {p.touch && (
        <button className="srow link" onClick={() => (p.onClose(), p.onLock())}>
          <div>
            <b>Lock controls</b>
            <small>Ignore touches until you unlock — no accidental taps.</small>
          </div>
          <Icon name="lock" size={18} />
        </button>
      )}
      <button className="srow link" onClick={() => (p.onClose(), p.onHelp())}>
        <div>
          <b>{p.touch ? 'Gestures & shortcuts' : 'Keyboard shortcuts'}</b>
        </div>
        <Icon name="keyboard" size={18} />
      </button>

      <div className="stats" aria-label="Connection details">
        <span>{p.statusText}</span>
        {p.drift !== null && <span>{p.drift === 0 ? 'on time' : `${Math.abs(p.drift).toFixed(1)} s ${p.drift > 0 ? 'behind' : 'ahead'}`}</span>}
        {p.rtt !== null && <span>{p.rtt} ms to server</span>}
      </div>
    </Sheet>
  );
}
