// Unit tests for the time parser and formatter.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTimeInput, formatDuration, clampSeek } from '../../shared/src/time.js';

test('parseTimeInput accepts plain seconds', () => {
  assert.deepEqual(parseTimeInput('90'), { ok: true, seconds: 90 });
  assert.deepEqual(parseTimeInput('0'), { ok: true, seconds: 0 });
  assert.deepEqual(parseTimeInput('1440'), { ok: true, seconds: 1440 });
});

test('parseTimeInput accepts MM:SS', () => {
  assert.deepEqual(parseTimeInput('1:30'), { ok: true, seconds: 90 });
  assert.deepEqual(parseTimeInput('0:42'), { ok: true, seconds: 42 });
  assert.deepEqual(parseTimeInput('24:00'), { ok: true, seconds: 1440 });
});

test('parseTimeInput accepts HH:MM:SS', () => {
  assert.deepEqual(parseTimeInput('01:02:03'), { ok: true, seconds: 3723 });
  assert.deepEqual(parseTimeInput('1:2:3'), { ok: true, seconds: 3723 });
  assert.deepEqual(parseTimeInput('00:00:10'), { ok: true, seconds: 10 });
});

test('parseTimeInput accepts the suffix form', () => {
  assert.deepEqual(parseTimeInput('1h2m3s'), { ok: true, seconds: 3723 });
  assert.deepEqual(parseTimeInput('90s'), { ok: true, seconds: 90 });
  assert.deepEqual(parseTimeInput('5m'), { ok: true, seconds: 300 });
});

test('parseTimeInput trims whitespace', () => {
  assert.deepEqual(parseTimeInput('  1:30  '), { ok: true, seconds: 90 });
});

test('parseTimeInput accepts numbers', () => {
  assert.deepEqual(parseTimeInput(90), { ok: true, seconds: 90 });
});

test('parseTimeInput rejects nonsense', () => {
  for (const bad of ['abc', '', '   ', '1:2:3:4', '12:3a', '--5', '1h2x']) {
    const r = parseTimeInput(bad);
    assert.equal(r.ok, false, `expected ${JSON.stringify(bad)} to be rejected`);
    assert.equal(typeof r.error, 'string');
  }
});

test('parseTimeInput rejects ambiguous or out-of-range clock parts', () => {
  assert.equal(parseTimeInput('1:70').ok, false, 'seconds must be < 60');
  assert.equal(parseTimeInput('1:70:00').ok, false, 'minutes must be < 60');
  assert.equal(parseTimeInput('01:02:70').ok, false, 'seconds must be < 60');
  assert.equal(parseTimeInput('-5').ok, false, 'no negative positions');
});

test('formatDuration prints MM:SS under an hour', () => {
  assert.equal(formatDuration(42), '00:42');
  assert.equal(formatDuration(1440), '24:00');
  assert.equal(formatDuration(0), '00:00');
  assert.equal(formatDuration(59), '00:59');
});

test('formatDuration prints H:MM:SS at or above an hour', () => {
  assert.equal(formatDuration(3723), '1:02:03');
  assert.equal(formatDuration(3600), '1:00:00');
});

test('formatDuration tolerates bad input', () => {
  assert.equal(formatDuration(NaN), '00:00');
  assert.equal(formatDuration(-5), '00:00');
  assert.equal(formatDuration(undefined), '00:00');
});

test('clampSeek enforces the episode duration', () => {
  assert.deepEqual(clampSeek(100, 1440), { ok: true, seconds: 100 });
  assert.equal(clampSeek(1440, 1440).ok, false);
  assert.equal(clampSeek(9999, 1440).ok, false);
  assert.equal(clampSeek(-1, 1440).ok, false);
  // Unknown duration disables the upper bound.
  assert.deepEqual(clampSeek(5000, 0), { ok: true, seconds: 5000 });
});
