import test from 'node:test';
import assert from 'node:assert/strict';
import { playbackFinished } from '../../player/src/end-detect.js';

const playing = {
  ended: false,
  phase: 'playing',
  currentTime: 10,
  duration: 120,
  endList: true,
};

test('an ended element finishes the episode', () => {
  assert.equal(playbackFinished({ ...playing, ended: true, currentTime: 3 }), true);
  assert.equal(playbackFinished({ ...playing, phase: 'ended', currentTime: 3 }), true);
});

test('a user pause is not the end of the episode', () => {
  assert.equal(playbackFinished({ ...playing, phase: 'paused', currentTime: 119 }, { userPaused: true, stalledMs: 5000 }), false);
  assert.equal(playbackFinished(playing, { userPaused: true, stalledMs: 5000 }), false);
});

test('a natural pause on the last frame still finishes', () => {
  assert.equal(playbackFinished({ ...playing, phase: 'paused', currentTime: 119.2 }, { stalledMs: 2000 }), true);
});

test('a stall in the middle does not finish the episode', () => {
  assert.equal(playbackFinished(playing, { stalledMs: 20000, durationStableMs: 60000 }), false);
});

test('a stall on a finished playlist does finish the episode', () => {
  const atEnd = { ...playing, currentTime: 119.2 };
  assert.equal(playbackFinished(atEnd, { stalledMs: 1500 }), false);
  assert.equal(playbackFinished(atEnd, { stalledMs: 2000 }), true);
});

test('a playlist without an end tag still finishes once the duration has stopped growing', () => {
  const atEnd = { ...playing, endList: false, currentTime: 119.2 };
  assert.equal(playbackFinished(atEnd, { stalledMs: 3000, durationStableMs: 10000 }), false);
  assert.equal(playbackFinished(atEnd, { stalledMs: 3000, durationStableMs: 15000 }), true);
});
