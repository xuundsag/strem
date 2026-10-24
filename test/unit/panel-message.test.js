// The message payload that carries the panel.
//
// A Container is only accepted by Discord on a message flagged as Components
// V2. Without the flag the API rejects it with
//   components[0][UNION_TYPE_CHOICES]: Value of field "type" must be one of (1,)
// and the panel never appears. That cost a debugging session, so it is pinned.

import test from 'node:test';
import assert from 'node:assert/strict';
import * as discord from 'discord.js';
import { panelMessage, PANEL_MESSAGE_FLAGS } from '../../controller/src/panel-message.js';
import { PanelRefresher } from '../../controller/src/panel-refresher.js';

const state = {
  title: 'One Piece',
  episode: 1,
  searchUrl: 'https://www.google.com/search?q=One+Piece+Episode+1',
  logoUrl: null,
  position: 42,
  duration: 1437,
  audio: 'dub',
  captions: true,
  state: 'playing',
  error: null,
  autoplay: false,
  resumeFrom: 0,
  episodeCount: 1015,
};

test('the payload carries the Components V2 flag', () => {
  const payload = panelMessage(state, discord);
  assert.equal(payload.flags, discord.MessageFlags.IsComponentsV2);
  assert.equal(PANEL_MESSAGE_FLAGS, discord.MessageFlags.IsComponentsV2);
});

test('the payload has a Container and no text content', () => {
  const payload = panelMessage(state, discord);
  assert.equal(payload.content, null, 'Components V2 messages carry no content');
  assert.equal(payload.components.length, 1);
  assert.equal(payload.components[0].toJSON().type, 17, 'the top level component must be a Container');
});

test('the payload has no embeds', () => {
  const payload = panelMessage(state, discord);
  assert.equal(payload.embeds, undefined, 'the panel is not an embed');
});

test('the refresher sets the same flag on every edit', async () => {
  const edits = [];
  const fakeMessage = { edit: async (options) => { edits.push(options); } };
  const refresher = new PanelRefresher({ intervalMs: 0, flags: PANEL_MESSAGE_FLAGS, log: () => {} });
  refresher.setTarget('guild-1', fakeMessage);
  refresher.update('guild-1', state);
  await refresher.flush();

  assert.equal(edits.length, 1, 'one edit should have gone out');
  assert.equal(edits[0].flags, discord.MessageFlags.IsComponentsV2);
  assert.equal(edits[0].components.length, 1);
  refresher.dropTarget('guild-1');
});

test('the refresher does not send an edit when nothing changed', async () => {
  const edits = [];
  const fakeMessage = { edit: async (options) => { edits.push(options); } };
  const refresher = new PanelRefresher({ intervalMs: 0, flags: PANEL_MESSAGE_FLAGS, log: () => {} });
  refresher.setTarget('guild-1', fakeMessage);
  refresher.update('guild-1', state);
  await refresher.flush();
  refresher.update('guild-1', state);
  await refresher.flush();

  assert.equal(edits.length, 1, 'the second identical state should not produce an edit');
  refresher.dropTarget('guild-1');
});
