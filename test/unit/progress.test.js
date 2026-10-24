import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProgressStore, FINISHED_FRACTION, MIN_RESUME_SECONDS } from '../../shared/src/progress.js';

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'prog-')), 'progress.json');

test('progress survives a reload', () => {
  const file = tmp();
  const store = new ProgressStore(file);
  store.set({ userId: 'u1', malId: 21, episode: 4, position: 600, duration: 1440, audio: 'dub', captions: true });
  const reloaded = new ProgressStore(file);
  const row = reloaded.get('u1', 21, 4);
  assert.equal(row.position, 600);
  assert.equal(row.duration, 1440);
  assert.equal(row.audio, 'dub');
  assert.equal(row.captions, true);
  assert.equal(row.finished, false);
});

test('resume points are offered for a part watched episode', () => {
  const store = new ProgressStore(tmp());
  store.set({ userId: 'u1', malId: 21, episode: 1, position: 900, duration: 1440 });
  assert.equal(store.resumeAt('u1', 21, 1), 900);
});

test('a finished episode starts from the beginning', () => {
  const store = new ProgressStore(tmp());
  const nearEnd = Math.ceil(1440 * FINISHED_FRACTION) + 1;
  store.set({ userId: 'u1', malId: 21, episode: 1, position: nearEnd, duration: 1440 });
  assert.equal(store.get('u1', 21, 1).finished, true);
  assert.equal(store.resumeAt('u1', 21, 1), 0);
});

test('a few seconds watched is not worth resuming', () => {
  const store = new ProgressStore(tmp());
  store.set({ userId: 'u1', malId: 21, episode: 1, position: MIN_RESUME_SECONDS - 1, duration: 1440 });
  assert.equal(store.resumeAt('u1', 21, 1), 0);
  store.set({ userId: 'u1', malId: 21, episode: 2, position: MIN_RESUME_SECONDS + 1, duration: 1440 });
  assert.equal(store.resumeAt('u1', 21, 2), MIN_RESUME_SECONDS + 1);
});

test('an unknown episode has nothing to resume', () => {
  const store = new ProgressStore(tmp());
  assert.equal(store.resumeAt('nobody', 21, 1), 0);
});

test('progress is stored per user, not shared', () => {
  const store = new ProgressStore(tmp());
  store.set({ userId: 'u1', malId: 21, episode: 1, position: 700, duration: 1440 });
  assert.equal(store.resumeAt('u2', 21, 1), 0);
  assert.equal(store.forUser('u2').length, 0);
});

test('latestUnfinished returns the most recent part watched episode', () => {
  const store = new ProgressStore(tmp());
  store.set({ userId: 'u1', malId: 21, episode: 1, position: 1439, duration: 1440 }); // finished
  store.set({ userId: 'u1', malId: 21, episode: 5, position: 400, duration: 1440 });
  store.set({ userId: 'u1', malId: 30, episode: 2, position: 300, duration: 1440 });
  const latest = store.latestUnfinished('u1');
  assert.equal(latest.malId, 30);
  assert.equal(latest.episode, 2);
});

test('latestUnfinished is null when everything is finished', () => {
  const store = new ProgressStore(tmp());
  store.set({ userId: 'u1', malId: 21, episode: 1, position: 1440, duration: 1440 });
  assert.equal(store.latestUnfinished('u1'), null);
});

test('furthestEpisode tracks the highest episode reached', () => {
  const store = new ProgressStore(tmp());
  store.set({ userId: 'u1', malId: 21, episode: 3, position: 100, duration: 1440 });
  store.set({ userId: 'u1', malId: 21, episode: 12, position: 100, duration: 1440 });
  store.set({ userId: 'u1', malId: 21, episode: 7, position: 100, duration: 1440 });
  assert.equal(store.furthestEpisode('u1', 21), 12);
  assert.equal(store.furthestEpisode('u1', 999), null);
});

test('a corrupt progress file does not stop startup', () => {
  const file = tmp();
  fs.writeFileSync(file, '{ this is not json');
  const store = new ProgressStore(file);
  assert.deepEqual(store.forUser('u1'), []);
  store.set({ userId: 'u1', malId: 1, episode: 1, position: 50, duration: 100 });
  assert.equal(new ProgressStore(file).forUser('u1').length, 1);
});

test('clear removes one record and leaves the rest', () => {
  const store = new ProgressStore(tmp());
  store.set({ userId: 'u1', malId: 21, episode: 1, position: 500, duration: 1440 });
  store.set({ userId: 'u1', malId: 21, episode: 2, position: 500, duration: 1440 });
  store.clear('u1', 21, 1);
  assert.equal(store.get('u1', 21, 1), null);
  assert.equal(store.forUser('u1').length, 1);
});

test('continue choices are saved names, not ids or episode numbers', () => {
  const store = new ProgressStore(tmp());
  store.set({ userId: 'u1', malId: 21, episode: 4, position: 100, duration: 1440, title: 'One Piece' });
  store.set({ userId: 'u1', malId: 33, episode: 2, position: 80, duration: 1440, title: 'Berserk' });
  store.set({ userId: 'u1', malId: 21, episode: 5, position: 10, duration: 1440, title: 'One Piece' });
  assert.deepEqual(store.namesForUser('u1'), ['One Piece', 'Berserk']);
  assert.equal(store.latestForTitle('u1', 'one piece').episode, 5);
  assert.equal(JSON.stringify(store.namesForUser('u1')).includes('21'), false);
});

test('rows come back newest first', () => {
  const store = new ProgressStore(tmp());
  store.set({ userId: 'u1', malId: 21, episode: 1, position: 100, duration: 1440 });
  store.set({ userId: 'u1', malId: 21, episode: 2, position: 200, duration: 1440 });
  const rows = store.forUser('u1');
  assert.equal(rows[0].updatedAt >= rows[1].updatedAt, true);
});
