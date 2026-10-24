import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreTitle, rankTitles, titlesAgree, resolveAnimeName } from '../../shared/src/search.js';

const INDEX = [
  { id: 21, pop: 700000, format: 'TV', episodes: null, titles: ['ONE PIECE', 'One Piece'] },
  { id: 50410, pop: 200000, format: 'MOVIE', episodes: 1, titles: ['One Piece Film: Red'] },
  { id: 38000, pop: 900000, format: 'TV', episodes: 26, titles: ['Demon Slayer: Kimetsu no Yaiba', 'Kimetsu no Yaiba'] },
  { id: 51019, pop: 400000, format: 'TV', episodes: 11, titles: ['Demon Slayer: Kimetsu no Yaiba Swordsmith Village Arc'] },
  { id: 50392, pop: 100000, format: 'TV', episodes: 12, titles: ['Demon Slave', 'Chained Soldier'] },
  { id: 33, pop: 180000, format: 'TV', episodes: 25, titles: ['Berserk'] },
  { id: 16498, pop: 1000000, format: 'TV', episodes: 25, titles: ['Attack on Titan', 'Shingeki no Kyojin'] },
  { id: 20, pop: 700000, format: 'TV', episodes: 220, titles: ['Naruto'] },
  { id: 27899, pop: 500000, format: 'TV', episodes: 12, titles: ['a'] },
];

test('typos rank the real series first', () => {
  assert.equal(rankTitles('oni poice', INDEX, 1)[0].malId, 21);
  assert.equal(rankTitles('one peice', INDEX, 1)[0].malId, 21);
  assert.equal(rankTitles('berserkk', INDEX, 1)[0].malId, 33);
  assert.equal(rankTitles('atack on titan', INDEX, 1)[0].malId, 16498);
  assert.equal(rankTitles('demonslayer', INDEX, 1)[0].malId, 38000);
  assert.equal(rankTitles('demon slayer', INDEX, 1)[0].malId, 38000);
  assert.equal(rankTitles('narutoo', INDEX, 1)[0].malId, 20);
});

test('a one-letter title cannot outrank a real match', () => {
  assert.ok(scoreTitle('atack on titan', 'a') < 0.5);
});

test('a fetched title must agree with the candidate', () => {
  assert.equal(titlesAgree(['ONE PIECE'], 'One Piece'), true);
  assert.equal(titlesAgree(['Demon Slave'], 'Chained Soldier'), false);
});

test('resolve rejects a fetched title that does not match the query', async () => {
  await assert.rejects(
    () => resolveAnimeName('demonslayer', {
      index: [{ id: 50392, pop: 1, format: 'TV', episodes: 12, titles: ['Demon Slave'] }],
      searchLive: async () => [],
      lookupTitle: async () => ({ title: 'Chained Soldier', source: 'anilist' }),
    }),
    (err) => err.code === 'unverified',
  );
});

test('resolve returns the looked-up title only when it matches', async () => {
  const hit = await resolveAnimeName('oni poice', {
    index: INDEX,
    searchLive: async () => [],
    lookupTitle: async ({ malId }) => ({ title: malId === 21 ? 'One Piece' : 'Other', source: 'anilist', logoUrl: 'https://example.com/a.jpg', episodeCount: null }),
  });
  assert.equal(hit.malId, 21);
  assert.equal(hit.title, 'One Piece');
  assert.equal(hit.verified, true);
});
