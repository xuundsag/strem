// Integration: the real resolver, the real HLS proxy and the real engine,
// pointed at a local server that imitates megaplay.buzz.
//
// Nothing here is mocked at the module boundary. The only fake thing is the
// server at the other end of the socket, and it answers with the shapes captured
// from the live API (see docs/API.md).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startMockMegaplay } from '../helpers/mock-megaplay.js';
import { makeHlsFixture, cleanupFixture, probe, TOTAL_SECONDS } from '../helpers/harness.js';
import { resolveEpisode, resolveEpisodeWithFallbacks, parseEmbedPage, normaliseSources, EpisodeNotFoundError, LanguageUnavailableError } from '../../shared/src/megaplay.js';
import { HlsProxy } from '../../player/src/hls-proxy.js';
import { PlaybackEngine } from '../../player/src/playback-engine.js';
import { STATE } from '../../shared/src/ipc-protocol.js';
import { checkSystemTools, checkChromium } from '../../player/src/display.js';

const tools = checkSystemTools();
const needsFfmpeg = tools.ffmpeg ? false : 'ffmpeg is not installed';
const needsBrowser = tools.ffmpeg && tools.xvfb && checkChromium() ? false : 'browser playback needs ffmpeg, Xvfb and playwright chromium';

/** Start a mock server around a real fixture directory. */
async function setup(behaviour) {
  const fixture = makeHlsFixture({ disguised: true });
  const mock = await startMockMegaplay({ mediaDir: fixture.dir, behaviour });
  return {
    fixture,
    mock,
    teardown: async () => {
      await mock.close();
      cleanupFixture(fixture.dir);
    },
  };
}

test('the resolver walks the whole chain against a megaplay-shaped server', async (t) => {
  const { mock, teardown } = await setup();
  t.after(teardown);

  const source = await resolveEpisode({ malId: 21, episode: 4, lang: 'sub', baseUrl: mock.baseUrl });

  assert.equal(source.malId, 21);
  assert.equal(source.episode, 4);
  assert.equal(source.lang, 'sub');
  assert.equal(source.megaplayId, '100004', 'the sources call must use data-id');
  assert.equal(source.realId, '200000');
  assert.deepEqual(source.intro, { start: 31, end: 111 });
  assert.deepEqual(source.outro, { start: 1215, end: 1307 });
  assert.equal(source.captions.length, 1);
  assert.equal(source.captions[0].label, 'English');
  // The video path is derived from the subtitle URL, with no browser involved.
  assert.match(source.masterUrl, /\/anime\/aaa\/bbb\/master\.m3u8$/);
  assert.equal(source.server, 4);

  assert.equal(mock.state.embedHits, 1);
  assert.equal(mock.state.sourceHits, 1);
});

test('a missing dub is detected from the language the player actually loaded', async (t) => {
  const { mock, teardown } = await setup({ noDubFor: new Set(['21:4']) });
  t.after(teardown);

  await assert.rejects(
    () => resolveEpisode({ malId: 21, episode: 4, lang: 'dub', baseUrl: mock.baseUrl }),
    (err) => {
      assert.ok(err instanceof LanguageUnavailableError);
      assert.deepEqual(err.available, ['sub']);
      assert.match(err.message, /no dubbed version/i);
      return true;
    },
  );
});

test('the fallback resolver switches to sub when dub is unavailable', async (t) => {
  const { mock, teardown } = await setup({ noDubFor: new Set(['21:4']) });
  t.after(teardown);

  const result = await resolveEpisodeWithFallbacks({ malId: 21, episode: 4, lang: 'dub', baseUrl: mock.baseUrl });
  assert.equal(result.requestedLang, 'dub');
  assert.equal(result.actualLang, 'sub');
  assert.equal(result.source.lang, 'sub');
  assert.equal(result.fallbacks.length, 1);
  assert.match(result.fallbacks[0], /falling back to sub/i);
});

test('an unknown episode is reported as not found, not as a server error', async (t) => {
  const { mock, teardown } = await setup({ missingEpisodes: new Set(['21:9999']) });
  t.after(teardown);

  await assert.rejects(
    () => resolveEpisode({ malId: 21, episode: 9999, lang: 'sub', baseUrl: mock.baseUrl }),
    (err) => {
      assert.ok(err instanceof EpisodeNotFoundError);
      assert.equal(err.retryable, false, 'a 404 must not be retried');
      return true;
    },
  );
});

test('an empty source list is a hard failure', async (t) => {
  const { mock, teardown } = await setup({ emptySources: true });
  t.after(teardown);

  await assert.rejects(
    () => resolveEpisode({ malId: 21, episode: 4, lang: 'sub', baseUrl: mock.baseUrl }),
    /empty source list/i,
  );
});

test('the proxy serves a megaplay-shaped playlist to ffmpeg', { skip: needsFfmpeg }, async (t) => {
  const { mock, teardown } = await setup();
  t.after(teardown);

  const source = await resolveEpisode({ malId: 21, episode: 4, lang: 'sub', baseUrl: mock.baseUrl });
  const proxy = new HlsProxy({ masterUrl: source.masterUrl });
  await proxy.start();
  t.after(() => proxy.stop());

  // The fixture is a flat media playlist, so its lines are segments directly.
  const playlist = await (await fetch(proxy.playlistUrl)).text();
  assert.match(playlist, /#EXTM3U/);

  const segmentUrl = playlist.split('\n').find((l) => l.trim() && !l.startsWith('#'));
  assert.match(segmentUrl, /\/m\/\d+\.ts$/, 'segments must carry .ts so ffmpeg accepts them');
  assert.ok(segmentUrl.startsWith(proxy.playlistUrl.replace(/\/m\/[^/]*$/, '')), 'the URI must point at the proxy');

  const segment = await fetch(segmentUrl);
  assert.equal(segment.status, 200);
  assert.equal(segment.headers.get('content-type'), 'video/mp2t', 'the lying jpeg type must be corrected');
  const bytes = Buffer.from(await segment.arrayBuffer());
  assert.equal(bytes[0], 0x47, 'first byte of an MPEG-TS packet');
  assert.ok(mock.state.segmentHits >= 1);
});

test('the engine plays a resolved episode end to end', { skip: needsBrowser }, async (t) => {
  const { mock, teardown } = await setup();
  t.after(teardown);

  const engine = new PlaybackEngine({
    resolve: (req) =>
      resolveEpisodeWithFallbacks({ malId: req.malId, episode: req.episode, lang: req.audio, baseUrl: mock.baseUrl }).then(
        (r) => ({ source: r.source, fallbacks: r.fallbacks }),
      ),
  });
  t.after(() => engine.stop());

  const stream = await engine.play({
    malId: 21, episode: 4, audio: 'sub', captions: false,
    guildId: '123456789012345678', channelId: '987654321098765432',
  });

  assert.equal(engine.state, STATE.PLAYING);
  assert.equal(engine.backendInUse, 'browser');

  const file = `/tmp/integration-${Date.now()}.nut`;
  const out = fs.createWriteStream(file);
  stream.pipe(out);
  await new Promise((r) => setTimeout(r, 6000));
  stream.unpipe(out);

  const info = probe(file);
  const video = info.streams.find((s) => s.codec_type === 'video');
  const audio = info.streams.find((s) => s.codec_type === 'audio');
  assert.equal(video.codec_name, 'h264');
  assert.equal(video.width, 1920);
  assert.equal(video.height, 1080);
  assert.equal(audio.codec_name, 'opus');
  assert.ok(Number(info.format.duration) > 3, `expected several seconds of media, got ${info.format.duration}`);
  fs.rmSync(file, { force: true });
});

test('parseEmbedPage reads every field the chain depends on', () => {
  const page = parseEmbedPage(
    `<title>File 178727 - MegaPlay</title><script>window.settings = { type: 'dub', cid:'4e4f' };</script>` +
      '<div id="megaplay-player" data-id="178727" data-realid="751819" data-mediaid="8894"></div>',
  );
  assert.deepEqual(page, {
    found: true,
    mediaId: '178727',
    realId: '751819',
    dataMediaId: '8894',
    settingsType: 'dub',
    title: 'File 178727 - MegaPlay',
  });
});

test('parseEmbedPage recognises both real error pages', () => {
  const notFound = parseEmbedPage('<title>Error - MegaPlay</title>Error Code: <span>404</span>');
  assert.equal(notFound.found, false);
  assert.equal(notFound.errorCode, '404');

  const removed = parseEmbedPage('<title>Error - MegaPlay</title>We can\'t find the file. Error Code: <span>410</span>');
  assert.equal(removed.found, false);
  assert.equal(removed.errorCode, '410');
  assert.match(removed.reason, /not find the file|episode not found/i);

  assert.equal(parseEmbedPage('').found, false);
  assert.equal(parseEmbedPage(null).found, false);
});

test('normaliseSources drops zero-length intro and outro markers', () => {
  const withMarkers = normaliseSources({
    tracks: [{ file: 'https://cdn/a/b/subtitles/x.vtt', kind: 'captions', label: 'English', default: true }],
    intro: { start: 31, end: 111 },
    outro: { start: 0, end: 0 },
  });
  assert.deepEqual(withMarkers.intro, { start: 31, end: 111 });
  assert.equal(withMarkers.outro, null, 'a zero-length outro means there is no outro');
});

test('normaliseSources keeps captions separate from thumbnail tracks', () => {
  const result = normaliseSources({
    tracks: [
      { file: 'https://cdn/a/b/subtitles/eng.vtt', kind: 'captions', label: 'English' },
      { file: 'https://cdn/a/b/subtitles/fre.vtt', kind: 'captions', label: 'French' },
      { file: 'https://cdn/a/b/preview/thumbnails.vtt', kind: 'thumbnails' },
    ],
  });
  assert.equal(result.captions.length, 2, 'the thumbnail track is not a caption track');
  assert.deepEqual(result.captions.map((c) => c.label), ['English', 'French']);
});

test('every URI in a rewritten playlist points at the proxy', async (t) => {
  const { mock, teardown } = await setup();
  t.after(teardown);

  const source = await resolveEpisode({ malId: 21, episode: 4, lang: 'sub', baseUrl: mock.baseUrl });
  const proxy = new HlsProxy({ masterUrl: source.masterUrl });
  await proxy.start();
  t.after(() => proxy.stop());

  const origin = proxy.playlistUrl.replace(/\/m\/[^/]*$/, '');
  const playlist = await (await fetch(proxy.playlistUrl)).text();
  const uris = playlist.split('\n').filter((l) => l.trim() && !l.startsWith('#'));
  assert.ok(uris.length > 0, 'the playlist should list segments');
  for (const uri of uris) {
    assert.ok(uri.startsWith(origin), `${uri} was not rewritten through the proxy`);
    assert.doesNotMatch(uri, /127\.0\.0\.1:\d+\/anime\//, 'no upstream URL should leak into the playlist');
  }
  // Attribute style URIs are rewritten too, which matters for EXT-X-MAP and
  // EXT-X-KEY in real playlists.
  assert.doesNotMatch(playlist, /URI="https?:\/\/(?!127\.0\.0\.1)/, 'attribute URIs must be rewritten as well');
});

test('the engine reports the episode length once media starts', { skip: needsBrowser }, async (t) => {
  const { mock, teardown } = await setup();
  t.after(teardown);

  const engine = new PlaybackEngine({
    resolve: (req) => resolveEpisodeWithFallbacks({ malId: req.malId, episode: req.episode, lang: req.audio, baseUrl: mock.baseUrl }),
  });
  t.after(() => engine.stop());

  await engine.play({ malId: 21, episode: 4, audio: 'sub', captions: false, guildId: '1'.padEnd(18, '0'), channelId: '2'.padEnd(18, '0') });
  const status = engine.status();
  assert.equal(status.source.malId, 21);
  assert.equal(status.source.episode, 4);
  assert.deepEqual(status.source.intro, { start: 31, end: 111 });
  assert.equal(status.source.captionCount, 1);
});
