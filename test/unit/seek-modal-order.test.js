import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('the seek button opens the form before the interaction is deferred', () => {
  const src = fs.readFileSync(new URL('../../controller/src/index.js', import.meta.url), 'utf8');
  const start = src.indexOf('async function handleButton');
  const end = src.indexOf('async function refreshClicked');
  const fn = src.slice(start, end);
  const seek = fn.indexOf('BTN.SEEK');
  const more = fn.indexOf('BTN.MORE');
  const custom = fn.indexOf('BTN.VOL_CUSTOM');
  const token = fn.indexOf('BTN.STREAMER_TOKEN');
  const defer = fn.indexOf('deferUpdate');
  assert.ok(seek !== -1 && more !== -1 && custom !== -1 && token !== -1 && defer !== -1);
  assert.ok(seek < defer, 'showModal has to be the first response or Discord drops the form');
  assert.ok(custom < defer, 'the custom volume form has to be the first response');
  assert.ok(token < defer, 'the token form has to be the first response');
  assert.ok(more < defer, 'the more options reply has to be the first response');
});
