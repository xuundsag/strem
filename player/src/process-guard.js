// Orphan process guard.
//
// A streaming box that leaks Chromium or FFmpeg processes will run out of RAM
// and die. So every process we spawn is registered here, and anything still
// alive at stop or exit time is killed.
//
// We track children we spawned, and also sweep by command line for the specific
// binaries we use, because a hard crash can orphan a grandchild.

import { execFile } from 'node:child_process';
import fs from 'node:fs';

/** @type {Set<import('node:child_process').ChildProcess>} */
const tracked = new Set();
let installed = false;

/**
 * A name tag so we can recognise our own Xvfb in /proc later.
 *
 * Xvfb has no option for this, but `-I` tells it to ignore everything after
 * it, so the tag is accepted and still shows up in the command line. Without
 * it there is no safe way to tell our display from one someone else started.
 */
export const XVFB_MARKER = '-anime-stream-managed';

/**
 * Command line markers that identify the processes this project spawns.
 *
 * They are deliberately specific. A VPS may well be running its own FFmpeg,
 * Chromium or PulseAudio, and a sweep that matched those would kill someone
 * else's work. Every string below is something only this project puts on a
 * command line, so the only thing a sweep can hit is our own leftover.
 */
export const ORPHAN_MARKERS = ['animestream_sink', XVFB_MARKER];

/** Register a child process so it gets cleaned up on exit. */
export function track(proc) {
  if (!proc) return proc;
  tracked.add(proc);
  proc.once('exit', () => tracked.delete(proc));
  return proc;
}

/** Read /proc to find pids whose command line mentions one of the markers. */
export function findOrphans(markers) {
  const found = [];
  let entries = [];
  try {
    entries = fs.readdirSync('/proc');
  } catch {
    return found; // not Linux, or /proc unavailable
  }
  const self = String(process.pid);
  for (const name of entries) {
    if (!/^\d+$/.test(name) || name === self) continue;
    let cmdline = '';
    try {
      cmdline = fs.readFileSync(`/proc/${name}/cmdline`, 'utf8').replace(/\0/g, ' ').trim();
    } catch {
      continue; // process vanished, or not ours to read
    }
    if (!cmdline) continue;
    // Never kill our own parent chain.
    if (/node .*(streamer|controller)/.test(cmdline) && cmdline.includes(process.argv[1] || '__none__')) continue;
    if (markers.some((m) => cmdline.includes(m))) found.push({ pid: Number(name), cmdline });
  }
  return found;
}

/**
 * Kill anything still tracked, then sweep for orphans by command line.
 * Safe to call repeatedly.
 *
 * @param {string[]} [markers] substrings that identify our processes
 * @param {(m:string)=>void} [log]
 */
export function killOrphans(markers = ORPHAN_MARKERS, log = () => {}) {
  for (const proc of [...tracked]) {
    try {
      if (!proc.killed) proc.kill('SIGKILL');
    } catch { /* gone */ }
  }
  tracked.clear();

  for (const { pid, cmdline } of findOrphans(markers)) {
    // Only touch processes owned by us; /proc lets us read but not kill others.
    try {
      process.kill(pid, 'SIGKILL');
      log(`killed orphan pid ${pid}: ${cmdline.slice(0, 90)}`);
    } catch { /* not ours, or already gone */ }
  }
}

/**
 * Install exit handlers so a crash or a Ctrl-C still cleans up.
 * Idempotent.
 */
export function installExitGuard(log = () => {}) {
  if (installed) return;
  installed = true;

  const onExit = (reason) => {
    log(`exit guard (${reason}): cleaning up child processes`);
    try {
      killOrphans(undefined, log);
    } catch { /* best effort */ }
  };

  process.on('exit', () => onExit('exit'));
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => {
      onExit(sig);
      process.exit(sig === 'SIGINT' ? 130 : 143);
    });
  }
  process.on('uncaughtException', (err) => {
    log(`uncaught exception: ${err?.message}`);
    onExit('uncaughtException');
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    log(`unhandled rejection: ${String(reason).slice(0, 200)}`);
  });
}

/** Count tracked processes still alive. Used by tests. */
export function trackedCount() {
  return tracked.size;
}

/** Promise wrapper around execFile, for the diagnose script. */
export function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 10000, ...opts }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}
