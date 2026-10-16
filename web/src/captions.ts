// Subtitle import: parse .srt / .vtt, validate, normalise to {s,e,t} cues (seconds).
import { LIMITS, type CaptionCue } from './protocol.js';

export const MAX_SUBTITLE_FILE_BYTES = 2_000_000;

export type ParseResult =
  | { ok: true; cues: CaptionCue[]; skipped: number }
  | { ok: false; message: string };

const TIMING = /^\s*(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})\s*-->\s*(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/;
const sec = (h: string | undefined, m: string, s: string, f: string) => Number(h ?? 0) * 3600 + Number(m) * 60 + Number(s) + Number(f.padEnd(3, '0')) / 1000;

/** Keep <i>/<b>/<u>; drop other markup and ASS-style {\an8} overrides. */
function cleanText(raw: string): string {
  return raw
    .replace(/\{\\[^}]*\}/g, '')
    .replace(/<(?!\/?(?:i|b|u)\b)[^>]*>/gi, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/-->/g, '→')
    .trim();
}

/** Parse SRT or WebVTT text. Pure and forgiving: bad blocks are skipped and counted, never fatal on their own. */
export function parseSubtitles(input: string): ParseResult {
  const text = input.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  if (!text.trim()) return { ok: false, message: 'That file is empty.' };
  if (/^\s*<\?xml|^\s*<tt[\s>]/i.test(text)) return { ok: false, message: 'Only .srt and .vtt captions are supported.' };

  const blocks = text.split(/\n[ \t]*\n+/);
  const cues: CaptionCue[] = [];
  let skipped = 0;

  for (const block of blocks) {
    const lines = block.split('\n');
    const idx = lines.findIndex((l) => l.includes('-->'));
    if (idx === -1) continue; // header, NOTE, STYLE, REGION, lone index…
    const m = TIMING.exec(lines[idx] ?? '');
    if (!m) {
      skipped++;
      continue;
    }
    const s = sec(m[1], m[2]!, m[3]!, m[4]!);
    const e = sec(m[5], m[6]!, m[7]!, m[8]!);
    const t = cleanText(lines.slice(idx + 1).join('\n')).slice(0, LIMITS.maxCueText);
    if (!(e > s) || !t) {
      if (!(e > s)) skipped++;
      continue;
    }
    cues.push({ s: Math.round(s * 1000) / 1000, e: Math.round(e * 1000) / 1000, t });
  }

  if (cues.length === 0) return { ok: false, message: 'No captions found — is this really an .srt or .vtt file?' };
  if (skipped > cues.length) return { ok: false, message: 'Most of this file could not be read as captions.' };
  if (cues.length > LIMITS.maxCues) return { ok: false, message: `Too many caption lines (max ${LIMITS.maxCues.toLocaleString()}).` };
  cues.sort((a, b) => a.s - b.s || a.e - b.e);
  if (JSON.stringify(cues).length > LIMITS.maxCaptionBytes) return { ok: false, message: 'This caption file is too large to share.' };
  return { ok: true, cues, skipped };
}

/** Decode bytes as UTF-8, falling back to Windows-1252 (very common for old DVD-era .srt files). */
export function decodeSubtitleBytes(buf: ArrayBuffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder('windows-1252').decode(buf);
  }
}

export async function readSubtitleFile(file: File): Promise<ParseResult> {
  if (!/\.(srt|vtt)$/i.test(file.name)) return { ok: false, message: 'Captions must be a .srt or .vtt file.' };
  if (file.size > MAX_SUBTITLE_FILE_BYTES) return { ok: false, message: 'That caption file is too large (over 2 MB).' };
  try {
    return parseSubtitles(decodeSubtitleBytes(await file.arrayBuffer()));
  } catch {
    return { ok: false, message: 'Could not read that file.' };
  }
}
