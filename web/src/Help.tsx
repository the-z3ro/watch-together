import Icon from './Icon.js';

export const SEEK = { short: 5, long: 15, big: 60 } as const;

/** Single source of truth for the shortcut guide (the key handler in Player.tsx mirrors these). */
export const SHORTCUTS: { keys: string[]; what: string; group: string }[] = [
  { group: 'Playback', keys: ['K', 'Space'], what: 'Play / pause (everyone)' },
  { group: 'Playback', keys: ['H'], what: `Back ${SEEK.short} s` },
  { group: 'Playback', keys: ['J'], what: `Back ${SEEK.long} s` },
  { group: 'Playback', keys: ['L'], what: `Forward ${SEEK.short} s` },
  { group: 'Playback', keys: [';'], what: `Forward ${SEEK.long} s` },
  { group: 'Playback', keys: ['['], what: `Back ${SEEK.big} s` },
  { group: 'Playback', keys: [']'], what: `Forward ${SEEK.big} s` },
  { group: 'Playback', keys: ['0', 'Home'], what: 'Jump to the beginning' },
  { group: 'Playback', keys: ['$', 'End'], what: 'Jump to the end' },
  { group: 'Sync', keys: ['\\'], what: 'Hard Sync — only you jump to where the room is' },
  { group: 'Sync', keys: ['|'], what: 'Sync menu (owner: “sync everyone”, with confirmation)' },
  { group: 'You', keys: ['F'], what: 'Fullscreen' },
  { group: 'You', keys: ['C'], what: 'Captions on / off (just for you)' },
  { group: 'You', keys: ['M'], what: 'Mute / unmute' },
  { group: 'You', keys: ['+', '-'], what: 'Volume up / down' },
  { group: 'You', keys: ['P'], what: 'Picture-in-picture (where supported)' },
  { group: 'You', keys: ['?'], what: 'This guide' },
];

export default function Help({ onClose }: { onClose: () => void }) {
  const groups = [...new Set(SHORTCUTS.map((s) => s.group))];
  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts" onPointerDown={onClose}>
      <div className="sheet" onPointerDown={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <h3>
            <Icon name="keyboard" size={18} /> Keyboard shortcuts
          </h3>
          <button className="ic" onClick={onClose} aria-label="Close">
            <Icon name="close" />
          </button>
        </div>
        {groups.map((g) => (
          <section key={g}>
            <h4>{g}</h4>
            {SHORTCUTS.filter((s) => s.group === g).map((s) => (
              <div className="krow" key={s.what}>
                <span className="kkeys">
                  {s.keys.map((k) => (
                    <kbd key={k}>{k}</kbd>
                  ))}
                </span>
                <span>{s.what}</span>
              </div>
            ))}
          </section>
        ))}
        <p className="hint">Only the owner and controllers can change shared playback. Shortcuts are ignored while you type in a text box. Arrow keys also seek ±5 s.</p>
      </div>
    </div>
  );
}
