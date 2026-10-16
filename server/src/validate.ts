import { LIMITS, type CaptionCue, type Command, type CreatePayload, type FileInfo, type MemberPatch } from './protocol.js';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isPos = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= LIMITS.maxPosition;
const isStr = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max;

export const cleanText = (v: unknown, max: number): string =>
  typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max) : '';

export function parseFile(v: unknown): FileInfo | null {
  if (!isObj(v)) return null;
  const size = typeof v.size === 'number' && Number.isFinite(v.size) && v.size >= 0 ? v.size : 0;
  const duration = typeof v.duration === 'number' && Number.isFinite(v.duration) && v.duration >= 0 ? v.duration : 0;
  return { name: cleanText(v.name, LIMITS.fileNameLen), size, duration };
}

export function parsePatch(v: unknown): MemberPatch | null {
  if (!isObj(v)) return null;
  const out: MemberPatch = {};
  if ('name' in v) {
    const n = cleanText(v.name, LIMITS.nameLen);
    if (n) out.name = n;
  }
  if ('file' in v) out.file = v.file === null ? null : parseFile(v.file);
  if ('ready' in v) out.ready = v.ready === true;
  return out;
}

export function parseCreate(v: unknown): CreatePayload | null {
  if (!isObj(v)) return null;
  const clientId = cleanText(v.clientId, LIMITS.idLen);
  if (!clientId) return null;
  const out: CreatePayload = { clientId, name: cleanText(v.name, LIMITS.nameLen) || 'Guest' };
  if (typeof v.roomId === 'string') {
    const id = v.roomId.toUpperCase();
    if (!/^[A-Z2-9]{6}$/.test(id)) return null;
    out.roomId = id;
  }
  if (isObj(v.restore)) {
    const r = v.restore;
    if (isPos(r.position) && typeof r.playing === 'boolean' && typeof r.rate === 'number' && r.rate >= LIMITS.minRate && r.rate <= LIMITS.maxRate)
      out.restore = { position: r.position, playing: r.playing, rate: r.rate };
  }
  return out;
}

/** Strictly validate an untrusted command. Returns null for anything malformed. */
export function parseCommand(v: unknown): Command | null {
  if (!isObj(v) || !isStr(v.id, LIMITS.idLen) || v.id.length === 0 || typeof v.type !== 'string') return null;
  const id = v.id;
  switch (v.type) {
    case 'play':
    case 'pause':
      return isPos(v.position) && typeof v.basePv === 'number' && Number.isInteger(v.basePv)
        ? { id, type: v.type, position: v.position, basePv: v.basePv }
        : null;
    case 'seek':
      return isPos(v.position) ? { id, type: 'seek', position: v.position } : null;
    case 'rate':
      return typeof v.rate === 'number' && v.rate >= LIMITS.minRate && v.rate <= LIMITS.maxRate ? { id, type: 'rate', rate: v.rate } : null;
    case 'hardSyncAll':
      return isPos(v.position) && typeof v.at === 'number' && Number.isFinite(v.at) ? { id, type: 'hardSyncAll', position: v.position, at: v.at } : null;
    case 'captions:set': {
      if (!Array.isArray(v.cues)) return null;
      // Cue content is validated/normalised in captions.ts; here only the envelope.
      return { id, type: 'captions:set', name: cleanText(v.name, LIMITS.fileNameLen) || 'captions', cues: v.cues as CaptionCue[] };
    }
    case 'captions:clear':
      return { id, type: 'captions:clear' };
    case 'role:set':
      return isStr(v.memberId, LIMITS.idLen) && (v.role === 'controller' || v.role === 'participant')
        ? { id, type: 'role:set', memberId: v.memberId, role: v.role }
        : null;
    case 'settings': {
      const out: Command = { id, type: 'settings' };
      if (typeof v.controllerPower === 'boolean') out.controllerPower = v.controllerPower;
      if (typeof v.controllersCanSyncAll === 'boolean') out.controllersCanSyncAll = v.controllersCanSyncAll;
      return out;
    }
    case 'owner:transfer':
      return isStr(v.memberId, LIMITS.idLen) ? { id, type: 'owner:transfer', memberId: v.memberId } : null;
    case 'room:close':
      return { id, type: 'room:close' };
    default:
      return null;
  }
}
