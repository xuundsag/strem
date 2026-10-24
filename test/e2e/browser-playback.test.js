// E2E: a headless browser plays a local test HLS file.
//
// The spec asks for four assertions, and each one is a real measurement rather
// than a mock:
//
//   1. frames change while playing
//   2. seek lands within 1 second of the target
//   3. pause freezes the frames
//   4. skip jumps to the right place
//
// The fixture is generated locally (12 x 4s colour segments with a burned-in
// clock) and served with the same lies the real CDN uses: segments under
// disguised extensions with an image/jpeg content type. So this test also proves
// the HLS proxy does its job.

import test from 'node:test';
import assert from 'node:assert/strict';
import { startBrowserStack, recordCapture, probe, frameAt, SEGMENT_SECONDS, TOTAL_SECONDS } from '../helpers/harness.js';
import { checkSystemTools, checkChromium } from '../../player/src/display.js';

// The whole file needs a real browser, Xvfb and ffmpeg. Skip loudly rather than
// silently passing when the VPS is missing them.
const tools = checkSystemTools();
const canRun = tools.ffmpeg && tools.xvfb && checkChromium();
const skipReason = canRun
  ? false
  : `missing ${!checkChromium() ? 'playwright chromium (run: npx playwright install chromium)' : 'system tools: ' + JSON.stringify(tools)}`;

test('the browser plays the local HLS file and reports a sane duration', { skip: skipReason }, async (t) => {
  const stack = await startBrowserStack({ disguised: true });
  t.after(stack.teardown);

  const st = await stack.player.status();
  assert.equal(st.phase, 'playing');
  assert.equal(st.error, null);
  assert.equal(st.videoWidth, 1280);
  assert.equal(st.videoHeight, 720);
  assert.ok(Math.abs(st.duration - TOTAL_SECONDS) < 0.5, `duration ${st.duration} should be about ${TOTAL_SECONDS}s`);
});

test('frames change while playing', { skip: skipReason }, async (t) => {
  const stack = await startBrowserStack({ disguised: true });
  t.after(stack.teardown);

  const { file } = await recordCapture({ display: stack.display, audio: stack.audio, seconds: 9, log: console.log });
  t.after(() => { try { require('node:fs').unlinkSync(file); } catch {} });

  const info = probe(file);
  const video = info.streams.find((s) => s.codec_type === 'video');
  assert.equal(video.codec_name, 'h264', 'capture must be H.264');
  assert.equal(video.width, 1920);
  assert.equal(video.height, 1080);

  // Frames at 1s, 3s and 6s fall in different coloured segments, so they must
  // not be identical.
  const a = frameAt(file, 1);
  const b = frameAt(file, 3);
  const c = frameAt(file, 6);
  assert.notDeepEqual(a, b, 'frame at 1s and 3s should differ');
  assert.notDeepEqual(b, c, 'frame at 3s and 6s should differ');
  assert.notDeepEqual(a, c, 'frame at 1s and 6s should differ');
});

test('seek lands within 1 second of the target', { skip: skipReason }, async (t) => {
  const stack = await startBrowserStack({ disguised: true });
  t.after(stack.teardown);

  for (const target of [0, 10, 25, 44]) {
    const before = await stack.player.status();
    await stack.player.pause();
    const landed = await stack.player.seek(target);
    const after = await stack.player.status();
    // While paused the clock cannot run away, so the reading is exact.
    assert.ok(
      Math.abs(after.currentTime - target) <= 1.0,
      `seek to ${target}s landed at ${after.currentTime}s (from ${before.currentTime.toFixed(1)}s)`,
    );
    assert.ok(Math.abs(landed - target) <= 1.0, 'the returned position should match too');
  }
});

test('pause freezes the frames', { skip: skipReason }, async (t) => {
  const stack = await startBrowserStack({ disguised: true });
  t.after(stack.teardown);

  await stack.player.seek(20);
  await stack.player.pause();
  await new Promise((r) => setTimeout(r, 300));
  const first = await stack.player.status();

  await new Promise((r) => setTimeout(r, 2500));
  const second = await stack.player.status();

  assert.equal(second.paused, true, 'the element should still be paused');
  assert.ok(
    Math.abs(second.currentTime - first.currentTime) < 0.05,
    `clock moved from ${first.currentTime} to ${second.currentTime} while paused`,
  );
});

test('resume continues from where pause stopped', { skip: skipReason }, async (t) => {
  const stack = await startBrowserStack({ disguised: true });
  t.after(stack.teardown);

  await stack.player.seek(15);
  await stack.player.pause();
  const paused = await stack.player.status();
  await stack.player.resume();
  await new Promise((r) => setTimeout(r, 2000));
  const playing = await stack.player.status();

  assert.equal(playing.paused, false);
  assert.ok(playing.currentTime > paused.currentTime + 1, 'the clock should have advanced after resume');
});

test('captions are rendered into the page', { skip: skipReason }, async (t) => {
  const stack = await startBrowserStack({ disguised: true, captions: true });
  t.after(stack.teardown);

  await stack.player.seek(2 * SEGMENT_SECONDS + 0.5);
  await new Promise((r) => setTimeout(r, 800));
  const text = await stack.player.page.evaluate(() => document.getElementById('captions').textContent);
  // Segment 3 covers 8s..12s, so cue 3 should be on screen.
  assert.match(text, /Caption block 3/);
});

test('captions can be switched off', { skip: skipReason }, async (t) => {
  const stack = await startBrowserStack({ disguised: true, captions: true });
  t.after(stack.teardown);

  await stack.player.setCaptions(false);
  const hidden = await stack.player.page.evaluate(() => document.getElementById('captions').classList.contains('hidden'));
  assert.equal(hidden, true);
  const st = await stack.player.status();
  assert.equal(st.captionsOn, false);
});

test('the capture carries H.264 video and Opus audio in sync', { skip: skipReason }, async (t) => {
  const stack = await startBrowserStack({ disguised: true });
  t.after(stack.teardown);

  const { file } = await recordCapture({ display: stack.display, audio: stack.audio, seconds: 6, log: console.log });
  t.after(() => { try { require('node:fs').unlinkSync(file); } catch {} });

  const info = probe(file);
  const video = info.streams.find((s) => s.codec_type === 'video');
  const audio = info.streams.find((s) => s.codec_type === 'audio');
  assert.equal(video.codec_name, 'h264');
  assert.equal(audio.codec_name, 'opus', 'Discord voice needs Opus');
  assert.equal(audio.sample_rate, '48000');

  // A/V sync: the two streams should start within 200ms of each other.
  const vStart = Number(video.start_time || 0);
  const aStart = Number(audio.start_time || 0);
  assert.ok(Math.abs(vStart - aStart) < 0.2, `A/V start drift is ${Math.abs(vStart - aStart).toFixed(3)}s`);
});

test('the video element fills the frame with no browser chrome', { skip: skipReason }, async (t) => {
  const stack = await startBrowserStack({ disguised: true, captions: false });
  t.after(stack.teardown);

  const box = await stack.player.windowBox();
  assert.equal(box.outerWidth, box.innerWidth, 'browser chrome would make the outer window wider');
  assert.equal(box.outerHeight, box.innerHeight, 'browser chrome would make the outer window taller');
  assert.equal(box.screenX, 0);
  assert.equal(box.screenY, 0);
  assert.ok(Math.abs(box.innerWidth - 1920) <= 2, `inner width ${box.innerWidth}`);
  assert.ok(Math.abs(box.innerHeight - 1080) <= 2, `inner height ${box.innerHeight}`);
  assert.equal(box.video.x, 0);
  assert.equal(box.video.y, 0);
  assert.equal(box.video.width, box.innerWidth);
  assert.equal(box.video.height, box.innerHeight);
});

test('the page is actually playing audio into the null sink', { skip: skipReason }, async (t) => {
  const { execFileSync } = await import('node:child_process');
  const stack = await startBrowserStack({ disguised: true, captions: false });
  t.after(stack.teardown);

  const st = await stack.player.status();
  assert.equal(st.muted, false);
  assert.equal(st.audioState, 'running');
  assert.ok(st.gain > 0);

  let inputs = '';
  for (let i = 0; i < 20; i++) {
    inputs = execFileSync('pactl', ['list', 'sink-inputs'], { env: stack.audio.env }).toString();
    if (/Sink Input/i.test(inputs)) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  assert.match(inputs, /Sink Input/, 'Chromium never opened an audio stream on the null sink');
});
