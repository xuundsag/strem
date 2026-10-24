import test from 'node:test';
import assert from 'node:assert/strict';
import { autoplayPlan } from '../../controller/src/autoplay.js';
import { loadConfig } from '../../controller/src/config.js';

test('autoplay is on unless the env turns it off', () => {
  assert.equal(loadConfig({}).autoplayDefault, true);
  assert.equal(loadConfig({ AUTOPLAY_DEFAULT: 'true' }).autoplayDefault, true);
  assert.equal(loadConfig({ AUTOPLAY_DEFAULT: 'false' }).autoplayDefault, false);
});

test('autoplay advances to the next episode', () => {
  assert.deepEqual(autoplayPlan({ autoplay: true, episode: 4, episodeCount: 12 }), {
    action: 'advance',
    episode: 5,
  });
});

test('autoplay does not run when it is off or the series is over', () => {
  assert.deepEqual(autoplayPlan({ autoplay: false, episode: 4 }), { action: 'finish' });
  assert.deepEqual(autoplayPlan({ autoplay: true, episode: 12, episodeCount: 12 }), {
    action: 'finish',
    reason: 'no more episodes',
  });
});
