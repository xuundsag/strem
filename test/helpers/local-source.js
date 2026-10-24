// A source resolver for tests.
//
// The engine expects the shape the megaplay client returns. These helpers build
// that shape around the locally generated HLS fixture, so engine tests exercise
// the real playback code without touching the network.

import { serveDir, makeHlsFixture, cleanupFixture, TOTAL_SECONDS } from './harness.js';

/**
 * Serve the fixture and return { source, teardown }.
 *
 * @param {object} [o]
 * @param {{start:number,end:number}|null} [o.intro]
 * @param {{start:number,end:number}|null} [o.outro]
 * @param {number} [o.malId]
 * @param {number} [o.episode]
 * @param {'sub'|'dub'} [o.lang]
 */
export async function localSource({ intro = null, outro = null, malId = 21, episode = 1, lang = 'sub' } = {}) {
  const fixture = makeHlsFixture({ disguised: true });
  const dir = await serveDir(fixture.dir, {
    contentTypeFor: (f) => (f.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : f.endsWith('.vtt') ? 'text/vtt' : 'image/jpeg'),
  });

  const source = {
    malId,
    episode,
    lang,
    megaplayId: '1',
    realId: '1',
    embedUrl: `${dir.base}/master.m3u8`,
    masterUrl: `${dir.base}/master.m3u8`,
    cdnHost: new URL(dir.base).host,
    mediaPath: 'local',
    captions: [{ file: `${dir.base}/captions.vtt`, label: 'English', default: true }],
    intro,
    outro,
    server: 4,
    poster: null,
  };

  return {
    source,
    fixture,
    base: dir.base,
    duration: TOTAL_SECONDS,
    teardown: async () => {
      await dir.close().catch(() => {});
      cleanupFixture(fixture.dir);
    },
  };
}

/** Wrap a local source as the resolver function the engine takes. */
export function resolverFrom(local) {
  return async (req) => ({
    source: { ...local.source, malId: req.malId, episode: req.episode, lang: req.audio },
    fallbacks: [],
  });
}

/** A minimal valid play request for engine tests. */
export function fakeRequest(overrides = {}) {
  return {
    malId: 21,
    episode: 1,
    audio: 'sub',
    captions: true,
    guildId: '123456789012345678',
    channelId: '987654321098765432',
    requesterId: '111111111111111111',
    ...overrides,
  };
}
