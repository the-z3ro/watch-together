import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decodeSubtitleBytes, parseSubtitles } from '../src/captions.js';

const ok = (s: string) => {
  const r = parseSubtitles(s);
  assert.ok(r.ok, r.ok ? '' : r.message);
  return r.cues;
};

describe('subtitle parsing', () => {
  it('parses SRT with comma timestamps, CRLF, BOM and multi-line text', () => {
    const cues = ok('﻿1\r\n00:00:01,500 --> 00:00:03,000\r\nHello\r\nthere\r\n\r\n2\r\n01:02:03,004 --> 01:02:05,000\r\nLate\r\n');
    assert.deepEqual(cues, [
      { s: 1.5, e: 3, t: 'Hello\nthere' },
      { s: 3723.004, e: 3725, t: 'Late' },
    ]);
  });

  it('parses WebVTT with header, notes, short timestamps, cue ids and settings', () => {
    const cues = ok(`WEBVTT - demo

NOTE this is ignored

STYLE
::cue { color: red }

intro
00:01.000 --> 00:02.500 align:start position:10%
<v Bob>Hi <i>there</i></v>

00:00:03.000 --> 00:00:04.000
Second`);
    assert.equal(cues.length, 2);
    assert.deepEqual(cues[0], { s: 1, e: 2.5, t: 'Hi <i>there</i>' });
  });

  it('pads fractional milliseconds (.5 means 500 ms) and sorts cues', () => {
    const cues = ok('2\n00:00:09.5 --> 00:00:10.0\nB\n\n1\n00:00:01.25 --> 00:00:02.0\nA');
    assert.deepEqual(cues.map((c) => [c.s, c.t]), [[1.25, 'A'], [9.5, 'B']]);
  });

  it('strips font tags and ASS overrides but keeps basic emphasis', () => {
    const cues = ok('1\n00:00:01,000 --> 00:00:02,000\n{\\an8}<font color="red">Up <b>top</b></font>');
    assert.equal(cues[0]?.t, 'Up <b>top</b>');
  });

  it('skips broken blocks but keeps the good ones', () => {
    const r = parseSubtitles('1\n00:00:01,000 --> 00:00:02,000\nA\n\n2\n00:00:05,000 --> 00:00:04,000\nbackwards\n\n3\n00:00:06,000 --> 00:00:07,000\nB');
    assert.ok(r.ok && r.cues.length === 2 && r.skipped === 1);
  });

  it('rejects empty, non-subtitle, XML and mostly-broken files with a clear message', () => {
    for (const bad of ['', '   \n ', 'just some text\nnothing else', '<?xml version="1.0"?><tt></tt>', '1\n00:00:09,000 --> 00:00:01,000\nx\n\n2\n00:00:09,000 --> 00:00:01,000\ny']) {
      const r = parseSubtitles(bad);
      assert.equal(r.ok, false, JSON.stringify(bad));
      assert.ok(!r.ok && r.message.length > 5);
    }
  });

  it('rejects absurdly large tracks', () => {
    const many = Array.from({ length: 20_500 }, (_, i) => `${i + 1}\n00:00:${String(i % 60).padStart(2, '0')},000 --> 00:00:${String(i % 60).padStart(2, '0')},500\nx`).join('\n\n');
    const r = parseSubtitles(many);
    assert.equal(r.ok, false);
  });

  it('decodes UTF-8 and falls back to Windows-1252', () => {
    assert.equal(decodeSubtitleBytes(new TextEncoder().encode('café ✓').buffer as ArrayBuffer), 'café ✓');
    assert.equal(decodeSubtitleBytes(new Uint8Array([0x63, 0x61, 0x66, 0xe9]).buffer), 'café');
  });
});
