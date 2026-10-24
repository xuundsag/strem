// Unit tests for the URL builders.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  googleSearchUrl, megaplayEmbedByMal, megaplayEmbedByEpisodeId, megaplaySources,
  anikotoRecent, anikotoSeries, masterPlaylistFromTrackUrl, mediaLocationFromTrackUrl,
  formatEpisodeForUrl, mediaHeaders, MEGAPLAY_BASE,
} from '../../shared/src/urls.js';

test('googleSearchUrl encodes the title and episode', () => {
  assert.equal(
    googleSearchUrl('One Piece', 1),
    'https://www.google.com/search?q=One%20Piece%20episode%201',
  );
  // Special characters must not break the link.
  const u = googleSearchUrl("JoJo's Bizarre Adventure: Part 7", 3);
  assert.ok(u.startsWith('https://www.google.com/search?q='));
  assert.ok(u.includes('%3A'), 'colon should be encoded');
  // encodeURIComponent leaves the apostrophe alone because RFC 3986 lists it as
  // unreserved, and Google accepts it. Assert the round trip instead.
  const q = new URL(u).searchParams.get('q');
  assert.equal(q, "JoJo's Bizarre Adventure: Part 7 episode 3");
});

test('googleSearchUrl survives titles that would break a naive query string', () => {
  for (const title of ['A&B', 'a=b', 'x?y', '100% sure', 're:zero']) {
    const u = googleSearchUrl(title, 12);
    const roundTrip = new URL(u).searchParams.get('q');
    assert.equal(roundTrip, `${title} episode 12`, `title ${title} should survive encoding`);
  }
});

test('megaplayEmbedByMal builds the MAL route', () => {
  assert.equal(megaplayEmbedByMal(21, 1, 'sub'), `${MEGAPLAY_BASE}/stream/mal/21/1/sub`);
  assert.equal(megaplayEmbedByMal(21, 1, 'dub'), `${MEGAPLAY_BASE}/stream/mal/21/1/dub`);
});

test('megaplayEmbedByMal keeps fractional episode numbers', () => {
  assert.equal(megaplayEmbedByMal(21, 1045.5, 'sub'), `${MEGAPLAY_BASE}/stream/mal/21/1045.5/sub`);
});

test('megaplayEmbedByEpisodeId builds the catalogue route', () => {
  assert.equal(megaplayEmbedByEpisodeId(751819, 'dub'), `${MEGAPLAY_BASE}/stream/s-2/751819/dub`);
});

test('megaplaySources targets the id that actually resolves', () => {
  assert.equal(megaplaySources(36396), `${MEGAPLAY_BASE}/stream/getSources?id=36396&platform=OTHER`);
});

test('anikoto endpoints match the documented shapes', () => {
  assert.equal(anikotoRecent(2, 50), 'https://anikotoapi.site/recent-anime?page=2&per_page=50');
  assert.equal(anikotoSeries(8854), 'https://anikotoapi.site/series/8854');
});

test('masterPlaylistFromTrackUrl derives the video path from a subtitle URL', () => {
  const track = 'https://j1i9s.embermeadow.world/anime/f899139df5e1059396431415e770c6dd/61b87186ab260d05003427e16ccf5657/subtitles/track_0_eng.vtt';
  assert.equal(
    masterPlaylistFromTrackUrl(track),
    'https://j1i9s.embermeadow.world/anime/f899139df5e1059396431415e770c6dd/61b87186ab260d05003427e16ccf5657/master.m3u8',
  );
});

test('masterPlaylistFromTrackUrl also works for the thumbnail track', () => {
  const track = 'https://cdn.example/anime/aaa/bbb/preview/thumbnails.vtt';
  assert.equal(masterPlaylistFromTrackUrl(track), 'https://cdn.example/anime/aaa/bbb/master.m3u8');
});

test('masterPlaylistFromTrackUrl returns null for anything unexpected', () => {
  assert.equal(masterPlaylistFromTrackUrl('not a url'), null);
  assert.equal(masterPlaylistFromTrackUrl(null), null);
  assert.equal(masterPlaylistFromTrackUrl('https://cdn.example/anime/aaa/bbb/segments/seg.ts'), null);
});

test('mediaLocationFromTrackUrl splits scheme, host and path', () => {
  const loc = mediaLocationFromTrackUrl('https://cdn.example/anime/aaa/bbb/subtitles/x.vtt');
  assert.deepEqual(loc, {
    scheme: 'https',
    host: 'cdn.example',
    path: 'anime/aaa/bbb',
    origin: 'https://cdn.example',
    master: 'https://cdn.example/anime/aaa/bbb/master.m3u8',
  });
});

test('mediaLocationFromTrackUrl keeps a plain http origin intact', () => {
  // A mirror or the test server may be plain http, and forcing https there
  // makes every request fail with an SSL error.
  const loc = mediaLocationFromTrackUrl('http://127.0.0.1:8080/anime/aaa/bbb/preview/thumbnails.vtt');
  assert.equal(loc.scheme, 'http');
  assert.equal(loc.origin, 'http://127.0.0.1:8080');
  assert.equal(loc.master, 'http://127.0.0.1:8080/anime/aaa/bbb/master.m3u8');
});

test('formatEpisodeForUrl prints integers without decimals', () => {
  assert.equal(formatEpisodeForUrl(1), '1');
  assert.equal(formatEpisodeForUrl(1.0), '1');
  assert.equal(formatEpisodeForUrl(1045.5), '1045.5');
});

test('mediaHeaders always carries the Referer the CDN requires', () => {
  const h = mediaHeaders();
  assert.equal(h.Referer, 'https://megaplay.buzz/');
  assert.ok(/Mozilla/.test(h['User-Agent']));
});
