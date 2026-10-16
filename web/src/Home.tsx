import { useState } from 'react';
import { SERVER, createRoom } from './api.js';
import ThemeToggle from './ThemeToggle.js';
import type { Theme } from './theme.js';

const STEPS: [string, string, string][] = [
  ['1', 'Make a room', 'Share the code or link with your friend.'],
  ['2', 'Load the same video', 'Each of you opens your own copy. Nothing uploads.'],
  ['3', 'Press play', 'Only the playhead travels, so it works on weak networks.'],
];

interface Props {
  inviteId: string | null;
  name: string;
  theme: Theme;
  onTheme: () => void;
  onName: (n: string) => void;
  onEnter: (id: string | null) => void;
}

export default function Home({ inviteId, name, theme, onTheme, onName, onEnter }: Props) {
  const [draft, setDraft] = useState(name);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const clean = draft.trim();

  async function create() {
    if (!clean) return setErr('Pick a name first');
    setErr('');
    setBusy(true);
    onName(clean);
    try {
      onEnter(await createRoom(clean));
    } catch (e) {
      setBusy(false);
      const m = e instanceof Error ? e.message : '';
      setErr(m === 'noserver' ? 'No sync server configured (set VITE_SERVER_URL — see README).' : m === 'timeout' ? 'Couldn’t reach the sync server. Check its URL and try again.' : 'Something went wrong. Try again.');
    }
  }

  function join(id: string) {
    if (!clean) return setErr('Pick a name first');
    const c = id.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (c.length < 4) return setErr('That code looks too short');
    onName(clean);
    onEnter(c);
  }

  return (
    <div className="home">
      <div className="home-top">
        <ThemeToggle theme={theme} onToggle={onTheme} />
      </div>
      <div className="hero">
        <span className="logo big">▶</span>
        <h1>Watch Together</h1>
        <p>Same video, same second, from anywhere. Everyone plays their own file — only the timeline is synced.</p>
      </div>

      <div className="panel home-card">
        <label className="label" htmlFor="name">
          Your name
        </label>
        <input id="name" className="field" placeholder="e.g. Jason" value={draft} maxLength={24} onChange={(e) => setDraft(e.target.value)} autoComplete="nickname" />

        {inviteId ? (
          <>
            <div className="invite">
              Invited to room <b>{inviteId}</b>
            </div>
            <button className="btn primary wide" onClick={() => join(inviteId)}>
              Join room
            </button>
            <button className="linkbtn center" onClick={() => onEnter(null)}>
              or start your own
            </button>
          </>
        ) : (
          <>
            <button className="btn primary wide" onClick={() => void create()} disabled={busy}>
              {busy ? 'Creating…' : 'Create a room'}
            </button>
            {busy && <p className="hint">First start can take up to a minute while the free server wakes up.</p>}
            <div className="or">
              <span>or join one</span>
            </div>
            <form
              className="row2"
              onSubmit={(e) => {
                e.preventDefault();
                join(code);
              }}
            >
              <input className="field code-in" placeholder="ROOM CODE" value={code} maxLength={12} onChange={(e) => setCode(e.target.value.toUpperCase())} autoCapitalize="characters" autoComplete="off" spellCheck={false} />
              <button className="btn" type="submit">
                Join
              </button>
            </form>
          </>
        )}
        {err && <p className="error">{err}</p>}
        {!SERVER && <p className="error">Sync server URL isn’t set yet — see the README.</p>}
      </div>

      <ol className="steps">
        {STEPS.map(([n, t, d]) => (
          <li key={n}>
            <span>{n}</span>
            <div>
              <b>{t}</b>
              <small>{d}</small>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
