import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { DEFAULT_SYNC, compareFiles, expectedPosition, fmtTime, initialCorr, isStalled, planTick } from './engine.js';
import { SEEK } from './Help.js';
import Icon from './Icon.js';
import type { CaptionData, CmdResult, RoomSnapshot } from './protocol.js';
import SyncMenu from './SyncMenu.js';
import { getStored, setStored } from './api.js';
import type { CapStatus, RoomApi, ToastKind } from './useRoom.js';

export interface LocalFile {
  url: string;
  name: string;
  size: number;
  audio: boolean;
}

type PlayerStatus = 'synced' | 'catching-up' | 'struggling' | 'buffering' | 'starting' | 'paused' | 'ended';
type MenuState = 'none' | 'menu' | 'confirm';

interface Props {
  file: LocalFile;
  room: RoomSnapshot;
  meId: string;
  connected: boolean;
  captions: CaptionData | null;
  capStatus: CapStatus;
  ready: boolean;
  api: RoomApi;
  theater: RefObject<HTMLDivElement>;
  helpOpen: boolean;
  onReady: () => void;
  onMeta: (duration: number) => void;
  onHelp: () => void;
  toast: (text: string, kind?: ToastKind) => void;
  children?: ReactNode;
}

const FFMPEG = 'ffmpeg -i input.mkv -c:v libx264 -c:a aac -movflags +faststart output.mp4';
const RATES = [0.75, 1, 1.25, 1.5];
const EPS = 0.05;
const cfg = DEFAULT_SYNC;

const STATUS_TEXT: Record<PlayerStatus, string> = {
  synced: 'In sync',
  'catching-up': 'Catching up',
  struggling: 'Can’t keep up',
  buffering: 'Buffering',
  starting: 'Starting…',
  paused: 'Paused',
  ended: 'Ended',
};

const isTyping = (el: EventTarget | null): boolean => {
  const e = el as HTMLElement | null;
  if (!e) return false;
  if (e.isContentEditable) return true;
  if (e.tagName === 'TEXTAREA' || e.tagName === 'SELECT') return true;
  if (e.tagName === 'INPUT') return !['range', 'checkbox', 'radio', 'button'].includes((e as HTMLInputElement).type);
  return false;
};

export default function Player(props: Props) {
  const { file, room, meId, connected, captions, capStatus, ready, api, theater } = props;
  const pb = room.playback;
  const me = room.members.find((m) => m.id === meId);
  const owner = room.members.find((m) => m.id === room.ownerId);
  const isOwner = room.ownerId === meId;
  const canControl = !!me?.canControl;
  const canSyncAll = isOwner || (canControl && room.settings.controllersCanSyncAll);
  const others = room.members.filter((m) => m.online && m.id !== meId && m.file).length;

  const vref = useRef<HTMLVideoElement>(null);
  const trackRef = useRef<TextTrack | null>(null);
  const live = useRef({ ...props, canControl, canSyncAll });
  live.current = { ...props, canControl, canSyncAll };

  // sync-loop state (refs: must never trigger renders)
  const corr = useRef(initialCorr());
  const startTimer = useRef<ReturnType<typeof setTimeout>>();
  const hideTimer = useRef<ReturnType<typeof setTimeout>>();
  const seekTimer = useRef<ReturnType<typeof setTimeout>>();
  const pendingSeek = useRef<number | null>(null);
  const hardSeen = useRef(pb.hardSeq);
  const forceNext = useRef(false);
  const seekStart = useRef(0);
  const seekLatency = useRef(0.1);
  const lastSeekWall = useRef(0);
  const progress = useRef<{ t: number; wall: number } | undefined>();
  const stalled = useRef(false);
  const lastDenied = useRef(0);
  const pointerType = useRef('mouse');

  const [cur, setCur] = useState(0);
  const [dur, setDur] = useState(0);
  const [scrub, setScrub] = useState<number | null>(null);
  const [status, setStatus] = useState<PlayerStatus>('paused');
  const [drift, setDrift] = useState(0);
  const [muted, setMuted] = useState(() => getStored('muted') === '1');
  const [vol, setVol] = useState(() => {
    const sv = getStored('vol');
    return sv === null || Number.isNaN(Number(sv)) ? 1 : Math.min(1, Math.max(0, Number(sv)));
  });
  const [ccOn, setCcOn] = useState(() => getStored('cc') !== '0');
  const [ui, setUi] = useState(true);
  const [blocked, setBlocked] = useState(false);
  const [error, setError] = useState(false);
  const [menu, setMenu] = useState<MenuState>('none');
  const [isFs, setIsFs] = useState(false);
  const [pip, setPip] = useState(false);

  const showUi = ui || !pb.playing || scrub !== null || menu !== 'none' || blocked;

  // ---------------------------------------------------------------- sync loop
  const seekTo = useCallback((v: HTMLVideoElement, t: number) => {
    const max = Number.isFinite(v.duration) ? Math.max(0, v.duration - 0.05) : t;
    v.currentTime = Math.min(Math.max(0, t), max);
    seekStart.current = lastSeekWall.current = performance.now();
    progress.current = undefined;
    stalled.current = false;
  }, []);

  const tryPlay = useCallback(() => {
    const p = vref.current?.play();
    p?.catch((e: DOMException) => e.name === 'NotAllowedError' && setBlocked(true));
  }, []);

  const run = useCallback(() => {
    const v = vref.current;
    const L = live.current;
    if (!v || !L.ready || error) return;
    const snap = L.api.getRoom() ?? L.room; // freshest accepted state, not whatever React last rendered
    const p = snap.playback;
    const serverNow = L.api.serverNow();
    const wall = performance.now();
    clearTimeout(startTimer.current);

    // Owner-level Hard Sync: a new hardSeq makes every viewer except the issuer hard-seek once.
    if (p.hardSeq !== hardSeen.current) {
      if (p.by === L.meId) hardSeen.current = p.hardSeq;
      else forceNext.current = true;
    }
    const done = () => {
      forceNext.current = false;
      hardSeen.current = p.hardSeq;
    };

    if (!p.playing) {
      if (!v.paused) v.pause();
      if (v.playbackRate !== p.rate) v.playbackRate = p.rate;
      corr.current = initialCorr();
      const off = Math.abs(p.position - v.currentTime);
      if (!v.seeking && off > EPS && (forceNext.current || wall - lastSeekWall.current > 400)) {
        seekTo(v, p.position);
        done();
      } else if (off <= EPS && forceNext.current) done();
      setStatus('paused');
      return;
    }

    const wait = p.at - serverNow;
    if (wait > 30) {
      // Scheduled start: park on the right frame, everyone presses play at the same server instant.
      if (!v.paused) v.pause();
      v.playbackRate = p.rate;
      corr.current = initialCorr();
      if (!v.seeking && Math.abs(v.currentTime - p.position) > EPS) seekTo(v, p.position);
      done();
      setStatus('starting');
      startTimer.current = setTimeout(run, wait);
      return;
    }

    const exp = expectedPosition(p, serverNow);
    if (Number.isFinite(v.duration) && exp >= v.duration - 0.05) {
      if (!v.paused) v.pause();
      setStatus('ended');
      return;
    }

    if (v.paused) {
      // Start / resume at the right place (also self-heals if something else paused us, e.g. PiP or media keys).
      if (!v.seeking && Math.abs(v.currentTime - exp) > 0.1) seekTo(v, exp + seekLatency.current);
      v.playbackRate = p.rate;
      corr.current = initialCorr();
      done();
      tryPlay();
      setStatus('starting');
      return;
    }

    // Playing: detect stalls, then plan one gentle correction around the room's intended speed.
    const t = v.currentTime;
    const pr = progress.current;
    if (!pr || wall - pr.wall > cfg.stallMs * 3) progress.current = { t, wall };
    else if (wall - pr.wall >= cfg.stallMs) {
      stalled.current = isStalled(pr, { t, wall }, v.playbackRate);
      progress.current = { t, wall };
    }
    const unplayable = v.readyState < 3 || v.seeking || stalled.current;
    const d = exp - t;
    const plan = planTick({ drift: d, baseRate: p.rate, state: corr.current, now: wall, playable: !unplayable, force: forceNext.current, cfg });
    corr.current = plan.state;
    if (plan.action === 'seek') {
      seekTo(v, exp + seekLatency.current);
      done();
    } else if (Math.abs(v.playbackRate - plan.rate) > 1e-4) v.playbackRate = plan.rate;
    setDrift(Math.round(d * 10) / 10);
    setStatus(unplayable ? 'buffering' : plan.action === 'seek' ? 'catching-up' : plan.status === 'holding' ? 'buffering' : plan.status);
  }, [error, seekTo, tryPlay]);

  // react to new room state, readiness and a new local file
  useEffect(run, [pb, ready, run]);
  useEffect(() => {
    hardSeen.current = live.current.api.getRoom()?.playback.hardSeq ?? pb.hardSeq;
    forceNext.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room.epoch]);
  useEffect(() => {
    corr.current = initialCorr();
    stalled.current = false;
    progress.current = undefined;
    setError(false);
    setBlocked(false);
    setCur(0);
    setDur(0);
  }, [file.url]);

  // one loop per player; cleaned up on unmount
  useEffect(() => {
    const t = setInterval(run, cfg.tickMs);
    const onVis = () => !document.hidden && run();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      clearInterval(t);
      clearTimeout(startTimer.current);
      clearTimeout(hideTimer.current);
      clearTimeout(seekTimer.current);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [run]);

  // ---------------------------------------------------------------- actions
  const denied = useCallback(() => {
    if (Date.now() - lastDenied.current < 2500) return;
    lastDenied.current = Date.now();
    live.current.toast('Only the owner or a controller can change playback.', 'warn');
  }, []);

  const report = useCallback((r: CmdResult) => {
    if (!r.ok) live.current.toast(r.error === 'stale' ? 'The room just changed — try again.' : r.message, r.error === 'stale' ? 'info' : 'error');
  }, []);

  const guard = useCallback((): HTMLVideoElement | null => {
    const L = live.current;
    if (!L.canControl) return (denied(), null);
    if (!L.ready) return (L.toast('Tap “I’m ready” first.', 'info'), null);
    return vref.current;
  }, [denied]);

  const togglePlay = useCallback(() => {
    const v = guard();
    if (!v) return;
    const playing = (live.current.api.getRoom() ?? live.current.room).playback.playing;
    void (playing ? live.current.api.pause(v.currentTime) : live.current.api.play(v.currentTime)).then(report);
  }, [guard, report]);

  /** Seek to an absolute position; rapid key repeats are merged into one command. */
  const seekAbs = useCallback(
    (t: number, delay = 140) => {
      const v = guard();
      if (!v) return;
      const max = Number.isFinite(v.duration) ? v.duration : t;
      pendingSeek.current = Math.min(Math.max(0, t), max);
      setScrub(pendingSeek.current);
      clearTimeout(seekTimer.current);
      seekTimer.current = setTimeout(() => {
        const target = pendingSeek.current;
        pendingSeek.current = null;
        setScrub(null);
        if (target !== null) void live.current.api.seek(target).then(report);
      }, delay);
    },
    [guard, report],
  );
  const seekBy = useCallback((d: number) => seekAbs((pendingSeek.current ?? vref.current?.currentTime ?? 0) + d), [seekAbs]);

  const syncMe = useCallback(async () => {
    const L = live.current;
    if (!L.ready) return L.toast('Tap “I’m ready” first.', 'info');
    await L.api.refresh(); // never correct against a stale view
    forceNext.current = true;
    run();
    L.toast('Synced to the room', 'info');
  }, [run]);

  const syncAll = useCallback(async () => {
    const v = vref.current;
    if (!v) return;
    const r = await live.current.api.hardSyncAll(v.currentTime);
    r.ok ? live.current.toast('Everyone is synced to you', 'info') : report(r);
  }, [report]);

  const fullscreen = useCallback(() => {
    const el = theater.current;
    const v = vref.current;
    if (document.fullscreenElement) void document.exitFullscreen();
    else if (el?.requestFullscreen) void el.requestFullscreen().catch(() => {});
    else (v as (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | null)?.webkitEnterFullscreen?.(); // iPhone
  }, [theater]);

  const togglePip = useCallback(async () => {
    const v = vref.current;
    if (!v || !document.pictureInPictureEnabled) return live.current.toast('Picture-in-picture isn’t available here.', 'info');
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await v.requestPictureInPicture();
    } catch {
      live.current.toast('Couldn’t open picture-in-picture.', 'warn');
    }
  }, []);

  const cycleRate = () => {
    if (!canControl) return denied();
    const next = RATES[(RATES.indexOf(pb.rate) + 1) % RATES.length] ?? 1;
    void api.setRate(next).then(report);
  };

  const poke = useCallback(() => {
    setUi(true);
    clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setUi(false), 3200);
  }, []);

  async function handleReady() {
    const v = vref.current;
    if (!v) return;
    try {
      v.muted = true; // the tap that says "ready" also unlocks autoplay for this element
      await v.play();
    } catch {
      /* fine — the "tap to join" overlay covers the rare refusal */
    }
    v.pause();
    v.muted = muted;
    v.currentTime = 0;
    props.onReady();
  }

  async function joinNow() {
    setBlocked(false);
    try {
      await vref.current?.play();
    } catch {
      /* ignore */
    }
    run();
  }

  // ---------------------------------------------------------------- effects: volume, fullscreen, PiP, captions
  useEffect(() => {
    const v = vref.current;
    if (v) ((v.muted = muted), (v.volume = vol));
    setStored('muted', muted ? '1' : '0');
    setStored('vol', String(vol));
  }, [muted, vol]);
  useEffect(() => setStored('cc', ccOn ? '1' : '0'), [ccOn]);

  useEffect(() => {
    const onFs = () => setIsFs(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onFs);
    const v = vref.current;
    const onEnter = () => setPip(true);
    const onLeave = () => setPip(false);
    v?.addEventListener('enterpictureinpicture', onEnter);
    v?.addEventListener('leavepictureinpicture', onLeave);
    return () => {
      document.removeEventListener('fullscreenchange', onFs);
      v?.removeEventListener('enterpictureinpicture', onEnter);
      v?.removeEventListener('leavepictureinpicture', onLeave);
    };
  }, []);

  // Shared captions: held in memory, rendered by this browser's own player. Follows the local timeline automatically.
  useEffect(() => {
    const v = vref.current;
    if (!v) return;
    let tt = trackRef.current;
    if (!tt) tt = trackRef.current = v.addTextTrack('subtitles', 'Shared captions', 'en');
    tt.mode = 'hidden'; // cues can only be edited while the track is not disabled
    while (tt.cues && tt.cues.length) tt.removeCue(tt.cues[0]!);
    if (captions) {
      for (const c of captions.cues) {
        try {
          tt.addCue(new VTTCue(c.s, c.e, c.t));
        } catch {
          /* skip a cue the browser rejects */
        }
      }
    }
    tt.mode = captions && ccOn ? 'showing' : 'hidden';
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [captions?.meta.hash, file.url]);
  useEffect(() => {
    if (trackRef.current) trackRef.current.mode = captions && ccOn ? 'showing' : 'hidden';
  }, [ccOn, captions]);

  // ---------------------------------------------------------------- keyboard
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const L = live.current;
      if (e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented || isTyping(e.target)) return;
      const el = e.target as HTMLElement | null;
      const k = e.key;
      if (k === 'Escape') return void (menu !== 'none' && setMenu('none'));
      if (k === '?') return (e.preventDefault(), L.onHelp());
      if (L.helpOpen) return;
      if ((k === ' ' || k === 'Enter') && (el?.tagName === 'BUTTON' || el?.tagName === 'A')) return; // let the focused control activate
      const volStep = (d: number) => (setMuted(false), setVol((x) => Math.min(1, Math.max(0, Math.round((x + d) * 20) / 20))));
      let handled = true;
      switch (k) {
        case 'k': case 'K': case ' ': togglePlay(); break;
        case 'h': case 'H': case 'ArrowLeft': seekBy(-SEEK.short); break;
        case 'j': case 'J': seekBy(-SEEK.long); break;
        case 'l': case 'L': case 'ArrowRight': seekBy(SEEK.short); break;
        case ';': seekBy(SEEK.long); break;
        case '[': seekBy(-SEEK.big); break;
        case ']': seekBy(SEEK.big); break;
        case '0': case 'Home': seekAbs(0, 0); break;
        case '$': case 'End': seekAbs((vref.current?.duration ?? 0) - 0.5, 0); break;
        case 'f': case 'F': fullscreen(); break;
        case 'c': case 'C': setCcOn((x) => !x); break;
        case 'm': case 'M': setMuted((x) => !x); break;
        case '+': case '=': volStep(0.1); break;
        case '-': case '_': volStep(-0.1); break;
        case 'p': case 'P': void togglePip(); break;
        case '\\': void syncMe(); break;
        case '|': setMenu(L.canSyncAll ? 'confirm' : 'menu'); break;
        default: handled = false;
      }
      if (handled) e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [togglePlay, seekBy, seekAbs, fullscreen, togglePip, syncMe, menu]);

  // ---------------------------------------------------------------- derived UI
  const shown = scrub ?? cur;
  const chip: PlayerStatus = status;
  const chipTone = !connected ? 'warn' : chip === 'synced' ? 'ok' : chip === 'struggling' ? 'bad' : chip === 'paused' || chip === 'ended' ? 'idle' : 'warn';
  const chipText = !connected ? 'Reconnecting…' : STATUS_TEXT[chip];
  const overlayChip = !connected || ['buffering', 'catching-up', 'starting', 'struggling'].includes(chip);
  const ownerFile = owner?.file;
  const wrongVideo = !!me?.file && !!ownerFile && !isOwner && compareFiles(me.file, ownerFile) === 'mismatch';
  const canPip = useMemo(() => typeof document !== 'undefined' && !!document.pictureInPictureEnabled, []);

  return (
    <div
      className={'player' + (showUi ? ' ui' : '') + (isFs ? ' fs' : '')}
      onPointerMove={poke}
      onPointerDown={(e) => ((pointerType.current = e.pointerType), poke())}
    >
      <video
        ref={vref}
        src={file.url}
        playsInline
        preload="auto"
        onClick={() => pointerType.current === 'mouse' && ready && togglePlay()}
        onDoubleClick={fullscreen}
        onLoadedMetadata={(e) => (setDur(e.currentTarget.duration), props.onMeta(e.currentTarget.duration))}
        onTimeUpdate={(e) => setCur(e.currentTarget.currentTime)}
        onError={() => setError(true)}
        onSeeked={() => {
          if (seekStart.current) seekLatency.current = Math.min(0.6, 0.5 * seekLatency.current + 0.5 * ((performance.now() - seekStart.current) / 1000));
          seekStart.current = 0;
          run();
        }}
        onWaiting={run}
        onPlaying={run}
        onCanPlay={run}
        onPause={run}
      />
      {props.children}

      {error && (
        <div className="overlay">
          <div className="card-lite">
            <Icon name="alert" size={26} />
            <h3>This browser can’t play that file</h3>
            <p>Usually an unsupported codec (MKV / AVI / HEVC). Convert once, then load the new file:</p>
            <code onClick={() => void navigator.clipboard?.writeText(FFMPEG)}>{FFMPEG}</code>
          </div>
        </div>
      )}

      {!error && !ready && (
        <div className="overlay">
          <button className="btn primary big" onClick={handleReady} disabled={!dur}>
            {dur ? 'I’m ready' : 'Reading file…'}
          </button>
          <p className="muted small">Tap once so your browser allows synced playback</p>
        </div>
      )}

      {ready && blocked && (
        <div className="overlay">
          <button className="btn primary big" onClick={joinNow}>
            Tap to join playback
          </button>
        </div>
      )}

      {ready && !error && overlayChip && !blocked && <div className={'chip floating ' + chipTone}>{chipText}</div>}
      {wrongVideo && ready && <div className="chip floating warn right">This looks like a different video than {owner?.name}’s</div>}
      {capStatus === 'failed' && (
        <button className="chip floating warn right low" onClick={props.api.retryCaptions}>
          Captions couldn’t load — retry
        </button>
      )}

      {ready && !error && (
        <div className="controls" onPointerDown={(e) => e.stopPropagation()}>
          <div className="seek">
            <input
              type="range"
              min="0"
              max={dur || 0}
              step="0.1"
              value={shown}
              disabled={!canControl}
              aria-label="Seek"
              style={{ ['--p' as string]: dur ? (shown / dur) * 100 + '%' : '0%' }}
              onChange={(e) => setScrub(Number(e.target.value))}
              onPointerUp={() => scrub !== null && seekAbs(scrub, 0)}
              onKeyDown={(e) => e.key.startsWith('Arrow') && e.preventDefault()}
            />
          </div>
          <div className="row">
            <button className="ic" onClick={() => seekBy(-SEEK.long)} disabled={!canControl} aria-label={`Back ${SEEK.long} seconds`} title={`Back ${SEEK.long}s (J)`}>
              <Icon name="back" />
            </button>
            <button className="ic main" onClick={togglePlay} disabled={!canControl} aria-label={pb.playing ? 'Pause' : 'Play'} title="Play / pause (K)">
              <Icon name={pb.playing ? 'pause' : 'play'} size={24} />
            </button>
            <button className="ic" onClick={() => seekBy(SEEK.long)} disabled={!canControl} aria-label={`Forward ${SEEK.long} seconds`} title={`Forward ${SEEK.long}s (;)`}>
              <Icon name="fwd" />
            </button>
            <span className="time">
              {fmtTime(shown)} <i>/</i> {fmtTime(dur)}
            </span>
            {!canControl && (
              <span className="lock" title="Only the owner and controllers can change playback">
                <Icon name="lock" size={15} /> <span>view only</span>
              </span>
            )}
            <span className="grow" />
            <span className={'chip ' + chipTone} title={pb.playing ? `Your player is ${Math.abs(drift).toFixed(1)}s ${drift > 0 ? 'behind' : 'ahead of'} the room` : ''}>
              {chipText}
            </span>
            <button className="ic text" onClick={cycleRate} aria-label="Playback speed" title={canControl ? 'Playback speed (shared)' : 'Speed is set by the owner/controllers'}>
              {pb.rate}×
            </button>
            <div className="menu-anchor">
              <button className={'ic' + (menu !== 'none' ? ' on' : '')} onClick={() => setMenu(menu === 'none' ? 'menu' : 'none')} aria-label="Hard Sync" aria-haspopup="dialog" title="Hard Sync ( \ )">
                <Icon name="sync" size={19} />
              </button>
              {menu !== 'none' && (
                <SyncMenu
                  canSyncAll={canSyncAll}
                  isOwner={isOwner}
                  others={others}
                  position={vref.current?.currentTime ?? 0}
                  startConfirm={menu === 'confirm'}
                  onSyncMe={() => void syncMe()}
                  onSyncAll={() => void syncAll()}
                  onClose={() => setMenu('none')}
                />
              )}
            </div>
            {(captions || capStatus === 'loading') && (
              <button className={'ic' + (ccOn && captions ? ' on' : '')} onClick={() => setCcOn(!ccOn)} disabled={!captions} aria-label="Captions" aria-pressed={ccOn} title="Captions (C)">
                <Icon name="cc" />
              </button>
            )}
            <button className="ic" onClick={() => setMuted(!muted)} aria-label={muted ? 'Unmute' : 'Mute'} title="Mute (M)">
              <Icon name={muted || vol === 0 ? 'mute' : 'volume'} />
            </button>
            <input
              className="vol"
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={muted ? 0 : vol}
              aria-label="Volume"
              style={{ ['--p' as string]: (muted ? 0 : vol) * 100 + '%' }}
              onChange={(e) => (setVol(Number(e.target.value)), setMuted(false))}
            />
            {canPip && !file.audio && (
              <button className={'ic' + (pip ? ' on' : '')} onClick={() => void togglePip()} aria-label="Picture in picture" title="Picture-in-picture (P)">
                <Icon name="pip" />
              </button>
            )}
            <button className="ic" onClick={props.onHelp} aria-label="Keyboard shortcuts" title="Shortcuts (?)">
              <Icon name="keyboard" />
            </button>
            <button className="ic" onClick={fullscreen} aria-label="Fullscreen" title="Fullscreen (F)">
              <Icon name="full" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
