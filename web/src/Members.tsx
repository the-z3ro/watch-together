import { compareFiles, fmtSize, fmtTime } from './engine.js';
import Icon from './Icon.js';
import type { FileInfo, RoomSnapshot } from './protocol.js';
import type { RoomApi } from './useRoom.js';

const BADGE = {
  match: { t: 'Same video', c: 'ok' },
  maybe: { t: 'Same length', c: 'warn' },
  mismatch: { t: 'Different video', c: 'bad' },
  waiting: { t: 'No file yet', c: 'idle' },
} as const;

const ISSUE = { blocked: 'Embedding blocked', unavailable: 'Can’t play it', live: 'Live stream' } as const;

function reference(room: RoomSnapshot, meId: string): FileInfo | null {
  const me = room.members.find((m) => m.id === meId);
  const owner = room.members.find((m) => m.id === room.ownerId);
  return me?.file ?? owner?.file ?? room.members.find((m) => m.file)?.file ?? null;
}

/** One-line summary: does everyone have the same video? */
export function summary(room: RoomSnapshot, meId: string): { c: 'ok' | 'warn' | 'bad' | 'idle'; t: string } {
  const online = room.members.filter((m) => m.online);
  if (room.media.kind === 'youtube') {
    const bad = online.filter((m) => m.mediaIssue).map((m) => m.name);
    if (bad.length) return { c: 'bad', t: `${bad.join(', ')} can’t play this video` };
    const notReady = online.filter((m) => !m.ready).map((m) => m.name);
    if (notReady.length) return { c: 'idle', t: `Waiting for ${notReady.join(', ')}` };
    return { c: 'ok', t: 'Everyone is ready' };
  }
  const ref = reference(room, meId);
  if (!ref) return { c: 'idle', t: 'Load a video to begin' };
  const states = online.map((m) => compareFiles(ref, m.file));
  const bad = online.filter((_, i) => states[i] === 'mismatch').map((m) => m.name);
  const waiting = online.filter((_, i) => states[i] === 'waiting').map((m) => m.name);
  if (bad.length) return { c: 'bad', t: `${bad.join(', ')} loaded a different video` };
  if (waiting.length) return { c: 'idle', t: `Waiting for ${waiting.join(', ')}` };
  if (states.includes('maybe')) return { c: 'warn', t: 'Same length everywhere' };
  return { c: 'ok', t: online.length > 1 ? 'Everyone has the same video' : 'Video loaded' };
}

interface Props {
  room: RoomSnapshot;
  meId: string;
  api: RoomApi;
  onError: (text: string) => void;
}

export default function Members({ room, meId, api, onError }: Props) {
  const isOwner = room.ownerId === meId;
  const ref = reference(room, meId);
  const power = room.settings.controllerPower;
  const yt = room.media.kind === 'youtube';
  const act = (p: Promise<{ ok: boolean; message?: string }>) => void p.then((r) => !r.ok && onError(r.message ?? 'That didn’t work.'));

  return (
    <ul className="members">
      {room.members.map((m) => {
        const b = BADGE[compareFiles(ref, m.file)];
        const issue = m.mediaIssue ? ISSUE[m.mediaIssue] : null;
        const you = m.id === meId;
        const ownerRow = m.id === room.ownerId;
        return (
          <li key={m.id} className={m.online ? '' : 'away'}>
            <div className="avatar">
              {m.name.slice(0, 1).toUpperCase()}
              <span className={'dot' + (m.online ? ' on' : '')} title={m.online ? 'Online' : 'Offline'} />
            </div>
            <div className="who">
              <div className="name">
                <span className="nm">{m.name}</span>
                {you && <em>you</em>}
                {ownerRow && (
                  <span className="role owner" title="Owner — full control of the room">
                    <Icon name="crown" size={12} /> Owner
                  </span>
                )}
                {m.role === 'controller' && (
                  <span className={'role controller' + (power ? '' : ' off')} title={power ? 'Controller — can play, pause, seek and manage captions' : 'Controller power is off — behaves like a participant for now'}>
                    <Icon name={power ? 'gauge' : 'lock'} size={12} /> Controller{power ? '' : ' (paused)'}
                  </span>
                )}
              </div>
              {yt ? (
                <div className="file">{m.online ? 'Watching on YouTube' : 'Disconnected'}</div>
              ) : m.file ? (
                <div className="file" title={m.file.name}>
                  {m.file.name}
                  <br />
                  {fmtTime(m.file.duration)} · {fmtSize(m.file.size)}
                </div>
              ) : (
                <div className="file">{m.online ? 'Hasn’t loaded a video' : 'Disconnected'}</div>
              )}
              <div className="tags">
                {!yt && <span className={'tag ' + b.c}>{b.t}</span>}
                {issue && <span className="tag bad">{issue}</span>}
                {m.canLoadMedia && !ownerRow && <span className="tag ok" title="Can load YouTube videos">Can load YouTube</span>}
                {m.ready && <span className="tag ok">Ready</span>}
              </div>
            </div>
            {isOwner && !ownerRow && (
              <div className="acts">
                <label className="switch" title="Controllers can play, pause, seek and manage captions">
                  <input type="checkbox" checked={m.role === 'controller'} onChange={(e) => act(api.setRole(m.id, e.target.checked ? 'controller' : 'participant'))} />
                  <span />
                  <small>controller</small>
                </label>
                <label className="switch" title="Allow this person to load YouTube videos for the whole room">
                  <input type="checkbox" checked={m.canLoadMedia} onChange={(e) => act(api.grantMedia(m.id, e.target.checked))} />
                  <span />
                  <small>YouTube</small>
                </label>
                {m.online && (
                  <button className="linkbtn" onClick={() => window.confirm(`Make ${m.name} the owner? You’ll become a controller.`) && act(api.transferOwner(m.id))}>
                    make owner
                  </button>
                )}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
