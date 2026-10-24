import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCommands, replaceCommands } from '../../controller/src/slash-commands.js';

test('the bot exposes stream, continue, stop and history, and nothing removed', () => {
  const names = buildCommands('Jinx').map((cmd) => cmd.name);
  assert.deepEqual(names, ['stream', 'continue', 'stop', 'history', 'streamer', 'help', 'ping']);
  const stream = buildCommands('Jinx')[0].toJSON();
  assert.deepEqual(stream.options.map((o) => o.name), ['anime', 'audio', 'episode']);
  const firstOptional = stream.options.findIndex((o) => !o.required);
  assert.ok(stream.options.slice(0, firstOptional).every((o) => o.required));
  assert.equal(stream.options.find((o) => o.name === 'episode').required, false);
  assert.equal(stream.options.some((o) => o.name === 'captions' || o.name === 'animeid'), false);
  const cont = buildCommands('Jinx')[1].toJSON();
  assert.equal(cont.options[0].autocomplete, true);
});

test('restart deletes every existing command before adding the new ones', async () => {
  const calls = [];
  const rest = {
    async get() {
      calls.push('get');
      return [{ id: '1', name: 'play' }, { id: '2', name: 'np' }];
    },
    async delete(route) {
      calls.push(`delete ${route}`);
    },
    async post(route, { body }) {
      calls.push(`post ${body.name}`);
    },
  };
  const result = await replaceCommands(rest, {
    clientId: 'app',
    guildId: 'guild',
    commands: [{ name: 'stream' }, { name: 'continue' }, { name: 'stop' }, { name: 'history' }],
  });
  assert.deepEqual(result.deleted, ['play', 'np']);
  assert.deepEqual(calls, [
    'get',
    'delete /applications/app/guilds/guild/commands/1',
    'delete /applications/app/guilds/guild/commands/2',
    'post stream',
    'post continue',
    'post stop',
    'post history',
  ]);
});
