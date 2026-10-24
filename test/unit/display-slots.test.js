// Display slot allocation.
//
// A box that reboots or gets SIGKILLed leaves X lock files behind, and a
// streamer that cannot get a display cannot stream at all. These tests pin
// down that a dead owner's lock is reclaimable and a live owner's is not.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { displaySlotIsFree } from '../../player/src/display.js';

const DEAD_PID = 999999;

function findFreeSlot() {
  for (let n = 99; n < 130; n++) if (!fs.existsSync(`/tmp/.X${n}-lock`)) return n;
  return null;
}

test('a free display number is available', (t) => {
  const n = findFreeSlot();
  if (n === null) return t.skip('every slot is busy on this box');
  assert.equal(displaySlotIsFree(n), true);
});

test('a lock owned by a dead process is reclaimed', (t) => {
  const n = findFreeSlot();
  if (n === null) return t.skip('every slot is busy on this box');
  const lock = `/tmp/.X${n}-lock`;
  t.after(() => { try { fs.unlinkSync(lock); } catch { /* gone */ } });

  // Xvfb writes its pid here and removes the file on a clean exit. A SIGKILL
  // or a reboot leaves it behind.
  fs.writeFileSync(lock, `     ${DEAD_PID}\n`, { mode: 0o444 });
  assert.ok(fs.existsSync(lock), 'the stale lock should be in place');

  assert.equal(displaySlotIsFree(n), true, 'a dead owner must not block the number');
  assert.equal(fs.existsSync(lock), false, 'the stale lock should have been removed');
});

test('a lock owned by a live process is left alone', (t) => {
  const n = findFreeSlot();
  if (n === null) return t.skip('every slot is busy on this box');
  const lock = `/tmp/.X${n}-lock`;
  t.after(() => { try { fs.unlinkSync(lock); } catch { /* gone */ } });

  // Our own pid is definitely alive.
  fs.writeFileSync(lock, `     ${process.pid}\n`, { mode: 0o444 });
  assert.equal(displaySlotIsFree(n), false, 'a live owner must keep the number');
  assert.equal(fs.existsSync(lock), true, 'the lock must not be touched');
});

test('a lock with no readable pid is treated as stale', (t) => {
  const n = findFreeSlot();
  if (n === null) return t.skip('every slot is busy on this box');
  const lock = `/tmp/.X${n}-lock`;
  t.after(() => { try { fs.unlinkSync(lock); } catch { /* gone */ } });

  // X itself treats a lock whose owner it cannot identify as stale, and we
  // match that rather than stranding the number forever.
  fs.writeFileSync(lock, 'not a pid at all\n', { mode: 0o444 });
  assert.equal(displaySlotIsFree(n), true);
  assert.equal(fs.existsSync(lock), false);
});
