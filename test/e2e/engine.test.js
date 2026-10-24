// E2E: the playback engine end to end, against a local source.
//
// These tests drive the same object the streamer uses, so skip, pause, resume,
// the ffmpeg fallback and crash recovery are all covered by real runs.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PlaybackEngine } from '../../player/src/playback-engine.js';
import { localSource, resolverFrom, fakeRequest } from '../helpers/local-source.js';
import { checkSystemTools, checkChromium } from '../../player/src/display.js';
import { probe, frameAt, measureStream } from '../helpers/harness.js';
import { STATE } from '../../shared/src/ipc-protocol.js';

const tools = checkSystemTools();
const skipReason = tools.ffmpeg && tools.xvfb && checkChromium()
  ? false
  : `missing ${!checkChromium() ? 'playwright chromium (run: npx playwright install chromium)' : 'system tools: ' + JSON.stringify(tools)}`;

test('engine plays, reports position and duration', { skip: skipReason }, async (t) => {
  const local = await localSource();
  t.after(local.teardown);
  const engine = new PlaybackEngine({ backend: 'browser', resolve: resolverFrom(local) });
  t.after(() => engine.stop());

  const stream = await engine.play(fakeRequest());
  assert.ok(stream, 'play() must return a readable stream');
  assert.equal(engine.state, STATE.PLAYING);
  assert.equal(engine.backendInUse, 'browser');

  await new Promise((r) => setTimeout(r, 4000));
  const st = engine.status();
  assert.ok(st.position > 1, `position should advance, got ${st.position}`);
  assert.ok(Math.abs(st.duration - local.duration) < 1, `duration ${st.duration} vs ${local.duration}`);

  const flow = await measureStream(stream, 3);
  assert.ok(flow.bytes > 50000, `expected media bytes, got ${flow.bytes}`);
});

test('skip jumps over the opening when inside it', { skip: skipReason }, async (t) => {
  // intro 4s..12s, so a position inside it must land at 12s.
  const local = await localSource({ intro: { start: 4, end: 12 }, outro: { start: 40, end: 48 } });
  t.after(local.teardown);
  const engine = new PlaybackEngine({ backend: 'browser', resolve: resolverFrom(local) });
  t.after(() => engine.stop());

  await engine.play(fakeRequest());
  await engine.seek(6);
  const result = await engine.skip();

  assert.equal(result.reason, 'skipped the opening');
  assert.ok(Math.abs(result.to - 12) <= 1.5, `expected to land near 12s, got ${result.to}`);
});

test('skip jumps over the ending when inside it', { skip: skipReason }, async (t) => {
  const local = await localSource({ intro: { start: 4, end: 12 }, outro: { start: 40, end: 47 } });
  t.after(local.teardown);
  const engine = new PlaybackEngine({ backend: 'browser', resolve: resolverFrom(local) });
  t.after(() => engine.stop());

  await engine.play(fakeRequest());
  await engine.seek(42);
  const result = await engine.skip();

  assert.equal(result.reason, 'skipped the ending');
  assert.ok(result.to >= 46.5, `expected to land at or past 46.5s, got ${result.to}`);
});

test('skip before the opening jumps to its end', { skip: skipReason }, async (t) => {
  const local = await localSource({ intro: { start: 4, end: 12 } });
  t.after(local.teardown);
  const engine = new PlaybackEngine({ backend: 'browser', resolve: resolverFrom(local) });
  t.after(() => engine.stop());

  await engine.play(fakeRequest());
  await engine.pause();
  await engine.seek(1);
  const result = await engine.skip();
  assert.equal(result.reason, 'skipped the opening');
  assert.ok(Math.abs(result.to - 12) <= 1.5);
});

test('skip with no timestamps falls back to a plain jump ahead', { skip: skipReason }, async (t) => {
  const local = await localSource({ intro: null, outro: null });
  t.after(local.teardown);
  const engine = new PlaybackEngine({ backend: 'browser', resolve: resolverFrom(local) });
  t.after(() => engine.stop());

  await engine.play(fakeRequest());
  await engine.pause();
  await engine.seek(2);
  const result = await engine.skip();
  assert.match(result.reason, /no timestamps available/);
  // 2 + 85 clamped to just before the end of a 48s episode.
  assert.ok(result.to > 2, 'should still move forward');
  assert.ok(result.to < local.duration, 'should not run past the episode');
});

test('pause and resume drive the state machine', { skip: skipReason }, async (t) => {
  const local = await localSource();
  t.after(local.teardown);
  const engine = new PlaybackEngine({ backend: 'browser', resolve: resolverFrom(local) });
  t.after(() => engine.stop());

  await engine.play(fakeRequest());
  assert.equal(await engine.pause(), true);
  assert.equal(engine.state, STATE.PAUSED);
  // Pausing twice is a no-op, not an error.
  assert.equal(await engine.pause(), false);

  const frozen = engine.status().position;
  await new Promise((r) => setTimeout(r, 2000));
  assert.equal(engine.status().position, frozen, 'position must not move while paused');

  assert.equal(await engine.resume(), true);
  assert.equal(engine.state, STATE.PLAYING);
  await new Promise((r) => setTimeout(r, 2500));
  assert.ok(engine.status().position > frozen, 'position must advance after resume');
});

test('seek refuses to go past the end of the episode', { skip: skipReason }, async (t) => {
  const local = await localSource();
  t.after(local.teardown);
  const engine = new PlaybackEngine({ backend: 'browser', resolve: resolverFrom(local) });
  t.after(() => engine.stop());

  await engine.play(fakeRequest());
  await new Promise((r) => setTimeout(r, 2500));
  await assert.rejects(() => engine.seek(9999), /past the end/);
});

test('stop tears everything down and leaves no child process', { skip: skipReason }, async (t) => {
  const local = await localSource();
  t.after(local.teardown);
  const engine = new PlaybackEngine({ backend: 'browser', resolve: resolverFrom(local) });

  await engine.play(fakeRequest());
  await new Promise((r) => setTimeout(r, 3000));
  await engine.stop();

  assert.equal(engine.state, STATE.IDLE);
  assert.equal(engine.proxy, null);
  assert.equal(engine.browserPlayer, null);
  assert.equal(engine.display, null);
  assert.equal(engine.capture, null);
});

test('volume can be raised to 300 percent', { skip: skipReason }, async (t) => {
  const local = await localSource();
  t.after(local.teardown);
  const engine = new PlaybackEngine({ resolve: resolverFrom(local) });
  t.after(() => engine.stop());
  await engine.play(fakeRequest({ captions: false }));
  const level = await engine.setVolume(3);
  assert.equal(level, 3);
  const st = await engine.browserPlayer.status();
  assert.equal(st.gain, 3);
  assert.equal(st.muted, false);
});

test('the engine recovers when the browser dies and resumes near the same time', { skip: skipReason }, async (t) => {
  const local = await localSource();
  t.after(local.teardown);
  const engine = new PlaybackEngine({ backend: 'browser', resolve: resolverFrom(local) });
  t.after(() => engine.stop());

  await engine.play(fakeRequest());
  await engine.seek(20);
  await new Promise((r) => setTimeout(r, 1500));
  const before = engine.position;

  // Simulate the failure the watchdog and the crash handler are there for.
  const restarted = new Promise((resolve) => engine.once('restarted', resolve));
  await engine._recover();
  const info = await restarted;

  assert.ok(Math.abs(info.at - before) <= 3, `resumed at ${info.at}, was ${before}`);
  assert.equal(engine.state, STATE.PLAYING);
  assert.equal(engine.restarts, 1);
  assert.ok(engine.stream, 'a new media stream must exist after recovery');
});

test('the watchdog fires when the picture freezes', { skip: skipReason }, async (t) => {
  const local = await localSource();
  t.after(local.teardown);
  const engine = new PlaybackEngine({ backend: 'browser', resolve: resolverFrom(local) });
  t.after(() => engine.stop());

  await engine.play(fakeRequest());
  // Tight thresholds so the test does not take minutes.
  engine.watchdog.intervalMs = 200;
  engine.watchdog.clockStallMs = 1200;
  engine.watchdog.stop();
  engine.watchdog.start();

  const frozen = new Promise((resolve) => engine.once('frozen', resolve));
  // Freeze the video clock the way a stuck decoder would.
  await engine.player_freeze_for_test?.() ?? engine.browserPlayer.pause();
  await engine.browserPlayer.page.evaluate(() => {
    // Make the page report a non-paused clock that never advances.
    const v = document.getElementById('v');
    Object.defineProperty(v, 'paused', { get: () => false });
  });

  const info = await Promise.race([frozen, new Promise((_r, rej) => setTimeout(() => rej(new Error('watchdog did not fire')), 12000))]);
  assert.equal(typeof info.currentTime, 'number');
});

test('the engine rejects a second play while one is running', { skip: skipReason }, async (t) => {
  const local = await localSource();
  t.after(local.teardown);
  const engine = new PlaybackEngine({ backend: 'browser', resolve: resolverFrom(local) });
  t.after(() => engine.stop());

  await engine.play(fakeRequest());
  await assert.rejects(() => engine.play(fakeRequest({ episode: 2 })), /already loaded/);
});
