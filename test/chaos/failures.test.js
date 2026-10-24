// Chaos tests.
//
// Each one breaks something on purpose and checks that the system notices and
// does something sane, rather than hanging or quietly streaming black.
//
//   kill Chromium      the engine restarts it and resumes near the same time
//   drop the network   resolution fails with a clear error, not a hang
//   bad token          the IPC server refuses the request
//   404 episode        reported as "not available", not retried forever
//   empty API response reported as an empty source list
//   orphan processes   nothing is left running after a stop

import test from 'node:test';
import assert from 'node:assert/strict';
import { startMockMegaplay } from '../helpers/mock-megaplay.js';
import { makeHlsFixture, cleanupFixture } from '../helpers/harness.js';
import { localSource, resolverFrom, fakeRequest } from '../helpers/local-source.js';
import { PlaybackEngine } from '../../player/src/playback-engine.js';
import { IpcServer } from '../../streamer/src/ipc-server.js';
import { IpcClient } from '../../streamer/src/ipc-client.js';
import { resolveEpisode } from '../../shared/src/megaplay.js';
import { STATE } from '../../shared/src/ipc-protocol.js';
import { checkSystemTools, checkChromium } from '../../player/src/display.js';
import { findOrphans, ORPHAN_MARKERS, XVFB_MARKER } from '../../player/src/process-guard.js';

const tools = checkSystemTools();
// These two launch a real browser, so they need Playwright's Chromium as well
// as ffmpeg and Xvfb. Skipping beats a raw "executable doesn't exist" failure.
const skipBrowser =
  tools.xvfb && tools.ffmpeg && checkChromium()
    ? false
    : `missing ${!checkChromium() ? 'playwright chromium (run: npx playwright install chromium)' : 'tools: ' + JSON.stringify(tools)}`;

async function mockSetup(behaviour) {
  const fixture = makeHlsFixture({ disguised: true });
  const mock = await startMockMegaplay({ mediaDir: fixture.dir, behaviour });
  return { fixture, mock, teardown: async () => { await mock.close(); cleanupFixture(fixture.dir); } };
}

test('killing Chromium restarts playback and resumes near the same time', { skip: skipBrowser }, async (t) => {
  const local = await localSource();
  t.after(local.teardown);
  const engine = new PlaybackEngine({ backend: 'browser', resolve: resolverFrom(local) });
  t.after(() => engine.stop());

  await engine.play(fakeRequest());
  await engine.seek(24);
  await new Promise((r) => setTimeout(r, 1500));
  const before = engine.position;
  // Playwright's Browser handle has no process(), so find the live browser by
  // its install path. Filtering out --type= leaves the parent, which is the
  // process whose death the engine is supposed to notice.
  await new Promise((r) => setTimeout(r, 1200));
  const chrome = findOrphans(['ms-playwright']).find((p) => !/--type=/.test(p.cmdline));
  assert.ok(chrome, 'there should be a chromium process to kill');
  const browserPid = chrome.pid;

  const restarted = new Promise((resolve) => engine.once('restarted', resolve));
  // The real failure: chromium dies underneath us.
  process.kill(browserPid, 'SIGKILL');

  const info = await Promise.race([
    restarted,
    new Promise((_r, rej) => setTimeout(() => rej(new Error('the engine never recovered')), 45000)),
  ]);

  assert.ok(Math.abs(info.at - before) <= 4, `resumed at ${info.at}, was at ${before}`);
  assert.equal(engine.state, STATE.PLAYING);
  assert.ok(engine.stream, 'a fresh media stream must exist');
  assert.ok(engine.restarts >= 1);
});

test('a server that never answers times out instead of hanging', async (t) => {
  // A port that accepts nothing, so the connection stalls.
  const started = Date.now();
  await assert.rejects(
    () => resolveEpisode({ malId: 21, episode: 1, lang: 'sub', baseUrl: 'http://127.0.0.1:9' }),
    (err) => {
      assert.ok(err, 'should reject');
      return true;
    },
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 20000, `gave up after ${elapsed}ms, expected a bounded wait`);
});

test('a server that closes the connection is retried and then reported', async (t) => {
  const http = await import('node:http');
  let hits = 0;
  const server = http.createServer((_req, res) => {
    hits++;
    res.destroy();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));

  await assert.rejects(() => resolveEpisode({ malId: 21, episode: 1, lang: 'sub', baseUrl: `http://127.0.0.1:${server.address().port}` }));
  assert.ok(hits >= 2, `expected retries, saw ${hits} attempt(s)`);
});

test('the IPC server rejects a request with no token', async (t) => {
  const server = new IpcServer({ port: 0, token: 'correct-horse' });
  await server.start();
  t.after(() => server.stop());

  const res = await fetch(`${server.url}/cmd/status`, { method: 'POST', body: '{}' });
  assert.equal(res.status, 401);

  const wrong = await fetch(`${server.url}/cmd/status`, {
    method: 'POST',
    headers: { authorization: 'Bearer nope' },
    body: '{}',
  });
  assert.equal(wrong.status, 401);
});

test('the IPC server accepts the right token and answers status', async (t) => {
  const server = new IpcServer({ port: 0, token: 'correct-horse' });
  await server.start();
  t.after(() => server.stop());
  server.on('command', async (type) => ({ state: STATE.IDLE, echo: type }));

  const client = new IpcClient({ baseUrl: server.url, token: 'correct-horse' });
  const status = await client.status();
  assert.equal(status.ok, true);
  assert.equal(status.echo, 'status');
});

test('the IPC server refuses an oversized body', async (t) => {
  const server = new IpcServer({ port: 0 });
  await server.start();
  t.after(() => server.stop());

  const res = await fetch(`${server.url}/cmd/play`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ junk: 'x'.repeat(200000) }),
  });
  assert.equal(res.status, 413, 'an oversized body must be refused without reading it');
  const payload = await res.json().catch(() => null);
  assert.ok(payload && payload.error, 'the refusal must say why');
});

test('the IPC server refuses malformed JSON', async (t) => {
  const server = new IpcServer({ port: 0 });
  await server.start();
  t.after(() => server.stop());

  const res = await fetch(`${server.url}/cmd/play`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{ not json',
  });
  assert.equal(res.status, 400);
});

test('an unknown episode is reported once, not retried', async (t) => {
  const { mock, teardown } = await mockSetup({ missingEpisodes: new Set(['21:9999']) });
  t.after(teardown);

  const before = mock.state.embedHits;
  await assert.rejects(() => resolveEpisode({ malId: 21, episode: 9999, lang: 'sub', baseUrl: mock.baseUrl }), /no episode \d+ on the video server|not on the video server|not available/i);
  assert.equal(mock.state.embedHits, before + 1, 'a 404 should be tried exactly once');
});

test('an empty API response is reported as an empty source list', async (t) => {
  const { mock, teardown } = await mockSetup({ emptySources: true });
  t.after(teardown);

  await assert.rejects(
    () => resolveEpisode({ malId: 21, episode: 4, lang: 'sub', baseUrl: mock.baseUrl }),
    /empty source list/i,
  );
});

test('a play request with a bad body is refused with a usable message', async (t) => {
  const server = new IpcServer({ port: 0 });
  await server.start();
  t.after(() => server.stop());
  server.on('command', async () => ({ ok: true }));
  const client = new IpcClient({ baseUrl: server.url });

  await assert.rejects(() => client.play({ malId: -1, episode: 1, audio: 'sub', captions: 'yes', guildId: '1'.padEnd(18, '0'), channelId: '2'.padEnd(18, '0') }), /positive MAL id/);
  await assert.rejects(() => client.play({ malId: 21, episode: 1, audio: 'klingon', captions: 'yes', guildId: '1'.padEnd(18, '0'), channelId: '2'.padEnd(18, '0') }), /sub or dub/);
});

test('seek with no number is refused', async (t) => {
  const server = new IpcServer({ port: 0 });
  await server.start();
  t.after(() => server.stop());
  server.on('command', async () => ({ ok: true }));

  const res = await fetch(`${server.url}/cmd/seek`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ v: 1, type: 'seek' }),
  });
  assert.equal(res.status, 400);
});

test('a streamer with no handler answers that it is not ready', async (t) => {
  const server = new IpcServer({ port: 0 });
  await server.start();
  t.after(() => server.stop());
  const client = new IpcClient({ baseUrl: server.url });

  await assert.rejects(() => client.pause(), /not ready/i);
});

test('no ffmpeg or chromium processes are left behind after a stop', { skip: skipBrowser }, async (t) => {
  const local = await localSource();
  const engine = new PlaybackEngine({ backend: 'browser', resolve: resolverFrom(local) });

  await engine.play(fakeRequest());
  await new Promise((r) => setTimeout(r, 4000));
  const duringPlayback = findOrphans(ORPHAN_MARKERS);
  assert.ok(duringPlayback.length > 0, 'the pipeline should have live processes while playing');

  await engine.stop();
  // Give the kernels a moment to reap the children.
  await new Promise((r) => setTimeout(r, 2500));
  const afterStop = findOrphans(ORPHAN_MARKERS);
  assert.deepEqual(afterStop.map((p) => p.cmdline.slice(0, 60)), [], 'every child should be gone');
  assert.ok(XVFB_MARKER.startsWith('-'), 'the display tag must look like an option to Xvfb');
  t.after(local.teardown);
});

test('the engine surfaces a capture crash instead of streaming nothing', { skip: skipBrowser }, async (t) => {
  const local = await localSource();
  t.after(local.teardown);
  const engine = new PlaybackEngine({ resolve: resolverFrom(local) });
  t.after(() => engine.stop());

  await engine.play(fakeRequest({ captions: false }));
  await new Promise((r) => setTimeout(r, 2000));

  const exited = new Promise((resolve) => engine.once('capture-exit', resolve));
  process.kill(engine.capture.proc.pid, 'SIGKILL');
  const info = await Promise.race([exited, new Promise((_r, rej) => setTimeout(() => rej(new Error('no exit event')), 15000))]);
  assert.ok(info.code !== 0, 'a SIGKILL should not look like a clean exit');
});

test('a streamer that is not running gives a readable error, not a stack trace', async (t) => {
  const client = new IpcClient({ baseUrl: 'http://127.0.0.1:9', timeoutMs: 3000 });
  const err = await client.health().then(() => null, (e) => e);
  assert.ok(err, 'should fail');
  assert.ok(err.message.length > 0);
});
