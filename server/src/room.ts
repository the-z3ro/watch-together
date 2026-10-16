import { randomBytes } from 'node:crypto';
import { hashCues, normalizeCues } from './captions.js';
import {
  type CaptionData,
  type CmdResult,
  type Command,
  type ErrorCode,
  type FileInfo,
  type MemberPatch,
  type MemberView,
  type PlaybackState,
  type Role,
  type RoomSettings,
  type RoomSnapshot,
} from './protocol.js';

export interface Member {
  id: string;
  name: string;
  socketId: string | null;
  role: Role;
  file: FileInfo | null;
  ready: boolean;
  joinedAt: number;
  ownerTimer: ReturnType<typeof setTimeout> | null;
  cmdTimes: number[];
  capTimes: number[];
}

export interface Effects {
  /** Set when the shared caption track changed: new data, or null when removed. */
  captions?: CaptionData | null;
  /** Set when the room was closed by the owner. */
  closed?: string;
  notices: { text: string; kind: 'info' | 'warn' }[];
}

export interface Applied {
  result: CmdResult;
  effects: Effects;
}

const SEEN_MAX = 256;
const CMD_WINDOW_MS = 10_000;
const CMD_MAX = 120;
const CAP_WINDOW_MS = 30_000;
const CAP_MAX = 6;

/** All authoritative state of one room plus every rule for changing it. No sockets in here, so it is unit-testable. */
export class Room {
  readonly epoch = randomBytes(6).toString('hex');
  rev = 1;
  ownerId: string | null = null;
  settings: RoomSettings = { controllerPower: true, controllersCanSyncAll: false };
  playback: PlaybackState;
  captions: CaptionData | null = null;
  readonly members = new Map<string, Member>();
  emptySince: number | null;
  private readonly seen = new Map<string, CmdResult>();
  private capVersion = 0;

  constructor(
    readonly id: string,
    now: number,
    private readonly leadMs: number,
    restore?: { position: number; playing: boolean; rate: number },
  ) {
    this.playback = {
      v: 1,
      playing: restore?.playing ?? false,
      position: restore?.position ?? 0,
      at: now,
      rate: restore?.rate ?? 1,
      hardSeq: 0,
      by: null,
    };
    this.emptySince = now;
  }

  // ---------- permissions (the only place roles are interpreted) ----------
  isOwner(m: Member): boolean {
    return m.id === this.ownerId;
  }
  canControl(m: Member): boolean {
    return this.isOwner(m) || (m.role === 'controller' && this.settings.controllerPower);
  }
  canSyncAll(m: Member): boolean {
    return this.isOwner(m) || (this.canControl(m) && this.settings.controllersCanSyncAll);
  }

  online(): Member[] {
    return [...this.members.values()].filter((m) => m.socketId !== null);
  }

  /** Where the media should be at server time `t`. */
  project(t: number): number {
    const p = this.playback;
    return p.playing ? p.position + (Math.max(0, t - p.at) / 1000) * p.rate : p.position;
  }

  private touch(): void {
    this.rev++;
  }

  // ---------- membership ----------
  join(clientId: string, name: string, socketId: string, now: number): { member: Member; replacedSocketId: string | null } {
    let m = this.members.get(clientId);
    let replacedSocketId: string | null = null;
    if (m) {
      if (m.socketId && m.socketId !== socketId) replacedSocketId = m.socketId;
      if (m.ownerTimer) clearTimeout(m.ownerTimer);
      m.ownerTimer = null;
      m.socketId = socketId;
      if (name) m.name = name;
    } else {
      m = {
        id: clientId,
        name: name || 'Guest',
        socketId,
        role: 'participant',
        file: null,
        ready: false,
        joinedAt: now,
        ownerTimer: null,
        cmdTimes: [],
        capTimes: [],
      };
      this.members.set(clientId, m);
    }
    if (!this.ownerId) {
      this.ownerId = m.id;
      m.role = 'owner';
    }
    this.emptySince = null;
    this.touch();
    return { member: m, replacedSocketId };
  }

  /** Socket dropped. Returns true if it was the member's current socket (i.e. state changed). */
  disconnect(memberId: string, socketId: string, now: number): boolean {
    const m = this.members.get(memberId);
    if (!m || m.socketId !== socketId) return false;
    m.socketId = null;
    if (this.online().length === 0) this.emptySince = now;
    this.touch();
    return true;
  }

  leave(memberId: string, now: number): void {
    const m = this.members.get(memberId);
    if (!m) return;
    if (m.ownerTimer) clearTimeout(m.ownerTimer);
    this.members.delete(memberId);
    if (this.ownerId === memberId) {
      this.ownerId = null;
      this.promoteOwner();
    }
    if (this.online().length === 0) this.emptySince = now;
    this.touch();
  }

  /** Hand ownership to the best online candidate (controllers first, then longest-present). Old owner becomes a controller. */
  promoteOwner(): Member | null {
    const old = this.ownerId ? this.members.get(this.ownerId) : undefined;
    const next = this.online()
      .filter((m) => m.id !== this.ownerId)
      .sort((a, b) => Number(b.role === 'controller') - Number(a.role === 'controller') || a.joinedAt - b.joinedAt)[0];
    if (!next) return null;
    if (old) old.role = 'controller';
    next.role = 'owner';
    this.ownerId = next.id;
    this.touch();
    return next;
  }

  update(memberId: string, patch: MemberPatch): boolean {
    const m = this.members.get(memberId);
    if (!m) return false;
    let changed = false;
    if (patch.name && patch.name !== m.name) ((m.name = patch.name), (changed = true));
    if ('file' in patch && JSON.stringify(patch.file ?? null) !== JSON.stringify(m.file)) ((m.file = patch.file ?? null), (changed = true));
    if (patch.ready !== undefined && patch.ready !== m.ready) ((m.ready = patch.ready), (changed = true));
    if (changed) this.touch();
    return changed;
  }

  // ---------- views ----------
  snapshot(): RoomSnapshot {
    const members: MemberView[] = [...this.members.values()]
      .sort((a, b) => a.joinedAt - b.joinedAt)
      .map((m) => ({
        id: m.id,
        name: m.name,
        online: m.socketId !== null,
        role: m.role,
        canControl: this.canControl(m),
        file: m.file,
        ready: m.ready,
      }));
    return {
      id: this.id,
      epoch: this.epoch,
      rev: this.rev,
      ownerId: this.ownerId,
      settings: { ...this.settings },
      playback: { ...this.playback },
      captions: this.captions ? { ...this.captions.meta } : null,
      members,
    };
  }

  // ---------- commands ----------
  apply(memberId: string, cmd: Command, now: number): Applied {
    const effects: Effects = { notices: [] };
    const m = this.members.get(memberId);
    if (!m) return { result: this.fail('not_in_room', 'You are not in this room.'), effects };

    const key = `${memberId}:${cmd.id}`;
    const prior = this.seen.get(key);
    if (prior) return { result: prior.ok ? { ...prior, duplicate: true } : prior, effects };

    if (this.limited(m, now, cmd.type === 'captions:set')) return { result: this.fail('rate_limited', 'Slow down a little.'), effects };

    const result = this.exec(m, cmd, now, effects);
    this.seen.set(key, result);
    if (this.seen.size > SEEN_MAX) this.seen.delete(this.seen.keys().next().value as string);
    return { result, effects };
  }

  private limited(m: Member, now: number, caption: boolean): boolean {
    m.cmdTimes = m.cmdTimes.filter((t) => now - t < CMD_WINDOW_MS);
    if (m.cmdTimes.length >= CMD_MAX) return true;
    if (caption) {
      m.capTimes = m.capTimes.filter((t) => now - t < CAP_WINDOW_MS);
      if (m.capTimes.length >= CAP_MAX) return true;
      m.capTimes.push(now);
    }
    m.cmdTimes.push(now);
    return false;
  }

  private ok(duplicate = false): CmdResult {
    return duplicate ? { ok: true, rev: this.rev, duplicate: true } : { ok: true, rev: this.rev };
  }

  private fail(error: ErrorCode, message: string, withSnapshot = false): CmdResult {
    return withSnapshot ? { ok: false, error, message, snapshot: this.snapshot() } : { ok: false, error, message };
  }

  private setPlayback(next: Omit<PlaybackState, 'v'>, by: string): CmdResult {
    this.playback = { ...next, v: this.playback.v + 1, by };
    this.touch();
    return this.ok();
  }

  private exec(m: Member, cmd: Command, now: number, fx: Effects): CmdResult {
    const pb = this.playback;
    const needControl = () => (this.canControl(m) ? null : this.fail('forbidden', 'Only the owner or a controller can do that.', true));
    const ownerOnly = () => (this.isOwner(m) ? null : this.fail('forbidden', 'Only the owner can do that.', true));

    switch (cmd.type) {
      case 'play':
      case 'pause': {
        const denied = needControl();
        if (denied) return denied;
        // A command computed from an out-of-date view must not overwrite newer state.
        if (cmd.basePv !== pb.v) return this.fail('stale', 'The room changed — try again.', true);
        return cmd.type === 'play'
          ? this.setPlayback({ ...pb, playing: true, position: cmd.position, at: now + this.leadMs }, m.id)
          : this.setPlayback({ ...pb, playing: false, position: cmd.position, at: now }, m.id);
      }

      case 'seek': {
        const denied = needControl();
        if (denied) return denied;
        // While playing, everyone re-starts together a moment from now so slow seeks can finish.
        return this.setPlayback({ ...pb, position: cmd.position, at: pb.playing ? now + this.leadMs : now }, m.id);
      }

      case 'rate': {
        const denied = needControl();
        if (denied) return denied;
        const t = Math.max(now, pb.at);
        return this.setPlayback({ ...pb, position: this.project(t), at: t, rate: cmd.rate }, m.id);
      }

      case 'hardSyncAll': {
        if (!this.canSyncAll(m)) return this.fail('forbidden', 'Only the owner can sync everyone.', true);
        if (pb.playing && pb.at > now) return this.setPlayback({ ...pb, hardSeq: pb.hardSeq + 1 }, m.id); // start still pending: keep schedule
        // The sender's position is the reference, sampled at (clamped) server time `at`.
        // A sample can't be from the future; clamping to `now` also keeps it from looking like a pending scheduled start.
        const at = pb.playing ? Math.min(Math.max(cmd.at, now - 3000), now) : now;
        return this.setPlayback({ ...pb, position: cmd.position, at, hardSeq: pb.hardSeq + 1 }, m.id);
      }

      case 'captions:set': {
        const denied = needControl();
        if (denied) return denied;
        const check = normalizeCues(cmd.cues);
        if (!check.ok) return this.fail(check.error, check.message);
        const hash = hashCues(check.cues);
        if (this.captions?.meta.hash === hash) return this.ok(true); // same track imported twice
        const meta = { v: ++this.capVersion, hash, name: cmd.name, cues: check.cues.length, by: m.id };
        this.captions = { meta, cues: check.cues };
        fx.captions = this.captions;
        fx.notices.push({ text: `${m.name} shared captions: ${cmd.name}`, kind: 'info' });
        this.touch();
        return this.ok();
      }

      case 'captions:clear': {
        const denied = needControl();
        if (denied) return denied;
        if (!this.captions) return this.ok(true);
        this.captions = null;
        this.capVersion++;
        fx.captions = null;
        fx.notices.push({ text: `${m.name} removed the captions`, kind: 'info' });
        this.touch();
        return this.ok();
      }

      case 'role:set': {
        const denied = ownerOnly();
        if (denied) return denied;
        const target = this.members.get(cmd.memberId);
        if (!target || target.id === this.ownerId) return this.fail('bad_request', 'That person can’t be changed.');
        if (target.role === cmd.role) return this.ok(true);
        target.role = cmd.role;
        fx.notices.push({ text: cmd.role === 'controller' ? `${target.name} is now a controller` : `${target.name} is no longer a controller`, kind: 'info' });
        this.touch();
        return this.ok();
      }

      case 'settings': {
        const denied = ownerOnly();
        if (denied) return denied;
        const before = JSON.stringify(this.settings);
        if (cmd.controllerPower !== undefined) this.settings.controllerPower = cmd.controllerPower;
        if (cmd.controllersCanSyncAll !== undefined) this.settings.controllersCanSyncAll = cmd.controllersCanSyncAll;
        if (JSON.stringify(this.settings) === before) return this.ok(true);
        if (cmd.controllerPower !== undefined)
          fx.notices.push({ text: cmd.controllerPower ? 'Controller power is on' : 'Controller power is off — only the owner can control playback', kind: 'info' });
        this.touch();
        return this.ok();
      }

      case 'owner:transfer': {
        const denied = ownerOnly();
        if (denied) return denied;
        const target = this.members.get(cmd.memberId);
        if (!target || target.id === m.id || !target.socketId) return this.fail('bad_request', 'Pick someone who is in the room.');
        m.role = 'controller';
        target.role = 'owner';
        this.ownerId = target.id;
        fx.notices.push({ text: `${target.name} is now the owner`, kind: 'info' });
        this.touch();
        return this.ok();
      }

      case 'room:close': {
        const denied = ownerOnly();
        if (denied) return denied;
        fx.closed = `${m.name} closed the room`;
        return this.ok();
      }
    }
  }
}
