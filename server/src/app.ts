import crypto from 'node:crypto';
import http from 'node:http';
import { Server, type Socket } from 'socket.io';
import {
  LIMITS,
  type ClientToServerEvents,
  type CmdResult,
  type ServerToClientEvents,
  type SocketData,
} from './protocol.js';
import { Room, type Member } from './room.js';
import { parseCommand, parseCreate, parsePatch, cleanText } from './validate.js';

export interface AppConfig {
  /** Comma-separated allowed browser origins, or "*". */
  origin: string;
  /** Delay before a scheduled start so every client can line up on the same instant. */
  leadMs: number;
  /** Heartbeat re-broadcast while a room is playing. */
  tickMs: number;
  /** How long an absent owner keeps the role before it is handed to someone online. */
  ownerGraceMs: number;
  /** How long a room nobody is in survives. */
  emptyTtlMs: number;
  sweepMs: number;
}

export const DEFAULT_CONFIG: AppConfig = {
  origin: '*',
  leadMs: 600,
  tickMs: 5000,
  ownerGraceMs: 30_000,
  emptyTtlMs: 10 * 60_000,
  sweepMs: 60_000,
};

type Sock = Socket<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I: easy to read out on a call

export function createApp(partial: Partial<AppConfig> = {}) {
  const cfg: AppConfig = { ...DEFAULT_CONFIG, ...partial };
  const rooms = new Map<string, Room>();

  const httpServer = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'text/plain', 'access-control-allow-origin': '*' });
      return void res.end('ok');
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('watch-together sync server');
  });

  const io = new Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>(httpServer, {
    cors: { origin: cfg.origin === '*' ? true : cfg.origin.split(',').map((s) => s.trim()) },
    maxHttpBufferSize: LIMITS.maxMessageBytes,
    pingInterval: 10_000,
    pingTimeout: 15_000,
  });

  const broadcast = (room: Room) => io.to(room.id).emit('room:state', room.snapshot());

  function genRoomId(): string {
    for (;;) {
      let id = '';
      for (let i = 0; i < 6; i++) id += ALPHABET[crypto.randomInt(ALPHABET.length)];
      if (!rooms.has(id)) return id;
    }
  }

  /** The member this socket currently speaks for — null for stale/replaced sockets. Every handler goes through this. */
  function ctx(socket: Sock): { room: Room; member: Member } | null {
    const { roomId, clientId } = socket.data;
    if (!roomId || !clientId) return null;
    const room = rooms.get(roomId);
    const member = room?.members.get(clientId);
    if (!room || !member || member.socketId !== socket.id) return null;
    return { room, member };
  }

  function startOwnerTimer(room: Room, m: Member): void {
    if (m.ownerTimer) clearTimeout(m.ownerTimer);
    m.ownerTimer = setTimeout(() => {
      m.ownerTimer = null;
      if (m.socketId || room.ownerId !== m.id || rooms.get(room.id) !== room) return;
      const next = room.promoteOwner();
      if (next) {
        io.to(room.id).emit('notice', `${next.name} is now the owner (${m.name} is offline)`, 'info');
        broadcast(room);
      }
    }, cfg.ownerGraceMs);
    m.ownerTimer.unref();
  }

  function attach(socket: Sock, room: Room, clientId: string, name: string): void {
    const { member, replacedSocketId } = room.join(clientId, name, socket.id, Date.now());
    if (replacedSocketId) {
      // Same person opened the room elsewhere (or the old connection is a zombie): the newest socket wins.
      const old = io.sockets.sockets.get(replacedSocketId);
      if (old) {
        old.leave(room.id);
        old.data = {};
        old.emit('room:closed', 'You joined this room from another tab or device.');
      }
    }
    socket.data = { roomId: room.id, clientId };
    void socket.join(room.id);
    const owner = room.ownerId ? room.members.get(room.ownerId) : undefined;
    if (owner && !owner.socketId && !owner.ownerTimer) startOwnerTimer(room, owner);
    void member;
  }

  function detach(socket: Sock, leave: boolean): void {
    const { roomId, clientId } = socket.data;
    socket.data = {};
    if (!roomId || !clientId) return;
    const room = rooms.get(roomId);
    if (!room) return;
    void socket.leave(roomId);
    const m = room.members.get(clientId);
    if (!m || m.socketId !== socket.id) return;
    if (leave) {
      const wasOwner = room.ownerId === clientId;
      room.leave(clientId, Date.now());
      if (wasOwner && room.ownerId) {
        const o = room.members.get(room.ownerId);
        if (o) io.to(room.id).emit('notice', `${o.name} is now the owner`, 'info');
      }
    } else {
      room.disconnect(clientId, socket.id, Date.now());
      if (room.ownerId === clientId) startOwnerTimer(room, m);
    }
    broadcast(room);
  }

  function closeRoom(room: Room, reason: string): void {
    io.to(room.id).emit('room:closed', reason);
    io.in(room.id).socketsLeave(room.id);
    for (const m of room.members.values()) if (m.ownerTimer) clearTimeout(m.ownerTimer);
    rooms.delete(room.id);
  }

  io.on('connection', (socket: Sock) => {
    socket.data = {};

    socket.on('ping:time', (ack) => {
      if (typeof ack === 'function') ack(Date.now());
    });

    socket.on('room:create', (raw, ack) => {
      if (typeof ack !== 'function') return;
      const p = parseCreate(raw);
      if (!p) return ack({ ok: false, error: 'bad_request' });
      if (p.roomId && rooms.has(p.roomId)) return ack({ ok: false, error: 'taken' });
      if (socket.data.roomId) detach(socket, true);
      const id = p.roomId ?? genRoomId();
      const room = new Room(id, Date.now(), cfg.leadMs, p.restore);
      rooms.set(id, room);
      attach(socket, room, p.clientId, p.name);
      ack({ ok: true, roomId: id });
      broadcast(room);
    });

    socket.on('room:join', (raw, ack) => {
      if (typeof ack !== 'function') return;
      const p = raw as { roomId?: unknown; clientId?: unknown; name?: unknown } | null;
      const roomId = cleanText(p?.roomId, 12).toUpperCase();
      const clientId = cleanText(p?.clientId, LIMITS.idLen);
      if (!clientId || !roomId) return ack({ ok: false, error: 'bad_request' });
      const room = rooms.get(roomId);
      if (!room) return ack({ ok: false, error: 'not_found' });
      if (!room.members.has(clientId) && room.members.size >= LIMITS.maxMembers) return ack({ ok: false, error: 'full' });
      if (socket.data.roomId && socket.data.roomId !== roomId) detach(socket, true);
      attach(socket, room, clientId, cleanText(p?.name, LIMITS.nameLen));
      ack({ ok: true, roomId, snapshot: room.snapshot(), captions: room.captions });
      broadcast(room);
    });

    socket.on('room:leave', () => detach(socket, true));

    socket.on('member:update', (raw) => {
      const c = ctx(socket);
      const patch = parsePatch(raw);
      if (c && patch && c.room.update(c.member.id, patch)) broadcast(c.room);
    });

    socket.on('state:get', (ack) => {
      if (typeof ack === 'function') ack(ctx(socket)?.room.snapshot() ?? null);
    });

    socket.on('captions:get', (hash, ack) => {
      if (typeof ack !== 'function') return;
      const c = ctx(socket);
      ack(c?.room.captions && c.room.captions.meta.hash === hash ? c.room.captions : null);
    });

    socket.on('cmd', (raw, ack) => {
      const reply = (r: CmdResult) => typeof ack === 'function' && ack(r);
      const c = ctx(socket);
      if (!c) return reply({ ok: false, error: 'not_in_room', message: 'You are not in this room.' });
      const cmd = parseCommand(raw);
      if (!cmd) return reply({ ok: false, error: 'bad_request', message: 'Malformed command.' });

      const { result, effects } = c.room.apply(c.member.id, cmd, Date.now());
      reply(result);
      if (effects.closed) return closeRoom(c.room, effects.closed);
      if (result.ok && !result.duplicate) {
        broadcast(c.room);
        if (effects.captions !== undefined) io.to(c.room.id).emit('captions:data', effects.captions);
        for (const n of effects.notices) io.to(c.room.id).emit('notice', n.text, n.kind);
      }
    });

    socket.on('disconnect', () => detach(socket, false));
  });

  // Heartbeat: lets clients recover from a missed event (they compare `rev`) while playing.
  const tick = setInterval(() => {
    for (const room of rooms.values()) if (room.playback.playing && room.online().length) broadcast(room);
  }, cfg.tickMs);
  const sweep = setInterval(() => {
    for (const room of rooms.values())
      if (!room.online().length && room.emptySince !== null && Date.now() - room.emptySince > cfg.emptyTtlMs) closeRoom(room, 'Room expired');
  }, cfg.sweepMs);
  tick.unref();
  sweep.unref();

  return {
    rooms,
    io,
    httpServer,
    config: cfg,
    listen: (port: number) =>
      new Promise<number>((resolve) => {
        httpServer.listen(port, () => {
          const addr = httpServer.address();
          resolve(typeof addr === 'object' && addr ? addr.port : port);
        });
      }),
    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(tick);
        clearInterval(sweep);
        for (const room of rooms.values()) for (const m of room.members.values()) if (m.ownerTimer) clearTimeout(m.ownerTimer);
        void io.close(() => resolve());
      }),
  };
}
