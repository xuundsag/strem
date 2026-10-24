import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StreamerStore, chooseAccount, parsePublicStreamers, streamerLabel, publicView } from '../../shared/src/streamers.js';
import { voiceStatusText } from '../../controller/src/voice-status.js';

const token = 'a'.repeat(24) + '.' + 'b'.repeat(8) + '.' + 'c'.repeat(32);

test('labels run Streamer A, Streamer B, then Streamer Z and AA', () => {
  assert.equal(streamerLabel(0), 'Streamer A');
  assert.equal(streamerLabel(1), 'Streamer B');
  assert.equal(streamerLabel(25), 'Streamer Z');
  assert.equal(streamerLabel(26), 'Streamer AA');
});

test('public streamers can carry an optional channel and never leak the token in the view', () => {
  const rows = parsePublicStreamers(`${token}@123456789012345678`);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].public, true);
  assert.equal(rows[0].channelId, '123456789012345678');
  const view = publicView({ ...rows[0], label: 'Streamer A', active: true });
  assert.equal(JSON.stringify(view).includes(token), false);
});

test('a pinned streamer is preferred for its home channel, otherwise a roaming one joins the requester', () => {
  const accounts = [
    { id: 'p', active: true, busy: false, channelId: '111111111111111111' },
    { id: 'r', active: true, busy: false, channelId: null },
  ];
  assert.equal(chooseAccount(accounts, { channelId: '222222222222222222' }).account.id, 'r');
  assert.equal(chooseAccount(accounts, { channelId: '111111111111111111' }).mode, 'home');
  assert.equal(chooseAccount(accounts, {}).mode, 'pinned');
});

test('private streamers are saved without being echoed back', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'streamers-')), 'Streamer.json');
  const store = new StreamerStore(file);
  const added = store.add({ token, channelId: '123456789012345678', addedBy: 'user' });
  assert.equal(added.channelId, '123456789012345678');
  assert.equal(JSON.stringify(added).includes(token), false);
  assert.equal(store.remove(added.id), true);
  assert.equal(store.privateRows().length, 0);
});

test('voice status names the series and episode, but not a movie episode', () => {
  assert.equal(voiceStatusText({ title: 'One Piece', episode: 4, format: 'TV' }), 'One Piece - Episode 4');
  assert.equal(voiceStatusText({ title: 'Your Name', episode: 1, format: 'MOVIE' }), 'Your Name');
});
