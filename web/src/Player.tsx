import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { getStored, setStored } from './api.js';
import Controls from './Controls.js';
import { DEFAULT_SYNC, compareFiles, expectedPosition, fmtTime, initialCorr, isStalled, planTick } from './engine.js';
import { clampZoom, seekFromDrag, volumeFromDrag, type GestureEvent } from './gestures.js';
import { SEEK } from './Help.js';
import { useCoarsePointer, useElementWidth, useWakeLock } from './hooks.js';
import Icon from './Icon.js';
import { planControls, type CtrlId } from './layout.js';
import { YT_SYNC, htmlAdapter, youtubeAdapter, type MediaAdapter } from './media.js';
import type { CaptionData, CmdResult, RoomSnapshot } from './protocol.js';
import SettingsSheet, { type CapSize } from './SettingsSheet.js';
import Sheet from './Sheet.js';
import SyncMenu from './SyncMenu.js';
import { useGestures } from './useGestures.js';
import type { CapStatus, RoomApi, ToastKind } from './useRoom.js';
import { YT_STATE, errorText, issueFromError, loadYouTubeApi, type YtPlayerLike } from './youtube.js';

export interface LocalFile {
  url: string;
  name: string;
  size: number;
  audio: boolean;
}

export type Source = { kind: 'file'; file: LocalFile } | { kind: 'youtube'; videoId: string; startAt: number };

type PlayerStatus = 'synced' | 'catching-up' | 'struggling' | 'buffering' | 'starting' | 'paused' | 'ended';
type SheetName = 'none' | 'sync' | 'confirm' | 'settings';

interface Props {
  source: Source;
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
  /** Landscape phones: the room panel lives in a drawer opened from here. */
  onPeople?: () => void;
  /** Shown on a YouTube error to people allowed to load another video. */
  onChangeMedia?: () => void;
  toast: (text: string, kind?: ToastKind) => void;
  children?: ReactNode;
}

const FFMPEG = 'ffmpeg -i input.mkv -c:v libx264 -c:a aac -movflags +faststart output.mp4';
const EPS = 0.05;
/** Buttons and double-tap step. Keyboard keeps its own 5/15/60 s steps. */
export const TAP_STEP = 10;

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

const buzz = (ms: number) => {
  try {
    navigator.vibrate?.(ms);
  } catch {
    /* unsupported */
  }
};

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

export default function Player(props: Props) {
  const { source, room, meId, connected, captions, capStatus, ready, api, theater } = props;
  const isYt = source.kind === 'youtube';
  const file = source.kind === 'file' ? source.file : null;
  const pb = room.playback;
  const me = room.members.find((m) => m.id === meId);
  const owner = room.members.find((m) => m.id === room.ownerId);
  const isOwner = room.ownerId === meId;
  const canControl = !!me?.canControl;
  const canSyncAll = isOwner || (canControl && room.settings.controllersCanSyncAll);
  const others = room.members.filter((m) => m.online && m.id !== meId && (isYt || m.file)).length;
  const touch = useCoarsePointer();

  const vref = useRef<HTMLVideoElement>(null);
  const ytWrap = useRef<HTMLDivElement>(null);
  const gest = useRef<HTMLDivElement>(null);
  const trackRef = useRef<TextTrack | null>(null);
  const adapter = useRef<MediaAdapter | null>(null);
  const fileAdapter = useMemo(() => htmlAdapter(() => vref.current), []);
  const [playerRef, playerWidth] = useElementWidth<HTMLDivElement>();

  const [nativeYt, setNativeYt] = useState(() => getStored('ytnative') === '1');
  const [muted, setMuted] = useState(() => getStored('muted') === '1');
  const [vol, setVol] = useState(() => {
    const sv = getStored('vol');
    return sv === null || Number.isNaN(Number(sv)) ? 1 : clamp01(Number(sv));
  });
  const [ccOn, setCcOn] = useState(() => getStored('cc') !== '0');
  const [ytCc, setYtCc] = useState(() => getStored('ytcc') === '1');
  const [ytLang, setYtLang] = useState(() => getStored('ytlang') ?? '');
  const [ytTracks, setYtTracks] = useState<{ code: string; name: string }[]>([]);
  const [capSize, setCapSize] = useState<CapSize>(() => (['S', 'M', 'L'].includes(getStored('capsize') ?? '') ? (getStored('capsize') as CapSize) : 'M'));
  const [capBg, setCapBg] = useState(() => getStored('capbg') !== '0');
  const [fit, setFit] = useState<'contain' | 'cover'>(() => (getStored('fit') === 'cover' ? 'cover' : 'contain'));

  const live = useRef({ ...props, canControl, canSyncAll, nativeYt, muted, vol });
  live.current = { ...props, canControl, canSyncAll, nativeYt, muted, vol };

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
  const own = useRef(0); // last time WE told the media to play/pause/seek (to tell it apart from the viewer using YouTube's own controls)
  const nativeSeekSent = useRef(0);
  const fatal = useRef(false);
  const reportedIssue = useRef<string | null>(null);

  const [cur, setCur] = useState(source.kind === 'youtube' ? source.startAt : 0);
  const [dur, setDur] = useState(0);
  const [buf, setBuf] = useState(0);
  const [scrub, setScrub] = useState<number | null>(null);
  const [status, setStatus] = useState<PlayerStatus>('paused');
  const [drift, setDrift] = useState(0);
  const [ui, setUi] = useState(true);
  const [blocked, setBlocked] = useState(false);
  const [error, setError] = useState(false);
  const [ytState, setYtState] = useState<'loading' | 'ready' | 'failed'>(isYt ? 'loading' : 'ready');
  const [ytError, setYtError] = useState<number | null>(null);
  const [ytLive, setYtLive] = useState(false);
  const [ytTitle, setYtTitle] = useState('');
  const [ytTry, setYtTry] = useState(0);
  const [ad, setAd] = useState(false);
  const [sheet, setSheet] = useState<SheetName>('none');
  const [isFs, setIsFs] = useState(false);
  const [pip, setPip] = useState(false);
  const [locked, setLocked] = useState(false);
  const [unlockShown, setUnlockShown] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [seekHud, setSeekHud] = useState<{ side: 'left' | 'right'; secs: number } | null>(null);
  const [volHud, setVolHud] = useState<number | null>(null);
  const [scrubHud, setScrubHud] = useState<{ t: number; d: number } | null>(null);
  const [zoomHud, setZoomHud] = useState<number | null>(null);

  const kindOk = isYt ? ytState === 'ready' : true;
  const showUi = ui || !pb.playing || scrub !== null || sheet !== 'none' || blocked || nativeYt;
  const hasMedia = isYt ? !ytError && !ytLive && ytState === 'ready' : !error;

  // ---------------------------------------------------------------- sync loop
  const seekTo = useCallback((a: MediaAdapter, t: number) => {
    a.seek(t);
    seekStart.current = lastSeekWall.current = own.current = performance.now();
    progress.current = undefined;
    stalled.current = false;
  }, []);

  const tryPlay = useCallback((a: MediaAdapter) => {
    own.current = performance.now();
    a.play().catch((e: Error) => e?.name === 'NotAllowedError' && setBlocked(true));
  }, []);

  const run = useCallback(() => {
    const a = adapter.current;
    const L = live.current;
    if (!a || !L.ready || fatal.current) return;
    const yt = a.kind === 'youtube';
    const cfg = yt ? YT_SYNC : DEFAULT_SYNC;
    const snap = L.api.getRoom() ?? L.room; // freshest accepted state, not whatever React last rendered
    const p = snap.playback;
    const serverNow = L.api.serverNow();
    const wall = performance.now();
    clearTimeout(startTimer.current);

    // A third-party ad is on screen: hold everything, never fight it.
    if (a.ad()) {
      setAd(true);
      setStatus('buffering');
      return;
    }
    setAd(false);

    // Owner-level Hard Sync: a new hardSeq makes every viewer except the issuer hard-seek once.
    if (p.hardSeq !== hardSeen.current) {
      if (p.by === L.meId) hardSeen.current = p.hardSeq;
      else forceNext.current = true;
    }
    const done = () => {
      forceNext.current = false;
      hardSeen.current = p.hardSeq;
    };
    const setRateIfNeeded = (r: number) => {
      if (Math.abs(a.rate() - a.snapRate(r)) > 1e-4) a.setRate(r);
    };

    /** YouTube's own controls were used to jump: a controller's jump is shared, anyone else's is undone below. */
    const nativeJump = (pos: number, tol: number): boolean => {
      if (!(yt && L.nativeYt && L.canControl)) return false;
      if (wall - own.current < 3000 || wall - nativeSeekSent.current < 2000 || Math.abs(a.time() - pos) < tol) return false;
      nativeSeekSent.current = wall;
      void L.api.seek(a.time());
      return true;
    };

    if (!p.playing) {
      if (a.running()) {
        own.current = wall;
        a.pause();
      }
      setRateIfNeeded(p.rate);
      corr.current = initialCorr();
      const off = Math.abs(p.position - a.time());
      if (nativeJump(p.position, 1.5)) return;
      if (!a.seeking() && off > a.pausedEps && (forceNext.current || wall - lastSeekWall.current > 400)) {
        seekTo(a, p.position);
        done();
      } else if (off <= a.pausedEps && forceNext.current) done();
      setStatus('paused');
      return;
    }

    const wait = p.at - serverNow;
    if (wait > 30) {
      // Scheduled start: park on the right frame, everyone presses play at the same server instant.
      if (a.running()) {
        own.current = wall;
        a.pause();
      }
      setRateIfNeeded(p.rate);
      corr.current = initialCorr();
      if (!a.seeking() && Math.abs(a.time() - p.position) > Math.max(EPS, a.pausedEps)) seekTo(a, p.position);
      done();
      setStatus('starting');
      startTimer.current = setTimeout(run, wait);
      return;
    }

    const exp = expectedPosition(p, serverNow);
    const d0 = a.duration();
    if (d0 > 0 && exp >= d0 - 0.05) {
      if (a.running()) {
        own.current = wall;
        a.pause();
      }
      setStatus('ended');
      return;
    }

    if (!a.running()) {
      // Start / resume at the right place (also self-heals if something else paused us, e.g. PiP or media keys).
      if (!a.seeking() && Math.abs(a.time() - exp) > (yt ? 0.5 : 0.1)) seekTo(a, exp + seekLatency.current);
      setRateIfNeeded(p.rate);
      corr.current = initialCorr();
      done();
      tryPlay(a);
      setStatus('starting');
      return;
    }

    // Playing: detect stalls, then plan one gentle correction around the room's intended speed.
    const t = a.time();
    if (nativeJump(exp, 2.5)) return;
    const pr = progress.current;
    if (!pr || wall - pr.wall > cfg.stallMs * 3) progress.current = { t, wall };
    else if (wall - pr.wall >= cfg.stallMs) {
      stalled.current = isStalled(pr, { t, wall }, a.rate());
      progress.current = { t, wall };
    }
    const unplayable = !a.playable() || a.seeking() || stalled.current;
    const d = exp - t;
    const plan = planTick({ drift: d, baseRate: p.rate, state: corr.current, now: wall, playable: !unplayable, force: forceNext.current, cfg });
    corr.current = plan.state;
    if (plan.action === 'seek') {
      seekTo(a, exp + seekLatency.current);
      done();
    } else setRateIfNeeded(a.canNudge ? plan.rate : p.rate);
    setDrift(Math.round(d * 10) / 10);
    setStatus(unplayable ? 'buffering' : plan.action === 'seek' ? 'catching-up' : plan.status === 'holding' ? 'buffering' : plan.status);
  }, [seekTo, tryPlay]);

  // react to new room state and readiness
  useEffect(run, [pb, ready, run, ytState]);
  useEffect(() => {
    hardSeen.current = live.current.api.getRoom()?.playback.hardSeq ?? pb.hardSeq;
    forceNext.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room.epoch]);

  // one loop per player; cleaned up on unmount
  useEffect(() => {
    const cfg = isYt ? YT_SYNC : DEFAULT_SYNC;
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
  }, [run, isYt]);

  // position / duration / buffered for the UI (YouTube has no time events, so this polls for both kinds)
  useEffect(() => {
    const t = setInterval(() => {
      const a = adapter.current;
      if (!a || document.hidden) return;
      setCur(a.time());
      const d = a.duration();
      setDur((p) => (p === d ? p : d));
      setBuf(a.buffered());
      if (isYt) {
        try {
          const title = ytPlayer.current?.getVideoData?.().title;
          if (title) setYtTitle((p) => (p === title ? p : title));
        } catch {
          /* ignore */
        }
      }
    }, 250);
    return () => clearInterval(t);
  }, [isYt]);

  // ---------------------------------------------------------------- local file adapter
  useEffect(() => {
    if (source.kind !== 'file') return;
    adapter.current = fileAdapter;
    seekLatency.current = fileAdapter.seekGuess;
    return () => {
      if (adapter.current === fileAdapter) adapter.current = null;
    };
  }, [source.kind, fileAdapter]);

  // ---------------------------------------------------------------- YouTube adapter
  const ytPlayer = useRef<YtPlayerLike | null>(null);
  const videoId = source.kind === 'youtube' ? source.videoId : '';
  useEffect(() => {
    if (!videoId) return;
    let alive = true;
    let player: YtPlayerLike | null = null;
    setYtState('loading');
    setYtError(null);
    setYtLive(false);
    fatal.current = false;
    adapter.current = null;
    loadYouTubeApi()
      .then((YT) => {
        const wrap = ytWrap.current;
        if (!alive || !wrap) return;
        const holder = document.createElement('div');
        wrap.replaceChildren(holder);
        const startPos = Math.floor(live.current.api.getRoom()?.playback.position ?? 0);
        player = new YT.Player(holder, {
          host: 'https://www.youtube-nocookie.com',
          videoId,
          width: '100%',
          height: '100%',
          playerVars: {
            controls: nativeYt ? 1 : 0,
            disablekb: nativeYt ? 0 : 1,
            playsinline: 1,
            rel: 0,
            modestbranding: 1,
            fs: 0,
            iv_load_policy: 3,
            start: startPos,
            enablejsapi: 1,
            origin: location.origin,
          },
          events: {
            onReady: (e) => {
              if (!alive) return;
              ytPlayer.current = e.target;
              const a = youtubeAdapter(e.target, { videoId });
              a.setVolume(live.current.vol, live.current.muted);
              seekLatency.current = a.seekGuess;
              adapter.current = a;
              let isLive = false;
              try {
                isLive = !!e.target.getVideoData?.().isLive;
              } catch {
                /* ignore */
              }
              if (isLive) {
                fatal.current = true;
                setYtLive(true);
                live.current.api.setMediaIssue('live');
              }
              setYtState('ready');
            },
            onStateChange: (e) => {
              if (!alive) return;
              const L = live.current;
              if (L.nativeYt && L.canControl && L.ready && performance.now() - own.current > 1500) {
                const playing = L.api.getRoom()?.playback.playing;
                const a = adapter.current;
                if (a && e.data === YT_STATE.PAUSED && playing) return void L.api.pause(a.time());
                if (a && e.data === YT_STATE.PLAYING && playing === false) return void L.api.play(a.time());
              }
              run();
            },
            onError: (e) => {
              if (!alive) return;
              fatal.current = true;
              setYtError(e.data);
              live.current.api.setMediaIssue(issueFromError(e.data));
            },
          },
        });
      })
      .catch(() => {
        if (!alive) return;
        setYtState('failed');
        live.current.api.setMediaIssue('unavailable');
      });
    return () => {
      alive = false;
      adapter.current = null;
      ytPlayer.current = null;
      try {
        player?.destroy();
      } catch {
        /* iframe already gone */
      }
      ytWrap.current?.replaceChildren();
    };
    // run is stable; nativeYt / ytTry deliberately recreate the player
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoId, nativeYt, ytTry]);

  /** YouTube captions through the player's captions module. Safe to call any time; does nothing until the player exists. */
  const applyYtCc = useCallback((on: boolean, lang: string) => {
    const pl = ytPlayer.current;
    if (!pl) return;
    try {
      if (!on) return void pl.unloadModule?.('captions');
      pl.loadModule?.('captions');
      setTimeout(() => {
        try {
          const raw = pl.getOption?.('captions', 'tracklist');
          const list = (Array.isArray(raw) ? raw : []) as { languageCode?: string; languageName?: string; displayName?: string }[];
          const tracks = list.filter((t) => t.languageCode).map((t) => ({ code: t.languageCode as string, name: t.displayName || t.languageName || (t.languageCode as string) }));
          setYtTracks(tracks);
          const code = tracks.some((t) => t.code === lang) ? lang : tracks[0]?.code;
          if (code) pl.setOption?.('captions', 'track', { languageCode: code });
          else live.current.toast('This video has no captions.', 'info');
        } catch {
          /* captions module unavailable */
        }
      }, 700);
    } catch {
      /* ignore */
    }
  }, []);
  const toggleYtCc = (on: boolean) => {
    setYtCc(on);
    setStored('ytcc', on ? '1' : '0');
    applyYtCc(on, ytLang);
  };
  const pickYtLang = (code: string) => {
    setYtLang(code);
    setStored('ytlang', code);
    setYtCc(true);
    setStored('ytcc', '1');
    applyYtCc(true, code);
  };
  // after the player is ready (and each new video), restore the viewer's captions choice
  useEffect(() => {
    if (isYt && ytState === 'ready' && ytCc) applyYtCc(true, ytLang);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ytState, videoId]);

  // ---------------------------------------------------------------- actions
  const denied = useCallback(() => {
    if (Date.now() - lastDenied.current < 2500) return;
    lastDenied.current = Date.now();
    live.current.toast('Only the owner or a controller can change playback.', 'warn');
  }, []);

  const report = useCallback((r: CmdResult) => {
    if (!r.ok) live.current.toast(r.error === 'stale' ? 'The room just changed — try again.' : r.message, r.error === 'stale' ? 'info' : 'error');
  }, []);

  const guard = useCallback((): MediaAdapter | null => {
    const L = live.current;
    if (!L.canControl) return (denied(), null);
    if (!L.ready) return (L.toast('Tap “I’m ready” first.', 'info'), null);
    return adapter.current;
  }, [denied]);

  const togglePlay = useCallback(() => {
    const a = guard();
    if (!a) return;
    const playing = (live.current.api.getRoom() ?? live.current.room).playback.playing;
    void (playing ? live.current.api.pause(a.time()) : live.current.api.play(a.time())).then(report);
  }, [guard, report]);

  /** Seek to an absolute position; rapid repeats (key presses, double-taps) are merged into one command. */
  const seekAbs = useCallback(
    (t: number, delay = 140) => {
      const a = guard();
      if (!a) return;
      const d = a.duration();
      pendingSeek.current = Math.min(Math.max(0, t), d > 0 ? d : t);
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
  const seekBy = useCallback((d: number, delay = 140) => seekAbs((pendingSeek.current ?? adapter.current?.time() ?? 0) + d, delay), [seekAbs]);

  const syncMe = useCallback(async () => {
    const L = live.current;
    if (!L.ready) return L.toast('Tap “I’m ready” first.', 'info');
    await L.api.refresh(); // never correct against a stale view
    forceNext.current = true;
    run();
    L.toast('Synced to the room', 'info');
  }, [run]);

  const syncAll = useCallback(async () => {
    const a = adapter.current;
    if (!a) return;
    const r = await live.current.api.hardSyncAll(a.time());
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

  const setRate = (r: number) => {
    if (!canControl) return denied();
    void api.setRate(r).then(report);
  };
  const cycleRate = () => {
    const rates = adapter.current?.rates() ?? [1];
    const i = rates.findIndex((x) => Math.abs(x - pb.rate) < 1e-6);
    setRate(rates[(i + 1) % rates.length] ?? 1);
  };

  const poke = useCallback(() => {
    setUi(true);
    clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setUi(false), 3200);
  }, []);

  async function handleReady() {
    const a = adapter.current;
    if (!a) return;
    try {
      a.setVolume(vol, true); // the tap that says "ready" also unlocks autoplay for this player
      await a.play();
    } catch {
      /* fine — the "tap to join" overlay covers the rare refusal */
    }
    own.current = performance.now();
    a.pause();
    a.setVolume(vol, muted);
    if (a.kind === 'file') a.seek(0);
    props.onReady();
  }

  async function joinNow() {
    setBlocked(false);
    try {
      await adapter.current?.play();
    } catch {
      /* ignore */
    }
    run();
  }

  // ---------------------------------------------------------------- effects: volume, fullscreen, PiP, captions, device features
  useEffect(() => {
    adapter.current?.setVolume(vol, muted);
    setStored('muted', muted ? '1' : '0');
    setStored('vol', String(vol));
  }, [muted, vol, ytState]);
  useEffect(() => setStored('cc', ccOn ? '1' : '0'), [ccOn]);
  useEffect(() => setStored('capsize', capSize), [capSize]);
  useEffect(() => setStored('capbg', capBg ? '1' : '0'), [capBg]);
  useEffect(() => setStored('fit', fit), [fit]);
  useEffect(() => setStored('ytnative', nativeYt ? '1' : '0'), [nativeYt]);

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

  // Phones: fullscreen turns the screen sideways (and back). Silently skipped where the browser doesn't allow it.
  useEffect(() => {
    const o = (screen as Screen & { orientation?: { lock?: (t: string) => Promise<void>; unlock?: () => void } }).orientation;
    if (!touch || !o?.lock) return;
    if (isFs) o.lock('landscape').catch(() => {});
    else
      try {
        o.unlock?.();
      } catch {
        /* ignore */
      }
  }, [isFs, touch]);

  useWakeLock(ready && pb.playing);

  // Notification-shade / lock-screen / headset controls (local files; YouTube's iframe owns its own session).
  useEffect(() => {
    if (!file || !('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    try {
      ms.metadata = new MediaMetadata({ title: file.name, artist: 'Watch Together' });
      ms.setActionHandler('play', () => togglePlay());
      ms.setActionHandler('pause', () => togglePlay());
      ms.setActionHandler('seekbackward', () => seekBy(-TAP_STEP));
      ms.setActionHandler('seekforward', () => seekBy(TAP_STEP));
      ms.setActionHandler('seekto', (d) => d.seekTime != null && seekAbs(d.seekTime, 0));
    } catch {
      /* partial support */
    }
    return () => {
      try {
        for (const k of ['play', 'pause', 'seekbackward', 'seekforward', 'seekto'] as const) ms.setActionHandler(k, null);
      } catch {
        /* ignore */
      }
    };
  }, [file, togglePlay, seekBy, seekAbs]);
  useEffect(() => {
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = pb.playing ? 'playing' : 'paused';
  }, [pb.playing]);

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
  }, [captions?.meta.hash, file?.url]);
  useEffect(() => {
    if (trackRef.current) trackRef.current.mode = captions && ccOn ? 'showing' : 'hidden';
  }, [ccOn, captions]);

  // ---------------------------------------------------------------- gestures (touch)
  const volStart = useRef(1);
  const scrubStart = useRef<{ t: number; ok: boolean }>({ t: 0, ok: false });
  const zoomBase = useRef(1);
  const hudTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const tapAccum = useRef<{ side: 'left' | 'right'; secs: number; at: number } | null>(null);
  const hud = (key: string, fn: () => void, ms: number) => {
    clearTimeout(hudTimers.current[key]);
    hudTimers.current[key] = setTimeout(fn, ms);
  };
  useEffect(() => () => Object.values(hudTimers.current).forEach(clearTimeout), []);

  const onGesture = (e: GestureEvent) => {
    const a = adapter.current;
    if (!a || locked) return;
    switch (e.type) {
      case 'tap':
        if (ui && pb.playing) setUi(false);
        else poke();
        break;
      case 'doubletap': {
        if (e.zone === 'center') {
          buzz(8);
          togglePlay();
          break;
        }
        if (!canControl || !ready) return void guard();
        const side = e.zone;
        const now = Date.now();
        const acc = tapAccum.current;
        const secs = acc && acc.side === side && now - acc.at < 900 ? acc.secs + TAP_STEP : TAP_STEP;
        tapAccum.current = { side, secs, at: now };
        seekBy(side === 'left' ? -TAP_STEP : TAP_STEP, 450);
        setSeekHud({ side, secs });
        hud('seek', () => setSeekHud(null), 700);
        buzz(10);
        break;
      }
      case 'vol-start':
        volStart.current = live.current.muted ? 0 : live.current.vol;
        break;
      case 'vol': {
        const v = Math.round(volumeFromDrag(volStart.current, e.frac) * 50) / 50;
        setVol(v);
        setMuted(false);
        setVolHud(v);
        break;
      }
      case 'vol-end':
        hud('vol', () => setVolHud(null), 600);
        break;
      case 'scrub-start':
        scrubStart.current = { t: pendingSeek.current ?? a.time(), ok: canControl && ready && a.duration() > 0 };
        if (!canControl) denied();
        break;
      case 'scrub': {
        const s = scrubStart.current;
        if (!s.ok) break;
        const t = seekFromDrag(s.t, e.dx, e.width, a.duration());
        setScrub(t);
        setScrubHud({ t, d: t - s.t });
        break;
      }
      case 'scrub-end': {
        const s = scrubStart.current;
        setScrubHud(null);
        if (!s.ok) break;
        if (e.cancelled) setScrub(null);
        else if (scrub !== null) seekAbs(scrub, 0);
        break;
      }
      case 'pinch': {
        if (isYt) break;
        const z = Math.min(3.5, Math.max(0.9, zoomBase.current * e.scale));
        setZoom(z);
        setZoomHud(z);
        break;
      }
      case 'pinch-end': {
        if (isYt) break;
        const z = clampZoom(zoomBase.current * e.scale);
        zoomBase.current = z;
        setZoom(z);
        hud('zoom', () => setZoomHud(null), 600);
        break;
      }
    }
  };
  const gesturesOn = hasMedia && ready && !ad && !nativeYt && !locked && !error;
  useGestures(gest, onGesture, gesturesOn);

  // ---------------------------------------------------------------- keyboard
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const L = live.current;
      if (e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented || isTyping(e.target)) return;
      const el = e.target as HTMLElement | null;
      const k = e.key;
      if (k === 'Escape') return;
      if (k === '?') return (e.preventDefault(), L.onHelp());
      if (L.helpOpen || sheet !== 'none') return;
      if ((k === ' ' || k === 'Enter') && (el?.tagName === 'BUTTON' || el?.tagName === 'A')) return; // let the focused control activate
      const volStep = (d: number) => (setMuted(false), setVol((x) => clamp01(Math.round((x + d) * 20) / 20)));
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
        case '$': case 'End': seekAbs((adapter.current?.duration() ?? 0) - 0.5, 0); break;
        case 'f': case 'F': fullscreen(); break;
        case 'c': case 'C': isYt ? toggleYtCc(!ytCc) : setCcOn((x) => !x); break;
        case 'm': case 'M': setMuted((x) => !x); break;
        case '+': case '=': case 'ArrowUp': volStep(0.1); break;
        case '-': case '_': case 'ArrowDown': volStep(-0.1); break;
        case 'p': case 'P': if (!isYt) void togglePip(); break;
        case '\\': void syncMe(); break;
        case '|': setSheet(L.canSyncAll ? 'confirm' : 'sync'); break;
        default: handled = false;
      }
      if (handled) e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [togglePlay, seekBy, seekAbs, fullscreen, togglePip, syncMe, sheet, isYt, ytCc, ytLang]);

  // ---------------------------------------------------------------- derived UI
  const shown = scrub ?? cur;
  const chip: PlayerStatus = status;
  const chipTone = !connected ? 'warn' : chip === 'synced' ? 'ok' : chip === 'struggling' ? 'bad' : chip === 'paused' || chip === 'ended' ? 'idle' : 'warn';
  const chipText = !connected ? 'Reconnecting…' : STATUS_TEXT[chip];
  const overlayChip = !connected || ['buffering', 'catching-up', 'starting', 'struggling'].includes(chip);
  const ownerFile = owner?.file;
  const wrongVideo = !isYt && !!me?.file && !!ownerFile && !isOwner && compareFiles(me.file, ownerFile) === 'mismatch';
  const canPip = useMemo(() => typeof document !== 'undefined' && !!document.pictureInPictureEnabled, []);
  const hasCaptionsUi = isYt || !!captions || capStatus === 'loading';
  const timeChars = `${fmtTime(dur)} / ${fmtTime(dur)}`.length;
  const has: Partial<Record<CtrlId, boolean>> = { cc: hasCaptionsUi, pip: !isYt && canPip && !file?.audio };
  const plan = useMemo(
    () => planControls({ width: playerWidth || 360, touch, centerCluster: touch, timeChars, has }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [playerWidth, touch, timeChars, hasCaptionsUi, isYt, canPip, file?.audio],
  );
  const title = file ? file.name : ytTitle || 'YouTube video';
  const driftText = pb.playing ? `Your player is ${Math.abs(drift).toFixed(1)}s ${drift > 0 ? 'behind' : 'ahead of'} the room` : '';
  const rates = adapter.current?.rates() ?? [0.5, 0.75, 1, 1.25, 1.5, 2];
  const rateLabel = pb.rate;
  const resetZoom = () => ((zoomBase.current = 1), setZoom(1));
  const waiting = isYt ? ytState !== 'ready' : false;

  return (
    <div
      ref={playerRef}
      className={'player' + (showUi ? ' ui' : '') + (isFs ? ' fs' : '') + (touch ? ' touch' : '') + (isYt ? ' yt' : '') + (nativeYt ? ' native' : '') + (ad ? ' ad' : '')}
      data-size={playerWidth < 380 ? 'xs' : playerWidth < 560 ? 'sm' : playerWidth < 860 ? 'md' : 'lg'}
      onPointerMove={(e) => e.pointerType === 'mouse' && poke()}
      onPointerDown={(e) => ((pointerType.current = e.pointerType), e.pointerType === 'mouse' && poke())}
    >
      {file && (
        <video
          ref={vref}
          src={file.url}
          playsInline
          preload="auto"
          className={`cs-${capSize}${capBg ? '' : ' cbg-off'}`}
          style={{ objectFit: fit, transform: zoom !== 1 ? `scale(${zoom})` : undefined }}
          onLoadedMetadata={(e) => (setDur(e.currentTarget.duration), props.onMeta(e.currentTarget.duration))}
          onTimeUpdate={(e) => setCur(e.currentTarget.currentTime)}
          onError={() => (fatal.current = true, setError(true))}
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
      )}
      {isYt && <div ref={ytWrap} className="yt-wrap" />}
      {props.children}

      {/* gesture / click surface above the media (below the controls) */}
      <div
        ref={gest}
        className={'gest' + (gesturesOn || (hasMedia && ready && !nativeYt && !ad) ? ' on' : '')}
        onPointerDown={(e) => (pointerType.current = e.pointerType)}
        onClick={() => {
          if (pointerType.current === 'mouse' && ready) togglePlay();
        }}
        onDoubleClick={() => pointerType.current === 'mouse' && fullscreen()}
      />

      {/* feedback while gesturing */}
      {seekHud && (
        <div className={'ripple ' + seekHud.side} aria-hidden>
          <span>
            <Icon name={seekHud.side === 'left' ? 'back' : 'fwd'} size={30} />
            {seekHud.side === 'left' ? '−' : '+'}
            {seekHud.secs} s
          </span>
        </div>
      )}
      {volHud !== null && (
        <div className="vhud" aria-hidden>
          <Icon name={volHud === 0 ? 'mute' : 'volume'} size={20} />
          <div className="vbar">
            <i style={{ height: volHud * 100 + '%' }} />
          </div>
          <b>{Math.round(volHud * 100)}</b>
        </div>
      )}
      {scrubHud && (
        <div className="shud" aria-hidden>
          {fmtTime(scrubHud.t)}
          <small>
            {scrubHud.d >= 0 ? '+' : '−'}
            {Math.round(Math.abs(scrubHud.d))} s
          </small>
        </div>
      )}
      {zoomHud !== null && (
        <div className="zhud" aria-hidden>
          {zoomHud.toFixed(1)}×
        </div>
      )}

      {/* top bar (not over YouTube's own controls) */}
      {!nativeYt && (
        <div className="topbar" onPointerDown={(e) => e.stopPropagation()}>
          <span className="ttl" title={title}>
            {title}
          </span>
          {props.onPeople && (
            <button className="ic" onClick={props.onPeople} aria-label="People and room">
              <Icon name="users" />
            </button>
          )}
        </div>
      )}
      {nativeYt && (
        <div className="nativebar" onPointerDown={(e) => e.stopPropagation()}>
          <span className={'chip ' + chipTone}>{chipText}</span>
          <span className="grow" />
          <button className="linkbtn light" onClick={() => setNativeYt(false)}>
            Use Watch Together controls
          </button>
          <button className="ic" onClick={() => setSheet('sync')} aria-label="Hard Sync">
            <Icon name="sync" size={19} />
          </button>
          <button className="ic" onClick={() => setSheet('settings')} aria-label="Settings">
            <Icon name="settings" />
          </button>
          {props.onPeople && (
            <button className="ic" onClick={props.onPeople} aria-label="People and room">
              <Icon name="users" />
            </button>
          )}
        </div>
      )}

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

      {isYt && ytState === 'failed' && (
        <div className="overlay">
          <div className="card-lite">
            <Icon name="alert" size={26} />
            <h3>Can’t reach YouTube</h3>
            <p>Check your connection (or any blocker that hides YouTube), then try again.</p>
            <button className="btn" onClick={() => setYtTry((n) => n + 1)}>
              Try again
            </button>
          </div>
        </div>
      )}
      {isYt && ytError !== null && (
        <div className="overlay">
          <div className="card-lite">
            <Icon name="alert" size={26} />
            <h3>This video can’t play here</h3>
            <p>{errorText(ytError)}</p>
            {props.onChangeMedia ? (
              <button className="btn" onClick={props.onChangeMedia}>
                Choose another video
              </button>
            ) : (
              <p className="small">Ask someone who can load videos to pick a different one.</p>
            )}
          </div>
        </div>
      )}
      {isYt && ytLive && (
        <div className="overlay">
          <div className="card-lite">
            <Icon name="alert" size={26} />
            <h3>Live streams can’t be synced</h3>
            <p>A live stream has no fixed timeline. Pick a normal video instead.</p>
            {props.onChangeMedia && (
              <button className="btn" onClick={props.onChangeMedia}>
                Choose another video
              </button>
            )}
          </div>
        </div>
      )}

      {hasMedia && !ready && (
        <div className="overlay">
          <button className="btn primary big" onClick={handleReady} disabled={isYt ? waiting : !dur}>
            {isYt ? (waiting ? 'Loading YouTube…' : 'I’m ready') : dur ? 'I’m ready' : 'Reading file…'}
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

      {ready && hasMedia && overlayChip && !blocked && !ad && !nativeYt && <div className={'chip floating ' + chipTone}>{chipText}</div>}
      {ready && ad && <div className="chip floating warn">Ad playing — sync resumes after it</div>}
      {wrongVideo && ready && <div className="chip floating warn right">This looks like a different video than {owner?.name}’s</div>}
      {capStatus === 'failed' && !isYt && (
        <button className="chip floating warn right low" onClick={props.api.retryCaptions}>
          Captions couldn’t load — retry
        </button>
      )}

      {ready && hasMedia && !nativeYt && !ad && !locked && kindOk && (
        <Controls
          inline={plan.inline}
          touch={touch}
          cluster={touch}
          playing={pb.playing}
          canControl={canControl}
          cur={shown}
          dur={dur}
          buffered={buf}
          rate={rateLabel}
          muted={muted}
          vol={vol}
          statusText={chipText}
          statusTone={chipTone}
          driftText={driftText}
          ccOn={isYt ? ytCc : ccOn}
          hasCaptions={isYt || !!captions}
          pip={pip}
          seekStep={TAP_STEP}
          onPlay={togglePlay}
          onBack={() => seekBy(-TAP_STEP, 300)}
          onFwd={() => seekBy(TAP_STEP, 300)}
          onRate={cycleRate}
          onSync={() => setSheet('sync')}
          onCc={() => (isYt ? toggleYtCc(!ytCc) : setCcOn(!ccOn))}
          onMute={() => setMuted(!muted)}
          onVol={(v) => (setVol(v), setMuted(false))}
          onPip={() => void togglePip()}
          onSettings={() => setSheet('settings')}
          onFull={fullscreen}
          onPreview={(t) => setScrub(t)}
          onCommit={(t) => (setScrub(null), seekAbs(t, 0))}
          onCancel={() => setScrub(null)}
          onDenied={denied}
        />
      )}

      {locked && (
        <div className="lockveil" onPointerDown={() => (setUnlockShown(true), hud('unlock', () => setUnlockShown(false), 2600))}>
          {unlockShown && (
            <button
              className="btn"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => {
                setLocked(false);
                setUnlockShown(false);
                poke();
              }}
            >
              <Icon name="unlock" size={17} /> Unlock controls
            </button>
          )}
        </div>
      )}

      {(sheet === 'sync' || sheet === 'confirm') && (
        <Sheet title="Hard Sync" onClose={() => setSheet('none')}>
          <SyncMenu
            canSyncAll={canSyncAll}
            isOwner={isOwner}
            others={others}
            position={adapter.current?.time() ?? 0}
            startConfirm={sheet === 'confirm'}
            onSyncMe={() => void syncMe()}
            onSyncAll={() => void syncAll()}
            onClose={() => setSheet('none')}
          />
        </Sheet>
      )}
      {sheet === 'settings' && (
        <SettingsSheet
          kind={source.kind}
          touch={touch}
          canControl={canControl}
          rate={pb.rate}
          rates={rates}
          onRate={setRate}
          hasCaptions={!!captions}
          ccOn={ccOn}
          onCc={setCcOn}
          ytCc={ytCc}
          onYtCc={toggleYtCc}
          ytTracks={ytTracks}
          ytLang={ytLang}
          onYtLang={pickYtLang}
          capSize={capSize}
          onCapSize={setCapSize}
          capBg={capBg}
          onCapBg={setCapBg}
          fit={fit}
          onFit={(f) => (setFit(f), resetZoom())}
          canPip={canPip && !file?.audio}
          pip={pip}
          onPip={() => void togglePip()}
          nativeYt={nativeYt}
          onNativeYt={(on) => (setNativeYt(on), setYtState('loading'))}
          statusText={chipText}
          drift={pb.playing ? drift : null}
          rtt={null}
          onHardSync={() => setSheet('sync')}
          onLock={() => (setLocked(true), setUi(false))}
          onHelp={props.onHelp}
          onClose={() => setSheet('none')}
        />
      )}
    </div>
  );
}
