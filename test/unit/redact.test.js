// Log redaction.
//
// The one rule that must never break: a token that reaches the log is a leaked
// credential. These cases are the shapes the code actually logs, taken from the
// places redact() is called: IPC request bodies and fetch error messages.

import test from 'node:test';
import assert from 'node:assert/strict';
import { redact } from '../../shared/src/http.js';

test('an authorization header value is replaced', () => {
  const out = redact('{"authorization":"MTIzNDU2Nzg5.fake.signature"}');
  assert.ok(!out.includes('MTIzNDU2Nzg5'), out);
  assert.match(out, /\[REDACTED\]/);
});

test('a bearer token in a header line is replaced', () => {
  const out = redact('Authorization: Bearer NkX8.something.very-long');
  assert.ok(!out.includes('NkX8.something.very-long'), out);
});

test('token, password and secret fields are replaced', () => {
  for (const key of ['token', 'password', 'secret']) {
    const out = redact(`{"${key}": "hunter2-super-secret"}`);
    assert.ok(!out.includes('hunter2-super-secret'), `${key}: ${out}`);
  }
});

test('key names are case insensitive', () => {
  const out = redact('{"Authorization":"abcdef"}');
  assert.ok(!out.includes('abcdef'), out);
});

test('a bare JWT shape is replaced even with no field name', () => {
  // Discord bot tokens are not JWTs, but plenty of libraries put JWT shaped
  // strings in error messages, and those carry credentials too.
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
  const out = redact(`request failed for ${jwt}`);
  assert.ok(!out.includes(jwt), out);
  assert.match(out, /\[REDACTED_JWT\]/);
});

test('an IPC play body keeps the fields that are safe to log', () => {
  // Redaction that blanks everything is useless for debugging. The episode and
  // guild ids have to survive, because they are how you find the right line.
  const body = JSON.stringify({
    v: 1,
    type: 'play',
    malId: 21,
    episode: 4,
    guildId: '123456789012345678',
    authorization: 'super-secret-value',
  });
  const out = redact(body);
  assert.ok(out.includes('"malId":21'), out);
  assert.ok(out.includes('"episode":4'), out);
  assert.ok(out.includes('123456789012345678'), out);
  assert.ok(!out.includes('super-secret-value'), out);
});

test('plain text passes through unchanged', () => {
  const line = 'ipc: play {"malId":21,"episode":4}';
  assert.equal(redact(line), line);
});

test('non strings are returned as they came in', () => {
  assert.equal(redact(undefined), undefined);
  assert.equal(redact(null), null);
  assert.equal(redact(42), 42);
});
