#!/usr/bin/env node
// Pipeline diagnostics.
//
// Checks every part of the capture path on this machine, using a locally
// generated test clip rather than the network. Nothing here needs a Discord
// token or a real episode, so it is safe to run any time:
//
//   node scripts/diagnose.js
//
// It prints one line per check and exits non-zero if anything failed.

import fs from 'node:fs';
import { checkSystemTools } from '../player/src/display.js';
import { PlaybackEngine } from '../player/src/playback-engine.js';
import { STATE } from '../shared/src/ipc-protocol.js';
import { describePanel, buildContainer } from '../shared/src/panel.js';
import { googleSearchUrl } from '../shared/src/urls.js';
import { IpcServer } from '../streamer/src/ipc-server.js';
import { IpcClient } from '../streamer/src/ipc-client.js';
import { findOrphans, ORPHAN_MARKERS } from '../player/src/process-guard.js';
import * as discord from 'discord.js';
import {
  startBrowserStack,
  recordCapture,
  probe,
  frameAt,
  measureStream,
  makeHlsFixture,
  cleanupFixture,
} from '../test/helpers/harness.js';
import { localSource, resolverFrom, fakeRequest } from '../test/helpers/local-source.js';

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

const results = [];

function pass(name, detail) {
  results.push({ name, ok: true, detail });
  console.log(`  ${GREEN}PASS${RESET}  ${name}${detail ? `  ${DIM}${detail}${RESET}` : ''}`);
}

function fail(name, detail) {
  results.push({ name, ok: false, detail });
  console.log(`  ${RED}FAIL${RESET}  ${name}${detail ? `  ${detail}` : ''}`);
}

function skip(name, detail) {
  results.push({ name, ok: null, detail });
  console.log(`  ${DIM}SKIP${RESET}  ${name}  ${detail}`);
}

function section(title) {
  console.log(`\n${title}`);
}

async function check(name, fn) {
  try {
    const detail = await fn();
    pass(name, detail);
  } catch (err) {
    fail(name, err.message);
  }
}

async function main() {
  console.log('Jinx pipeline diagnostics');

  section('1. System tools');
  const tools = checkSystemTools();
  for (const [name, present] of Object.entries(tools)) {
    if (present) pass(name, 'found');
    else fail(name, 'not installed. run: npm run setup');
  }
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (nodeMajor >= 22) pass('node', process.versions.node);
  else fail('node', `${process.versions.node}, the streaming library wants >=22.4.0`);

  if (!tools.ffmpeg || !tools.xvfb) {
    console.log('\nCannot continue without ffmpeg and Xvfb.');
    return summarise();
  }

  section('2. Titles and the browser-only engine');
  try {
    const { lookup } = await import('../shared/src/metadata.js');
    const meta = await lookup({ malId: 21 });
    if (meta.title && !/^MAL\s+21$/i.test(meta.title) && meta.logoUrl) {
      pass('MAL 21 resolves', `${meta.title} via ${meta.source}`);
    } else {
      fail('MAL 21 resolves', JSON.stringify(meta));
    }
  } catch (err) {
    fail('MAL 21 resolves', err.message);
  }
  const engine = new PlaybackEngine({ log: () => {} });
  if (engine.backendPreference === 'browser' && typeof engine.setVolume === 'function') {
    pass('browser only', 'no direct ffmpeg playback path');
  } else {
    fail('browser only', engine.backendPreference);
  }

  section('3. Browser backend and capture');
  const stack = await startBrowserStack({ disguised: true, log: () => {} });
  try {
    const st = await stack.player.status();
    if (st.phase === 'playing') pass('chromium plays HLS', `${st.videoWidth}x${st.videoHeight}, ${st.duration.toFixed(1)}s`);
    else fail('chromium plays HLS', `phase ${st.phase}, error ${st.error}`);

    const rec = await recordCapture({ display: stack.display, audio: stack.audio, seconds: 8, log: () => {} });
    const info = probe(rec.file);
    const video = info.streams.find((s) => s.codec_type === 'video');
    const audio = info.streams.find((s) => s.codec_type === 'audio');

    if (video?.codec_name === 'h264' && video.width === 1920 && video.height === 1080) {
      pass('video is 1080p H.264', `${video.codec_name} ${video.width}x${video.height}`);
    } else {
      fail('video is 1080p H.264', video ? `${video.codec_name} ${video.width}x${video.height}` : 'no video stream');
    }

    if (audio?.codec_name === 'opus') pass('audio is Opus', `${audio.codec_name} ${audio.sample_rate}Hz`);
    else fail('audio is Opus', audio ? `${audio.codec_name}` : 'no audio stream');

    // The two streams should start within a frame or two of each other.
    const vStart = Number(video?.start_time || 0);
    const aStart = Number(audio?.start_time || 0);
    const offsetMs = Math.abs(vStart - aStart) * 1000;
    if (offsetMs < 120) pass('A/V sync', `offset ${offsetMs.toFixed(1)}ms`);
    else fail('A/V sync', `offset ${offsetMs.toFixed(0)}ms, that is out of sync`);

    const a = frameAt(rec.file, 1);
    const b = frameAt(rec.file, 3);
    const c = frameAt(rec.file, 6);
    if (!a.equals(b) && !b.equals(c) && !a.equals(c)) pass('the picture changes', 'frames at 1s, 3s and 6s all differ');
    else fail('the picture changes', 'two of the sampled frames are identical');

    try { fs.unlinkSync(rec.file); } catch { /* already gone */ }
  } finally {
    await stack.teardown();
  }

  section('4. Control panel');
  await check('Components V2 container renders', () => {
    // The same state object the controller builds, so this checks the real
    // shape rather than a guess at it.
    const descriptor = describePanel({
      title: 'One Piece',
      episode: 1,
      searchUrl: googleSearchUrl('One Piece', 1),
      logoUrl: null,
      position: 42,
      duration: 1440,
      audio: 'dub',
      captions: true,
      state: 'playing',
      error: null,
      autoplay: false,
      resumeFrom: 0,
      episodeCount: 1000,
    });
    // The real controller passes discord.js builders. A plain object with the
    // same shape is enough to prove the layout is built.
    // buildContainer returns the builder; discord.js serialises it on send, so
    // toJSON is what actually goes over the wire.
    const container = buildContainer(descriptor, discord).toJSON();
    if (container.type !== 17) throw new Error(`container type is ${container.type}, expected 17`);
    if (container.accent_color !== undefined) throw new Error('the container must not set an accent colour');
    const rows = container.components.filter((c) => c.type === 1);
    if (rows.length !== 2) throw new Error(`expected 2 button rows, found ${rows.length}`);
    const buttons = rows.flatMap((r) => r.components);
    return `${buttons.length} buttons, ${container.components.length} top level components`;
  });

  section('5. IPC between controller and streamer');
  const server = new IpcServer({ port: 0, token: 'diagnose-token' });
  await server.start();
  try {
    const client = new IpcClient({ baseUrl: server.url, token: 'diagnose-token' });
    server.on('command', async (type) => ({ state: STATE.PLAYING, echo: type }));

    const status = await client.status();
    if (status.ok && status.echo === 'status') pass('command round trip', 'play/pause/seek/skip/stop/status all share this path');
    else fail('command round trip', JSON.stringify(status));

    const unauthorised = await fetch(`${server.url}/cmd/status`, { method: 'POST', body: '{}' });
    if (unauthorised.status === 401) pass('token is enforced', 'a request without the token gets 401');
    else fail('token is enforced', `got ${unauthorised.status}, expected 401`);
  } finally {
    await server.stop();
  }

  section('6. Leftover processes');
  await new Promise((r) => setTimeout(r, 1500));
  const orphans = findOrphans(ORPHAN_MARKERS);
  if (orphans.length === 0) pass('nothing left running', 'no orphaned ffmpeg or Xvfb');
  else fail('nothing left running', `${orphans.length} orphan(s): ${orphans.map((p) => p.cmdline.slice(0, 50)).join('; ')}`);

  return summarise();
}

function summarise() {
  const failed = results.filter((r) => r.ok === false);
  const passed = results.filter((r) => r.ok === true).length;
  const skipped = results.filter((r) => r.ok === null).length;
  console.log(`\n${'-'.repeat(62)}`);
  console.log(`  ${passed} passed, ${failed.length} failed, ${skipped} skipped`);
  if (failed.length) {
    console.log('\n  Failed checks:');
    for (const f of failed) console.log(`    - ${f.name}: ${f.detail}`);
    console.log();
    process.exitCode = 1;
  } else {
    console.log('  The pipeline on this machine is ready.');
  }
  console.log();
  return process.exitCode || 0;
}

main().catch((err) => {
  console.error('\ndiagnostics crashed:', err);
  process.exit(1);
});
