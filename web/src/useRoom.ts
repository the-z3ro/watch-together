import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { SERVER, getClientId, uid, type Sock } from './api.js';
import { measureOffset } from './engine.js';
import { judgeSnapshot } from './versions.js';
import type { CaptionCue, CaptionData, CaptionMeta, CmdResult, Command, CommandBody, FileInfo, RoomSnapshot } from './protocol.js';

export type Status =
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'waiting-room' // server restarted; waiting for the owner to bring the room back
  | 'notfound'
  | 'full'
  | 'closed'
  | 'noserver'
  | 'error';

export type ToastKind = 'info' | 'warn' | 'error';
export type CapStatus = 'idle' | 'loading' | 'failed';

interface Options {
  onToast: (text: string, kind: ToastKind) => void;
  /** Used to re-create the room at the right place after a server restart (owner only). */
  getPlayback: () => { position: number; playing: boolean; rate: number };
}

/** Owns the socket for one room: ordered snapshots, idempotent commands, caption recovery, reconnect/restart handling. */
export function useRoom(roomId: string, name: string, opts: Options) {
  const [status, setStatus] = useState<Status>(SERVER ? 'connecting' : 'noserver');
  const [closedReason, setClosedReason] = useState('');
  const [room, setRoom] = useState<RoomSnapshot | null>(null);
  const [captions, setCaptions] = useState<CaptionData | null>(null);
  const [capStatus, setCapStatus] = useState<CapStatus>('idle');
  const [rtt, setRtt] = useState<number | null>(null);
  const clientId = useMemo(getClientId, []);

  const sockRef = useRef<Sock | null>(null);
  const offsetRef = useRef(0); // serverTime − localTime (ms)
  const ver = useRef({ epoch: '', rev: 0 });
  const roomRef = useRef<RoomSnapshot | null>(null);
  const capsRef = useRef<CaptionData | null>(null);
  const me = useRef<{ name: string; file: FileInfo | null; ready: boolean }>({ name, file: null, ready: false });
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const fetchCaps = useRef<(hash: string, attempt?: number) => void>(() => {});

  /** Accept a snapshot only if it is newer than what we have (rev), or from a new room incarnation (epoch). */
  const applySnapshot = useCallback((snap: RoomSnapshot): boolean => {
    const cur = ver.current;
    const verdict = judgeSnapshot(cur, snap);
    if (verdict === 'stale') return false; // delayed, duplicate or plain heartbeat: never roll state back
    if (verdict === 'new-epoch') {
      ver.current = { epoch: snap.epoch, rev: snap.rev };
      capsRef.current = null;
      setCaptions(null);
    } else {
      cur.rev = snap.rev;
    }
    roomRef.current = snap;
    setRoom(snap);
    const meta: CaptionMeta | null = snap.captions;
    if (!meta) {
      if (capsRef.current) ((capsRef.current = null), setCaptions(null));
      setCapStatus('idle');
    } else if (capsRef.current?.meta.hash !== meta.hash) {
      fetchCaps.current(meta.hash);
    }
    return true;
  }, []);

  useEffect(() => {
    if (!SERVER) return;
    let alive = true;
    let ended = false;
    let everJoined = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let waitingSince = 0;
    const s: Sock = io(SERVER);
    sockRef.current = s;

    const toast = (t: string, k: ToastKind) => optsRef.current.onToast(t, k);

    const resync = async (n: number) => {
      const m = await measureOffset((cb) => s.emit('ping:time', cb), n);
      if (m && alive) {
        offsetRef.current = m.offset;
        setRtt(Math.round(m.rtt));
      }
    };

    const setCaps = (d: CaptionData | null) => {
      capsRef.current = d;
      setCaptions(d);
      setCapStatus('idle');
    };

    fetchCaps.current = (hash, attempt = 0) => {
      if (!alive || !s.connected) return;
      setCapStatus('loading');
      let answered = false;
      const timer = setTimeout(() => !answered && retry(), 5000);
      const retry = () => {
        if (attempt < 3) setTimeout(() => alive && roomRef.current?.captions?.hash === hash && fetchCaps.current(hash, attempt + 1), 600 * 2 ** attempt);
        else setCapStatus('failed');
      };
      s.emit('captions:get', hash, (d) => {
        if (answered) return;
        answered = true;
        clearTimeout(timer);
        if (!alive || roomRef.current?.captions?.hash !== hash) return; // superseded meanwhile
        d && d.meta.hash === hash ? setCaps(d) : retry();
      });
    };

    const join = () => {
      s.emit('room:join', { roomId, clientId, name: me.current.name }, (r) => {
        if (!alive) return;
        if (!r.ok) {
          if (r.error === 'full') return setStatus('full');
          if (r.error === 'bad_request') return setStatus('error');
          return onNotFound();
        }
        everJoined = true;
        waitingSince = 0;
        applySnapshot(r.snapshot);
        if (r.captions) setCaps(r.captions);
        setStatus('connected');
        s.emit('member:update', { file: me.current.file, ready: me.current.ready });
        void resync(6);
      });
    };

    /** Room missing: either never existed, or the server restarted / room expired while we were in it. */
    const onNotFound = () => {
      if (!everJoined) return setStatus('notfound');
      const wasOwner = roomRef.current?.ownerId === clientId;
      if (wasOwner) {
        // Bring the same code back at the position we are at, then rejoin as usual.
        const restore = optsRef.current.getPlayback();
        s.emit('room:create', { clientId, name: me.current.name, roomId, restore }, (c) => {
          if (!alive) return;
          if (c.ok) {
            const keep = capsRef.current;
            join();
            if (keep) {
              const cmd: Command = { id: uid(), type: 'captions:set', name: keep.meta.name, cues: keep.cues };
              setTimeout(() => alive && s.emit('cmd', cmd, () => {}), 600);
            }
            toast('The server restarted — room restored', 'info');
          } else retryJoin();
        });
      } else retryJoin();
    };

    const retryJoin = () => {
      waitingSince ||= Date.now();
      if (Date.now() - waitingSince > 3 * 60_000) return setStatus('notfound');
      setStatus('waiting-room');
      retryTimer = setTimeout(() => alive && s.connected && join(), 3000);
    };

    s.on('connect', () => {
      clearTimeout(retryTimer);
      join();
    });
    s.on('disconnect', () => alive && !ended && setStatus((p) => (p === 'connected' || p === 'waiting-room' ? 'reconnecting' : p)));
    s.on('room:state', (snap) => alive && applySnapshot(snap));
    s.on('captions:data', (d) => {
      if (!alive) return;
      if (d === null) return setCaps(null);
      if (capsRef.current && d.meta.v < capsRef.current.meta.v) return; // older track arriving late
      setCaps(d);
    });
    s.on('notice', (t, kind) => alive && toast(t, kind));
    s.on('room:closed', (reason) => {
      if (!alive) return;
      ended = true;
      setClosedReason(reason);
      setStatus('closed');
      s.close();
    });
    const t = setInterval(() => s.connected && void resync(3), 30_000);

    return () => {
      alive = false;
      clearInterval(t);
      clearTimeout(retryTimer);
      s.removeAllListeners();
      s.close();
      sockRef.current = null;
    };
  }, [roomId, clientId, applySnapshot]);

  /** Send a command with a unique id; retried once on timeout (safe: the server de-duplicates by id). */
  const send = useCallback(
    (body: CommandBody): Promise<CmdResult> =>
      new Promise((resolve) => {
        const s = sockRef.current;
        if (!s?.connected) return resolve({ ok: false, error: 'not_in_room', message: 'Reconnecting…' });
        const cmd = { id: uid(), ...body } as Command;
        let done = false;
        let tries = 0;
        const attempt = () => {
          tries++;
          const timer = setTimeout(() => {
            if (done) return;
            if (tries < 2 && s.connected) return attempt();
            done = true;
            resolve({ ok: false, error: 'not_in_room', message: 'The server did not answer.' });
          }, 4000);
          s.emit('cmd', cmd, (r) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            if (!r.ok && r.snapshot) applySnapshot(r.snapshot); // snap back to the truth
            resolve(r);
          });
        };
        attempt();
      }),
    [applySnapshot],
  );

  const serverNow = useCallback(() => Date.now() + offsetRef.current, []);

  /** Fetch the latest state right now (used by individual Hard Sync so it never works from a stale view). */
  const refresh = useCallback(
    () =>
      new Promise<void>((resolve) => {
        const s = sockRef.current;
        if (!s?.connected) return resolve();
        const timer = setTimeout(resolve, 2000);
        s.emit('state:get', (snap) => (clearTimeout(timer), snap && applySnapshot(snap), resolve()));
      }),
    [applySnapshot],
  );

  const retryCaptions = useCallback(() => {
    const h = roomRef.current?.captions?.hash;
    if (h) fetchCaps.current(h);
  }, []);

  const api = useMemo(
    () => ({
      send,
      refresh,
      serverNow,
      retryCaptions,
      /** Latest accepted snapshot, readable synchronously (React state may lag a render behind). */
      getRoom: () => roomRef.current,
      setFile: (file: FileInfo | null) => {
        me.current.file = file;
        me.current.ready = false;
        sockRef.current?.emit('member:update', { file, ready: false });
      },
      setReady: (ready: boolean) => {
        me.current.ready = ready;
        sockRef.current?.emit('member:update', { ready });
      },
      rename: (n: string) => {
        me.current.name = n;
        sockRef.current?.emit('member:update', { name: n });
      },
      leave: () => sockRef.current?.emit('room:leave'),
      play: (position: number) => send({ type: 'play', position, basePv: roomRef.current?.playback.v ?? 0 }),
      pause: (position: number) => send({ type: 'pause', position, basePv: roomRef.current?.playback.v ?? 0 }),
      seek: (position: number) => send({ type: 'seek', position }),
      setRate: (rate: number) => send({ type: 'rate', rate }),
      hardSyncAll: (position: number) => send({ type: 'hardSyncAll', position, at: Date.now() + offsetRef.current }),
      setCaptions: (name: string, cues: CaptionCue[]) => send({ type: 'captions:set', name, cues }),
      clearCaptions: () => send({ type: 'captions:clear' }),
      setRole: (memberId: string, role: 'controller' | 'participant') => send({ type: 'role:set', memberId, role }),
      setSettings: (s: { controllerPower?: boolean; controllersCanSyncAll?: boolean }) => send({ type: 'settings', ...s }),
      transferOwner: (memberId: string) => send({ type: 'owner:transfer', memberId }),
      closeRoom: () => send({ type: 'room:close' }),
    }),
    [send, refresh, serverNow, retryCaptions],
  );

  return { status, closedReason, room, captions, capStatus, rtt, clientId, api };
}

export type RoomApi = ReturnType<typeof useRoom>['api'];
