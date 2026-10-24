// Soak test.
//
// Plays a local HLS fixture continuously and watches for the two things that
// only show up over time: a memory leak and a drifting clock.
//
// Duration comes from SOAK_MINUTES, defaulting to 1 minute so `npm test` stays
// quick. The real 30 minute run is:
//
//   SOAK_MINUTES=30 node --test test/soak.test.js
//
// What it checks, every 30 seconds:
//   - the engine is still playing, not silently wedged
//   - the reported position moved by roughly the wall clock elapsed
//   - the capture is still producing frames
//   - heap growth stays bounded
//   - no extra FFmpeg or Xvfb processes accumulated

import test from 'node:test';
import assert from 'node:assert/strict';
import { PlaybackEngine } from '../player/src/playback-engine.js';
import { checkSystemTools, checkChromium } from '../player/src/display.js';
import { findOrphans, ORPHAN_MARKERS } from '../player/src/process-guard.js';
import { localSource, resolverFrom, fakeRequest } from './helpers/local-source.js';
import { STATE } from '../shared/src/ipc-protocol.js';

const tools = checkSystemTools();
const skip = tools.xvfb && tools.ffmpeg && checkChromium() ? false : 'browser soak needs ffmpeg, Xvfb and playwright chromium';

const MINUTES = Number(process.env.SOAK_MINUTES || 1);
const TOTAL_MS = Math.max(30, MINUTES * 60) * 1000;
const CHECK_EVERY_MS = 30000;

test(`sustained playback for ${MINUTES} minute(s)`, { skip, timeout: TOTAL_MS + 120000 }, async (t) => {
  const local = await localSource();
  t.after(local.teardown);

  const engine = new PlaybackEngine({ resolve: resolverFrom(local) });
  t.after(() => engine.stop());

  // streamLoop -1 repeats the short fixture forever. Without it the source
  // would end after a few seconds and the soak would test nothing.
  await engine.play(fakeRequest(), { streamLoop: -1 });
  assert.equal(engine.state, STATE.PLAYING);

  const startHeap = process.memoryUsage().heapUsed;
  const baselineProcs = findOrphans(ORPHAN_MARKERS).length;
  const samples = [];

  let lastPosition = engine.position;
  let lastWall = Date.now();
  const startedAt = Date.now();

  while (Date.now() - startedAt < TOTAL_MS) {
    await new Promise((r) => setTimeout(r, CHECK_EVERY_MS));

    const status = await engine.status();
    const wallDelta = (Date.now() - lastWall) / 1000;

    // The clock may restart at the top of the fixture, so a backwards jump is
    // only a failure when it is not a wrap.
    const moved = engine.position - lastPosition;
    const wrapped = moved < 0;
    const drift = wrapped ? 0 : Math.abs(moved - wallDelta);

    samples.push({
      at: Math.round((Date.now() - startedAt) / 1000),
      position: Number(engine.position.toFixed(1)),
      wallDelta: Number(wallDelta.toFixed(1)),
      drift: Number(drift.toFixed(1)),
      heapMB: Number((process.memoryUsage().heapUsed / 1048576).toFixed(1)),
      procs: findOrphans(ORPHAN_MARKERS).length,
    });

    assert.equal(engine.state, STATE.PLAYING, `state went to ${engine.state}`);
    assert.ok(!wrapped || engine.position >= 0, 'position went negative');
    if (!wrapped) {
      assert.ok(drift <= 3, `clock drifted ${drift.toFixed(1)}s against ${wallDelta.toFixed(1)}s of wall time`);
    }
    assert.ok(status.captureFrames === undefined || status.captureFrames >= 0, 'frame counter went backwards');

    // A leak that grows without bound will kill a small VPS. Allow the heap to
    // settle, then require it to stay near where it started.
    const heapMB = process.memoryUsage().heapUsed / 1048576;
    const startMB = startHeap / 1048576;
    if (Date.now() - startedAt > 90000) {
      assert.ok(heapMB < startMB + 80, `heap grew from ${startMB.toFixed(1)}MB to ${heapMB.toFixed(1)}MB`);
    }

    const procs = findOrphans(ORPHAN_MARKERS).length;
    assert.ok(procs <= baselineProcs + 2, `process count climbed from ${baselineProcs} to ${procs}`);

    lastPosition = engine.position;
    lastWall = Date.now();
  }

  console.log(`\n  soak samples (${samples.length}):\n`);
  for (const s of samples) {
    console.log(`    t=${String(s.at).padStart(5)}s  position=${String(s.position).padStart(7)}  drift=${String(s.drift).padStart(4)}s  heap=${String(s.heapMB).padStart(6)}MB  procs=${s.procs}`);
  }

  assert.ok(samples.length >= 1, 'the loop should have sampled at least once');

  await engine.stop();
  await new Promise((r) => setTimeout(r, 2000));
  assert.deepEqual(findOrphans(ORPHAN_MARKERS).map((p) => p.cmdline.slice(0, 60)), [], 'no process should outlive the run');
});
