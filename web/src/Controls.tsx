import { fmtTime } from './engine.js';
import Icon from './Icon.js';
import type { CtrlId } from './layout.js';
import Scrubber from './Scrubber.js';

export interface ControlsProps {
  inline: ReadonlySet<CtrlId>;
  touch: boolean;
  /** Touch layout: back / play / forward sit in a big centre cluster instead of the bottom row. */
  cluster: boolean;
  playing: boolean;
  canControl: boolean;
  cur: number;
  dur: number;
  buffered: number;
  rate: number;
  muted: boolean;
  vol: number;
  statusText: string;
  statusTone: string;
  driftText: string;
  ccOn: boolean;
  hasCaptions: boolean;
  pip: boolean;
  seekStep: number;
  onPlay: () => void;
  onBack: () => void;
  onFwd: () => void;
  onRate: () => void;
  onSync: () => void;
  onCc: () => void;
  onMute: () => void;
  onVol: (v: number) => void;
  onPip: () => void;
  onSettings: () => void;
  onFull: () => void;
  onPreview: (t: number) => void;
  onCommit: (t: number) => void;
  onCancel: () => void;
  onDenied: () => void;
}

/** The bottom bar. Which buttons appear is decided by planControls() from the real measured width — never by CSS guesswork. */
export default function Controls(p: ControlsProps) {
  const has = (id: CtrlId) => p.inline.has(id);
  const timeText = (
    <>
      {fmtTime(p.cur)} <i>/</i> {fmtTime(p.dur)}
    </>
  );
  const dis = !p.canControl;
  return (
    <>
      {p.cluster && (
        <div className="cluster" onPointerDown={(e) => e.stopPropagation()}>
          <button className="ic big" onClick={p.onBack} aria-label={`Back ${p.seekStep} seconds`} aria-disabled={dis} data-off={dis}>
            <Icon name="back" size={28} />
          </button>
          <button className="ic huge" onClick={p.onPlay} aria-label={p.playing ? 'Pause' : 'Play'} aria-disabled={dis} data-off={dis}>
            <Icon name={p.playing ? 'pause' : 'play'} size={34} />
          </button>
          <button className="ic big" onClick={p.onFwd} aria-label={`Forward ${p.seekStep} seconds`} aria-disabled={dis} data-off={dis}>
            <Icon name="fwd" size={28} />
          </button>
        </div>
      )}
      <div className="controls" onPointerDown={(e) => e.stopPropagation()}>
        {!has('time') && <div className="time-above">{timeText}{dis && <span className="vo"> · view only</span>}</div>}
        <Scrubber value={p.cur} max={p.dur} buffered={p.buffered} disabled={dis} onPreview={p.onPreview} onCommit={p.onCommit} onCancel={p.onCancel} onDenied={p.onDenied} />
        <div className="row">
          {!p.cluster && has('play') && (
            <>
              {has('back') && (
                <button className="ic" onClick={p.onBack} aria-label={`Back ${p.seekStep} seconds`} title={`Back ${p.seekStep}s (J)`} aria-disabled={dis} data-off={dis}>
                  <Icon name="back" />
                </button>
              )}
              <button className="ic main" onClick={p.onPlay} aria-label={p.playing ? 'Pause' : 'Play'} title="Play / pause (K)" aria-disabled={dis} data-off={dis}>
                <Icon name={p.playing ? 'pause' : 'play'} size={24} />
              </button>
              {has('fwd') && (
                <button className="ic" onClick={p.onFwd} aria-label={`Forward ${p.seekStep} seconds`} title={`Forward ${p.seekStep}s (;)`} aria-disabled={dis} data-off={dis}>
                  <Icon name="fwd" />
                </button>
              )}
            </>
          )}
          {has('time') && (
            <span className="time">
              {timeText}
              {dis && <span className="vo"> · view only</span>}
            </span>
          )}
          <span className="grow" />
          {has('status') && (
            <span className={'chip ' + p.statusTone} title={p.driftText}>
              {p.statusText}
            </span>
          )}
          {has('rate') && (
            <button className="ic text" onClick={p.onRate} aria-label="Playback speed" title={p.canControl ? 'Playback speed (shared)' : 'Speed is set by the owner/controllers'}>
              {p.rate}×
            </button>
          )}
          {has('sync') && (
            <button className="ic" onClick={p.onSync} aria-label="Hard Sync" aria-haspopup="dialog" title="Hard Sync ( \ )">
              <Icon name="sync" size={19} />
            </button>
          )}
          {has('cc') && (
            <button className={'ic' + (p.ccOn && p.hasCaptions ? ' on' : '')} onClick={p.onCc} disabled={!p.hasCaptions} aria-label="Captions" aria-pressed={p.ccOn} title="Captions (C)">
              <Icon name="cc" />
            </button>
          )}
          {has('mute') && (
            <button className="ic" onClick={p.onMute} aria-label={p.muted ? 'Unmute' : 'Mute'} title="Mute (M)">
              <Icon name={p.muted || p.vol === 0 ? 'mute' : 'volume'} />
            </button>
          )}
          {has('volume') && (
            <input
              className="vol"
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={p.muted ? 0 : p.vol}
              aria-label="Volume"
              style={{ ['--p' as string]: (p.muted ? 0 : p.vol) * 100 + '%' }}
              onChange={(e) => p.onVol(Number(e.target.value))}
            />
          )}
          {has('pip') && (
            <button className={'ic' + (p.pip ? ' on' : '')} onClick={p.onPip} aria-label="Picture in picture" title="Picture-in-picture (P)">
              <Icon name="pip" />
            </button>
          )}
          <button className="ic" onClick={p.onSettings} aria-label="Settings" aria-haspopup="dialog" title="Settings">
            <Icon name="settings" />
          </button>
          <button className="ic" onClick={p.onFull} aria-label="Fullscreen" title="Fullscreen (F)">
            <Icon name="full" />
          </button>
        </div>
      </div>
    </>
  );
}
