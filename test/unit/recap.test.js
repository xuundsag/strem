import test from 'node:test';
import assert from 'node:assert/strict';
import { recapSeek } from '../../player/src/playback-engine.js';

test('skip recap jumps to the intro when the opening has not started', () => {
  assert.deepEqual(recapSeek({ intro: { start: 31, end: 111 } }, 4), { ok: true, to: 31 });
});

test('skip recap refuses an episode with no pre-intro gap', () => {
  const missing = recapSeek({ intro: { start: 0, end: 90 } }, 0);
  assert.equal(missing.ok, false);
  const passed = recapSeek({ intro: { start: 31, end: 111 } }, 40);
  assert.equal(passed.ok, false);
});
