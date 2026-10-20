import { useState } from 'react';
import Icon from './Icon.js';
import Sheet from './Sheet.js';
import { parseYouTubeInput } from './youtube.js';

interface Props {
  canLoad: boolean;
  ownerName: string;
  currentIsYoutube: boolean;
  hasFile: boolean;
  onLoad: (videoId: string, startAt: number) => Promise<string | null>;
  onUseFile: () => void;
  onClose: () => void;
}

/** Paste a link → preview → load for everyone. People without permission see why, instead of a dead button. */
export default function YoutubeLoader({ canLoad, ownerName, currentIsYoutube, hasFile, onLoad, onUseFile, onClose }: Props) {
  const [text, setText] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const ref = parseYouTubeInput(text);

  const submit = async () => {
    if (!ref) return setErr('That doesn’t look like a YouTube video link.');
    if (currentIsYoutube && !confirm) return setConfirm(true);
    setBusy(true);
    const e = await onLoad(ref.videoId, ref.startAt);
    setBusy(false);
    if (e) setErr(e);
    else onClose();
  };

  return (
    <Sheet title="Watch from YouTube" onClose={onClose}>
      {!canLoad ? (
        <div className="card-lite left">
          <Icon name="lock" size={22} />
          <p>You can’t load YouTube videos yet. Ask {ownerName} to switch on “YouTube” next to your name — they can do it in the People list.</p>
        </div>
      ) : (
        <form
          className="ytform"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <label className="label" htmlFor="ytlink">
            Paste a YouTube link
          </label>
          <input
            id="ytlink"
            className="field"
            inputMode="url"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            placeholder="https://youtu.be/…"
            value={text}
            onChange={(e) => (setText(e.target.value), setErr(''), setConfirm(false))}
            autoFocus
          />
          {ref && (
            <div className="ytprev">
              <img src={`https://i.ytimg.com/vi/${ref.videoId}/mqdefault.jpg`} alt="" loading="lazy" onError={(e) => (e.currentTarget.style.display = 'none')} />
              <span>
                Ready to load{ref.startAt ? ` from ${Math.floor(ref.startAt / 60)}:${String(ref.startAt % 60).padStart(2, '0')}` : ''}. Everyone will watch their own copy, kept in sync.
              </span>
            </div>
          )}
          {err && <p className="error">{err}</p>}
          {confirm && <p className="hint">This replaces what the room is watching now. Tap again to confirm.</p>}
          <button className="btn primary wide" type="submit" disabled={busy || !text.trim()}>
            {busy ? 'Loading…' : confirm ? 'Yes, replace it' : 'Load for everyone'}
          </button>
        </form>
      )}
      {currentIsYoutube && canLoad && hasFile && (
        <button className="linkbtn center" onClick={() => (onUseFile(), onClose())}>
          Go back to my own video file
        </button>
      )}
    </Sheet>
  );
}
