import { createHash } from 'node:crypto';
import { LIMITS, type CaptionCue } from './protocol.js';

export type CueCheck =
  | { ok: true; cues: CaptionCue[] }
  | { ok: false; error: 'bad_request' | 'too_large'; message: string };

const round = (n: number) => Math.round(n * 1000) / 1000;

/** Validate + normalise cues coming from a client: sorted, millisecond precision, sane text, bounded size. */
export function normalizeCues(raw: unknown): CueCheck {
  if (!Array.isArray(raw)) return { ok: false, error: 'bad_request', message: 'Captions must be a list of cues.' };
  if (raw.length > LIMITS.maxCues) return { ok: false, error: 'too_large', message: `Too many caption lines (max ${LIMITS.maxCues}).` };

  const cues: CaptionCue[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const { s, e, t } = item as Record<string, unknown>;
    if (typeof s !== 'number' || typeof e !== 'number' || typeof t !== 'string') continue;
    if (!Number.isFinite(s) || !Number.isFinite(e) || s < 0 || e <= s || e > LIMITS.maxPosition) continue;
    const text = t
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
      .replace(/-->/g, '→')
      .replace(/\r\n?/g, '\n')
      .trim()
      .slice(0, LIMITS.maxCueText);
    if (!text) continue;
    cues.push({ s: round(s), e: round(e), t: text });
  }

  if (cues.length === 0) return { ok: false, error: 'bad_request', message: 'No valid caption lines found.' };
  // If most of the input was junk the file is probably not a subtitle file at all.
  if (cues.length < raw.length * 0.5) return { ok: false, error: 'bad_request', message: 'Most caption lines were invalid.' };

  cues.sort((a, b) => a.s - b.s || a.e - b.e);
  if (JSON.stringify(cues).length > LIMITS.maxCaptionBytes) return { ok: false, error: 'too_large', message: 'Caption file is too large.' };
  return { ok: true, cues };
}

/** Content hash used to detect duplicate imports and to let late clients ask for the right track. */
export function hashCues(cues: CaptionCue[]): string {
  return createHash('sha1').update(JSON.stringify(cues)).digest('hex').slice(0, 16);
}
