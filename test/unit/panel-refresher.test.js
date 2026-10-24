// The panel is edited at most once per interval. That is a rate limit
// requirement, so it gets a test of its own.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PanelRefresher } from '../../controller/src/panel-refresher.js';

// A stand-in for a discord.js Message. Records every edit instead of sending it.
function fakeMessage() {
  const edits = [];
  return { edits, edit: async (payload) => { edits.push(payload); return payload; } };
}

const baseState = {
  title: 'One Piece', episode: 1, searchUrl: 'https://g', logoUrl: 'https://l',
  position: 10, duration: 1440, audio: 'sub', captions: true, state: 'playing', error: null,
};

test('the first update edits right away', async () => {
  const refresher = new PanelRefresher({ intervalMs: 5000 });
  const message = fakeMessage();
  refresher.setTarget('g1', message);
  refresher.update('g1', baseState);
  await refresher.flush();
  assert.equal(message.edits.length, 1);
  refresher.stop();
});

test('updates inside the interval are coalesced into one edit', async () => {
  const refresher = new PanelRefresher({ intervalMs: 5000 });
  const message = fakeMessage();
  refresher.setTarget('g1', message);

  for (let i = 0; i < 20; i++) refresher.update('g1', { ...baseState, position: i });
  await refresher.flush();
  assert.equal(message.edits.length, 1, 'twenty updates should still be a single edit');
  // The newest state wins, not the first one queued.
  assert.match(message.edits[0].components[0].toJSON().components[1].content, /`0:19\/24:00`/);
  refresher.stop();
});

test('a second edit is refused until the interval has passed', async () => {
  const refresher = new PanelRefresher({ intervalMs: 300 });
  const message = fakeMessage();
  refresher.setTarget('g1', message);

  refresher.update('g1', baseState);
  await refresher.flush();
  refresher.update('g1', { ...baseState, position: 50 });
  await refresher.flush();
  assert.equal(message.edits.length, 1, 'too soon for a second edit');

  await new Promise((r) => setTimeout(r, 350));
  await refresher.flush();
  assert.equal(message.edits.length, 2, 'after the interval the edit goes out');
  refresher.stop();
});

test('force bypasses the interval, which is what a button press needs', async () => {
  const refresher = new PanelRefresher({ intervalMs: 60000 });
  const message = fakeMessage();
  refresher.setTarget('g1', message);

  refresher.update('g1', baseState);
  await refresher.flush();
  await refresher.force('g1', { ...baseState, position: 120 });
  assert.equal(message.edits.length, 2);
  refresher.stop();
});

test('an unchanged panel is not resent', async () => {
  const refresher = new PanelRefresher({ intervalMs: 10 });
  const message = fakeMessage();
  refresher.setTarget('g1', message);

  refresher.update('g1', baseState);
  await refresher.flush();
  refresher.update('g1', baseState);
  await new Promise((r) => setTimeout(r, 30));
  await refresher.flush();
  assert.equal(message.edits.length, 1, 'the same panel twice should send once');
  refresher.stop();
});

test('a deleted message is dropped after repeated failures', async () => {
  const refresher = new PanelRefresher({ intervalMs: 1, log: () => {} });
  const message = { edit: async () => { const e = new Error('Unknown Message'); e.code = 10008; throw e; } };
  refresher.setTarget('g1', message);
  refresher.update('g1', baseState);
  await refresher.flush();
  assert.equal(refresher.targets.has('g1'), false, 'a deleted message should stop being tracked');
  refresher.stop();
});

test('dropping a target stops the refresh timer', async () => {
  const refresher = new PanelRefresher({ intervalMs: 10 });
  const message = fakeMessage();
  refresher.setTarget('g1', message);
  refresher.dropTarget('g1');
  assert.equal(refresher.timer, null);
  refresher.stop();
});

test('several guilds are tracked independently', async () => {
  const refresher = new PanelRefresher({ intervalMs: 5000 });
  const a = fakeMessage();
  const b = fakeMessage();
  refresher.setTarget('g1', a);
  refresher.setTarget('g2', b);
  refresher.update('g1', baseState);
  refresher.update('g2', { ...baseState, episode: 9 });
  await refresher.flush();
  assert.equal(a.edits.length, 1);
  assert.equal(b.edits.length, 1);
  assert.match(b.edits[0].components[0].toJSON().components[0].components[0].content, /Episode 9/);
  refresher.stop();
});
