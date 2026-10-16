// Wire protocol shared (by copy) with web/src/protocol.ts — keep the two files identical.

export type Role = 'owner' | 'controller' | 'participant';

export interface FileInfo {
  name: string;
  size: number;
  duration: number;
}

export interface PlaybackState {
  /** Increments on every playback change. Clients and the server use it to reject stale commands. */
  v: number;
  playing: boolean;
  /** Media position in seconds at server time `at`. */
  position: number;
  /** Server timestamp (ms) at which `position` is valid. May be in the future for scheduled starts. */
  at: number;
  /** Intended playback speed, set by the owner/controllers. Viewers only ever nudge around it. */
  rate: number;
  /** Increments each time an owner-level Hard Sync is issued; every viewer hard-seeks once per value. */
  hardSeq: number;
  /** Member who made the last change. */
  by: string | null;
}

export interface RoomSettings {
  /** When off, controllers behave like ordinary participants. The owner is never affected. */
  controllerPower: boolean;
  /** When on, controllers may also trigger "sync everyone". Off by default. */
  controllersCanSyncAll: boolean;
}

export interface MemberView {
  id: string;
  name: string;
  online: boolean;
  role: Role;
  /** Effective right to change shared playback / captions right now. */
  canControl: boolean;
  file: FileInfo | null;
  ready: boolean;
}

export interface CaptionMeta {
  v: number;
  hash: string;
  name: string;
  cues: number;
  by: string;
}

export interface CaptionCue {
  s: number;
  e: number;
  t: string;
}

export interface CaptionData {
  meta: CaptionMeta;
  cues: CaptionCue[];
}

export interface RoomSnapshot {
  id: string;
  /** Changes when the room object is (re)created, e.g. after a server restart. Resets client version tracking. */
  epoch: string;
  /** Increments on every change to anything in this snapshot. Equal rev = heartbeat. */
  rev: number;
  ownerId: string | null;
  settings: RoomSettings;
  playback: PlaybackState;
  captions: CaptionMeta | null;
  members: MemberView[];
}

export type CommandBody =
  | { type: 'play'; position: number; basePv: number }
  | { type: 'pause'; position: number; basePv: number }
  | { type: 'seek'; position: number }
  | { type: 'rate'; rate: number }
  /** `position` is the sender's own position sampled at server time `at`. */
  | { type: 'hardSyncAll'; position: number; at: number }
  | { type: 'captions:set'; name: string; cues: CaptionCue[] }
  | { type: 'captions:clear' }
  | { type: 'role:set'; memberId: string; role: 'controller' | 'participant' }
  | { type: 'settings'; controllerPower?: boolean; controllersCanSyncAll?: boolean }
  | { type: 'owner:transfer'; memberId: string }
  | { type: 'room:close' };

/** Every command carries a unique id so retries are idempotent. */
export type Command = CommandBody & { id: string };

export type ErrorCode = 'bad_request' | 'forbidden' | 'stale' | 'not_in_room' | 'too_large' | 'rate_limited';

export type CmdResult =
  | { ok: true; rev: number; duplicate?: boolean }
  | { ok: false; error: ErrorCode; message: string; snapshot?: RoomSnapshot };

export type JoinResult =
  | { ok: true; roomId: string; snapshot: RoomSnapshot; captions: CaptionData | null }
  | { ok: false; error: 'not_found' | 'full' | 'bad_request' };

export interface CreatePayload {
  clientId: string;
  name: string;
  /** Re-create a specific room after a server restart (only possible if the code is free). */
  roomId?: string;
  restore?: { position: number; playing: boolean; rate: number };
}

export type CreateResult = { ok: true; roomId: string } | { ok: false; error: 'bad_request' | 'taken' };

export interface MemberPatch {
  name?: string;
  file?: FileInfo | null;
  ready?: boolean;
}

export interface ClientToServerEvents {
  'ping:time': (ack: (serverNow: number) => void) => void;
  'room:create': (p: CreatePayload, ack: (r: CreateResult) => void) => void;
  'room:join': (p: { roomId: string; clientId: string; name: string }, ack: (r: JoinResult) => void) => void;
  'room:leave': () => void;
  'member:update': (p: MemberPatch) => void;
  'state:get': (ack: (r: RoomSnapshot | null) => void) => void;
  'captions:get': (hash: string, ack: (r: CaptionData | null) => void) => void;
  cmd: (c: Command, ack: (r: CmdResult) => void) => void;
}

export interface ServerToClientEvents {
  'room:state': (s: RoomSnapshot) => void;
  'captions:data': (d: CaptionData | null) => void;
  'room:closed': (reason: string) => void;
  notice: (text: string, kind: 'info' | 'warn') => void;
}

export interface SocketData {
  roomId?: string;
  clientId?: string;
}

export const LIMITS = {
  nameLen: 24,
  fileNameLen: 120,
  idLen: 64,
  maxMembers: 12,
  maxPosition: 1_000_000,
  minRate: 0.25,
  maxRate: 3,
  maxCues: 20_000,
  maxCueText: 600,
  maxCaptionBytes: 1_500_000,
  /** socket.io payload ceiling; must exceed maxCaptionBytes. */
  maxMessageBytes: 2_500_000,
} as const;
