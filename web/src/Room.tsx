import { useCallback, useEffect, useRef, useState } from 'react';
import { copyText } from './api.js';
import { readSubtitleFile } from './captions.js';
import Help from './Help.js';
import Icon from './Icon.js';
import Members, { summary } from './Members.js';
import Player, { type LocalFile } from './Player.js';
import type { RoomApi, ToastKind } from './useRoom.js';
import { useRoom } from './useRoom.js';
import ThemeToggle from './ThemeToggle.js';
import type { Theme } from './theme.js';
import Toasts, { type ToastItem } from './Toasts.js';

const AUDIO = /\.(mp3|m4a|aac|ogg|opus|flac|wav)$/i;
const MEDIA = /\.(mp4|m4v|mkv|webm|mov|avi|ogv|3gp|mp3|m4a|aac|ogg|opus|flac|wav)$/i;

function useFileDrop(onFiles: (f: File[]) => void) {
  const [dragging, setDragging] = useState(false);
  const cb = useRef(onFiles);
  cb.current = onFiles;
  useEffect(() => {
    let depth = 0;
    const has = (e: DragEvent) => !!e.dataTransfer?.types?.includes('Files');
    const enter = (e: DragEvent) => has(e) && (e.preventDefault(), depth++, setDragging(true));
    const over = (e: DragEvent) => has(e) && e.preventDefault();
    const leave = (e: DragEvent) => has(e) && --depth <= 0 && ((depth = 0), setDragging(false));
    const drop = (e: DragEvent) => {
      if (!has(e)) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      cb.current([...(e.dataTransfer?.files ?? [])]);
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragover', over);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragover', over);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', drop);
    };
  }, []);
  return dragging;
}

function Message({ icon = 'alert', title, text, onLeave }: { icon?: 'alert' | 'lock'; title: string; text: string; onLeave: () => void }) {
  return (
    <div className="center-screen">
      <div className="card-lite">
        <Icon name={icon} size={28} />
        <h3>{title}</h3>
        <p>{text}</p>
        <button className="btn" onClick={onLeave}>
          Back to start
        </button>
      </div>
    </div>
  );
}

interface Props {
  roomId: string;
  name: string;
  theme: Theme;
  onTheme: () => void;
  onLeave: () => void;
  onRename: (n: string) => void;
}

export default function Room({ roomId, name, theme, onTheme, onLeave, onRename }: Props) {
  const theaterRef = useRef<HTMLDivElement>(null);
  const apiRef = useRef<RoomApi | null>(null);
  const mediaInput = useRef<HTMLInputElement>(null);
  const capInput = useRef<HTMLInputElement>(null);
  const fileRef = useRef<LocalFile | null>(null);
  const toastId = useRef(0);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());

  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [file, setFile] = useState<LocalFile | null>(null);
  const [ready, setReady] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [copied, setCopied] = useState('');
  const [slow, setSlow] = useState(false);
  const [nameDraft, setNameDraft] = useState(name);
  const [confirmClose, setConfirmClose] = useState(false);
  fileRef.current = file;

  const toast = useCallback((text: string, kind: ToastKind = 'info') => {
    setToasts((cur) => (cur.some((t) => t.text === text) ? cur : [...cur.slice(-2), { id: ++toastId.current, text, kind }]));
    const t = setTimeout(() => {
      timers.current.delete(t);
      setToasts((cur) => cur.filter((x) => x.text !== text));
    }, kind === 'error' ? 5200 : 3200);
    timers.current.add(t);
  }, []);

  const getPlayback = useCallback(() => {
    const v = theaterRef.current?.querySelector('video');
    const pb = apiRef.current?.getRoom()?.playback;
    return { position: v ? v.currentTime : (pb?.position ?? 0), playing: v ? !v.paused : false, rate: pb?.rate ?? 1 };
  }, []);

  const r = useRoom(roomId, name, { onToast: toast, getPlayback });
  const { room, status, api } = r;
  apiRef.current = api;

  useEffect(() => {
    const t = setTimeout(() => setSlow(true), 5000);
    const tm = timers.current;
    return () => {
      clearTimeout(t);
      tm.forEach(clearTimeout);
      if (fileRef.current) URL.revokeObjectURL(fileRef.current.url);
    };
  }, []);

  // "?" opens the guide when no player is mounted (the player handles it otherwise); Escape closes it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      const typing = !!el && (el.isContentEditable || el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && !['range', 'checkbox', 'radio', 'button'].includes((el as HTMLInputElement).type)));
      if (e.key === 'Escape' && helpOpen) return setHelpOpen(false);
      if (e.key === '?' && !typing && !fileRef.current) (e.preventDefault(), setHelpOpen((o) => !o));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [helpOpen]);

  const me = room?.members.find((m) => m.id === r.clientId);
  const canControl = !!me?.canControl;

  const importCaptions = useCallback(
    async (f: File) => {
      if (!canControl) return toast('Only the owner or a controller can share captions.', 'warn');
      const parsed = await readSubtitleFile(f);
      if (!parsed.ok) return toast(parsed.message, 'error');
      const res = await api.setCaptions(f.name, parsed.cues);
      if (!res.ok) return toast(res.message, 'error');
      if (res.duplicate) toast('Those captions are already shared.', 'info');
      else if (parsed.skipped) toast(`Shared ${parsed.cues.length} lines (${parsed.skipped} unreadable ones skipped).`, 'info');
    },
    [api, canControl, toast],
  );

  const loadFiles = useCallback(
    (list: File[]) => {
      const media = list.find((f) => f.type.startsWith('video/') || f.type.startsWith('audio/') || MEDIA.test(f.name));
      const subs = list.filter((f) => /\.(srt|vtt)$/i.test(f.name));
      if (!media && !subs.length) return toast('That doesn’t look like a video, audio or caption file.', 'warn');
      if (media) {
        if (fileRef.current) URL.revokeObjectURL(fileRef.current.url);
        setFile({ url: URL.createObjectURL(media), name: media.name, size: media.size, audio: media.type.startsWith('audio/') || AUDIO.test(media.name) });
        setReady(false);
        api.setFile(null); // announced again once the duration is known
      }
      if (subs[0]) void importCaptions(subs[0]);
    },
    [api, importCaptions, toast],
  );
  const dragging = useFileDrop(loadFiles);

  if (status === 'noserver') return <Message title="No sync server configured" text="Set VITE_SERVER_URL to your deployed server URL (see README), then redeploy." onLeave={onLeave} />;
  if (status === 'notfound') return <Message title="Room not found" text={`There’s no room “${roomId}”. It may have expired, or the code has a typo.`} onLeave={onLeave} />;
  if (status === 'full') return <Message title="Room is full" text="This room already has the maximum number of people." onLeave={onLeave} />;
  if (status === 'closed') return <Message icon="lock" title="You’ve left this room" text={r.closedReason || 'The room was closed.'} onLeave={onLeave} />;
  if (status === 'error') return <Message title="Couldn’t join" text="Something went wrong. Try again." onLeave={onLeave} />;
  if (!room)
    return (
      <div className="center-screen">
        <div className="spinner" />
        <p className="muted">{slow ? 'Waking the server up — free hosting sleeps when idle, this can take up to a minute…' : 'Joining room…'}</p>
      </div>
    );

  const isOwner = room.ownerId === r.clientId;
  const sum = summary(room, r.clientId);
  const link = `${location.origin}/?r=${roomId}`;
  const power = room.settings.controllerPower;
  const connected = status === 'connected';

  const copy = async (what: string, text: string) => {
    if (await copyText(text)) {
      setCopied(what);
      setTimeout(() => setCopied(''), 1600);
    }
  };
  const act = (p: Promise<{ ok: boolean; message?: string }>) => void p.then((x) => !x.ok && toast(x.message ?? 'That didn’t work.', 'error'));

  return (
    <div className="room">
      <header className="bar">
        <div className="brand">
          <span className="logo">▶</span>
          <b>Watch Together</b>
        </div>
        <div className="bar-right">
          {!connected && <span className="chip warn">{status === 'waiting-room' ? 'Waiting for the room…' : 'Reconnecting…'}</span>}
          {connected && r.rtt != null && <span className="pill hide-sm" title="Round-trip to the sync server">{r.rtt} ms</span>}
          {me && <span className={'role ' + me.role}>{me.role === 'owner' ? 'Owner' : me.role === 'controller' ? 'Controller' : 'Viewer'}</span>}
          <button className="btn ghost sq" onClick={() => setHelpOpen(true)} aria-label="Keyboard shortcuts" title="Keyboard shortcuts (?)">
            <Icon name="keyboard" size={17} />
          </button>
          <ThemeToggle theme={theme} onToggle={onTheme} />
          <button
            className="btn ghost"
            onClick={() => {
              api.leave();
              onLeave();
            }}
          >
            <Icon name="leave" size={16} /> <span className="hide-sm">Leave</span>
          </button>
        </div>
      </header>

      <main className="layout">
        <section className="stage">
          <div className="theater" ref={theaterRef}>
            {file ? (
              <Player
                file={file}
                room={room}
                meId={r.clientId}
                connected={connected}
                captions={r.captions}
                capStatus={r.capStatus}
                ready={ready}
                api={api}
                theater={theaterRef}
                helpOpen={helpOpen}
                onReady={() => (setReady(true), api.setReady(true))}
                onMeta={(duration) => api.setFile({ name: file.name, size: file.size, duration })}
                onHelp={() => setHelpOpen((o) => !o)}
                toast={toast}
              >
                {file.audio && (
                  <div className="audio-art">
                    <Icon name="film" size={40} />
                    <span>{file.name}</span>
                  </div>
                )}
              </Player>
            ) : (
              <button className="drop" onClick={() => mediaInput.current?.click()}>
                <Icon name="upload" size={34} />
                <strong>Drop a video here</strong>
                <span>or tap to choose a file</span>
                <small>Everyone loads their own copy — nothing is uploaded. You can drop a .srt or .vtt too.</small>
              </button>
            )}
            <Toasts items={toasts} />
            {helpOpen && <Help onClose={() => setHelpOpen(false)} />}
          </div>

          <input ref={mediaInput} type="file" hidden accept="video/*,audio/*,.mkv,.avi" onChange={(e) => (loadFiles([...(e.target.files ?? [])]), (e.target.value = ''))} />
          <input ref={capInput} type="file" hidden accept=".srt,.vtt" onChange={(e) => (e.target.files?.[0] && void importCaptions(e.target.files[0]), (e.target.value = ''))} />

          {file && (
            <div className="filebar">
              <span title={file.name}>{file.name}</span>
              <button className="linkbtn" onClick={() => mediaInput.current?.click()}>
                change file
              </button>
            </div>
          )}
          <div className="filebar capbar">
            <span>
              <Icon name="cc" size={15} />{' '}
              {room.captions ? (
                <>
                  <b title={room.captions.name}>{room.captions.name}</b> · {room.captions.cues.toLocaleString()} lines · shared by {room.members.find((m) => m.id === room.captions?.by)?.name ?? 'someone'}
                  {r.capStatus === 'loading' && ' · loading…'}
                </>
              ) : (
                'No shared captions'
              )}
            </span>
            {canControl ? (
              <span className="inline">
                <button className="linkbtn" onClick={() => capInput.current?.click()}>
                  {room.captions ? 'replace' : 'add captions'}
                </button>
                {room.captions && (
                  <button className="linkbtn" onClick={() => act(api.clearCaptions())}>
                    remove
                  </button>
                )}
              </span>
            ) : (
              <span className="hint-inline">{power || isOwner ? 'owner/controllers can add captions' : ''}</span>
            )}
          </div>
        </section>

        <aside className="side">
          <div className="panel">
            <div className="label">Room code</div>
            <div className="code">{roomId}</div>
            <div className="row2">
              <button className="btn" onClick={() => void copy('link', link)}>
                <Icon name={copied === 'link' ? 'check' : 'copy'} size={16} /> {copied === 'link' ? 'Copied' : 'Copy invite link'}
              </button>
              <button className="btn ghost" onClick={() => void copy('code', roomId)}>
                {copied === 'code' ? 'Copied' : 'Copy code'}
              </button>
            </div>
          </div>

          <div className="panel">
            <div className="label between">
              <span>In the room · {room.members.filter((m) => m.online).length}</span>
              <span className={'tag ' + sum.c}>{sum.t}</span>
            </div>
            <Members room={room} meId={r.clientId} api={api} onError={(t) => toast(t, 'error')} />
            {isOwner && room.members.length > 1 && <p className="hint">You’re the owner. Flip “controller” on to let a friend play, pause, seek and share captions.</p>}
          </div>

          {isOwner ? (
            <div className="panel">
              <div className="label">Room controls</div>
              <label className="setting">
                <span>
                  <b>Controller power</b>
                  <small>{power ? 'Controllers can play, pause, seek and share captions.' : 'Off — controllers act like viewers. Only you control the room.'}</small>
                </span>
                <span className="switch">
                  <input type="checkbox" checked={power} onChange={(e) => act(api.setSettings({ controllerPower: e.target.checked }))} />
                  <span />
                </span>
              </label>
              <label className="setting">
                <span>
                  <b>Controllers can sync everyone</b>
                  <small>Lets controllers use “Sync everyone to me”. Off by default.</small>
                </span>
                <span className="switch">
                  <input type="checkbox" checked={room.settings.controllersCanSyncAll} onChange={(e) => act(api.setSettings({ controllersCanSyncAll: e.target.checked }))} />
                  <span />
                </span>
              </label>
              {!confirmClose ? (
                <button className="linkbtn danger" onClick={() => setConfirmClose(true)}>
                  Close room for everyone…
                </button>
              ) : (
                <div className="confirm inline">
                  <b>Close this room for everyone?</b>
                  <div className="row2">
                    <button className="btn" onClick={() => setConfirmClose(false)}>
                      Cancel
                    </button>
                    <button className="btn danger" onClick={() => act(api.closeRoom())}>
                      Close room
                    </button>
                  </div>
                </div>
              )}
            </div>
          ) : (
            me?.role === 'controller' &&
            !power && (
              <div className="panel note">
                <Icon name="lock" size={16} /> The owner has paused controller power. You can watch and use your own controls.
              </div>
            )
          )}

          <div className="panel">
            <label className="label" htmlFor="nm">
              Your name
            </label>
            <input
              id="nm"
              className="field"
              value={nameDraft}
              maxLength={24}
              onChange={(e) => setNameDraft(e.target.value)}
              onBlur={() => {
                const n = nameDraft.trim();
                if (n && n !== name) (onRename(n), api.rename(n));
              }}
              onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
            />
          </div>
        </aside>
      </main>

      {dragging && (
        <div className="dropveil">
          <Icon name="upload" size={42} />
          <strong>Drop to load</strong>
        </div>
      )}
    </div>
  );
}
