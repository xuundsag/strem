import test from 'node:test';
import assert from 'node:assert/strict';
import { fromAnilist, presentTitle, lookup } from '../../shared/src/metadata.js';

test('an all caps title is shown in title case', () => {
  assert.equal(presentTitle('ONE PIECE'), 'One Piece');
  assert.equal(presentTitle('Spy x Family'), 'Spy x Family');
});

test('anilist media becomes a title and a poster', () => {
  const hit = fromAnilist({
    data: {
      Media: {
        title: { english: 'ONE PIECE', romaji: 'ONE PIECE' },
        episodes: null,
        coverImage: { extraLarge: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx21.jpg' },
      },
    },
  });
  assert.equal(hit.title, 'One Piece');
  assert.match(hit.poster, /^https:\/\//);
  assert.equal(hit.episodeCount, null);
});

test('MAL 21 resolves to One Piece with a thumbnail', async () => {
  const meta = await lookup({ malId: 21 });
  assert.equal(meta.title, 'One Piece');
  assert.notEqual(meta.source, 'none');
  assert.match(meta.logoUrl, /^https:\/\//);
});
