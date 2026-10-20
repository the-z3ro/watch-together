import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { errorText, issueFromError, parseTimeParam, parseYouTubeInput } from '../src/youtube.js';

const ID = 'dQw4w9WgXcQ';

describe('parseYouTubeInput', () => {
  const good: [string, number][] = [
    [`https://www.youtube.com/watch?v=${ID}`, 0],
    [`https://youtube.com/watch?v=${ID}&feature=share`, 0],
    [`http://www.youtube.com/watch?v=${ID}`, 0],
    [`www.youtube.com/watch?v=${ID}`, 0],
    [`youtube.com/watch?v=${ID}`, 0],
    [`https://m.youtube.com/watch?v=${ID}`, 0],
    [`https://music.youtube.com/watch?v=${ID}&list=RDAMVM${ID}`, 0],
    [`https://youtu.be/${ID}`, 0],
    [`youtu.be/${ID}?si=abc123`, 0],
    [`https://youtu.be/${ID}?t=90`, 90],
    [`https://www.youtube.com/watch?v=${ID}&t=1m30s`, 90],
    [`https://www.youtube.com/watch?v=${ID}&t=1h2m3s`, 3723],
    [`https://www.youtube.com/watch?v=${ID}&t=45s`, 45],
    [`https://www.youtube.com/watch?v=${ID}&start=12`, 12],
    [`https://www.youtube.com/watch?v=${ID}#t=75`, 75],
    [`https://www.youtube.com/shorts/${ID}`, 0],
    [`https://www.youtube.com/embed/${ID}?start=5`, 5],
    [`https://www.youtube-nocookie.com/embed/${ID}`, 0],
    [`https://www.youtube.com/live/${ID}`, 0],
    [`  https://youtu.be/${ID}  `, 0],
    [`https://www.youtube.com/watch?v=${ID}&list=PLabc&index=3`, 0],
  ];
  for (const [input, start] of good)
    it(`accepts ${input.trim()}`, () => {
      assert.deepEqual(parseYouTubeInput(input), { videoId: ID, startAt: start });
    });

  const bad = [
    '',
    '   ',
    'hello',
    ID, // a bare 11-char token is not a link
    'https://www.youtube.com/',
    'https://www.youtube.com/playlist?list=PLabc',
    'https://www.youtube.com/watch',
    'https://www.youtube.com/watch?v=short',
    'https://www.youtube.com/watch?v=dQw4w9WgXc!',
    `https://evil.com/watch?v=${ID}`,
    `https://youtube.com.evil.com/watch?v=${ID}`,
    `https://notyoutube.com/watch?v=${ID}`,
    `https://youtu.be.evil.com/${ID}`,
    `javascript:alert(1)//youtube.com/watch?v=${ID}`,
    `ftp://youtube.com/watch?v=${ID}`,
    `https://user:pw@youtube.com/watch?v=${ID}`,
    `https://youtube.com/watch?v=${ID} extra words`,
    'x'.repeat(400),
  ];
  for (const input of bad)
    it(`rejects ${JSON.stringify(input.slice(0, 50))}`, () => {
      assert.equal(parseYouTubeInput(input), null);
    });

  it('ignores a nonsense or huge start time instead of failing', () => {
    assert.deepEqual(parseYouTubeInput(`https://youtu.be/${ID}?t=abc`), { videoId: ID, startAt: 0 });
    assert.deepEqual(parseYouTubeInput(`https://youtu.be/${ID}?t=999999`), { videoId: ID, startAt: 86_400 });
    assert.deepEqual(parseYouTubeInput(`https://youtu.be/${ID}?t=99h`), { videoId: ID, startAt: 0 });
  });
});

describe('parseTimeParam / errors', () => {
  it('parses the common forms', () => {
    assert.equal(parseTimeParam('90'), 90);
    assert.equal(parseTimeParam('2m'), 120);
    assert.equal(parseTimeParam('1h'), 3600);
    assert.equal(parseTimeParam('m'), null);
    assert.equal(parseTimeParam(''), null);
    assert.equal(parseTimeParam(null), null);
  });
  it('maps YouTube error codes', () => {
    assert.equal(issueFromError(101), 'blocked');
    assert.equal(issueFromError(150), 'blocked');
    assert.equal(issueFromError(100), 'unavailable');
    assert.equal(issueFromError(5), 'unavailable');
    assert.match(errorText(150), /outside YouTube/);
  });
});
