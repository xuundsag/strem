// Virtual display and audio device management.
//
// Headless Chromium has no screen to capture and no audio device to play into,
// so we create both:
//
//   Xvfb       a virtual X server. Chromium draws into it and FFmpeg reads it
//              back with x11grab.
//   PulseAudio a "null sink", which is a fake speaker that records whatever is
//              played into it. FFmpeg reads it back with the pulse input.
//
// Both are started as child processes and killed on shutdown so nothing is left
// running on the VPS.

import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { sleep } from '@anime-stream/shared/retry.js';
import { track, XVFB_MARKER } from './process-guard.js';

/** Run a command and return true when it exits 0. Never throws. */
function have(cmd, args = ['--version']) {
  try {
    execFileSync(cmd, args, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** True when the binary exists somewhere on PATH. */
function onPath(cmd) {
  try {
    const out = execFileSync('sh', ['-c', `command -v ${cmd}`], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    return out.length > 0;
  } catch {
    return false;
  }
}

/**
 * Is Playwright's Chromium actually installed?
 *
 * `npm install` does not download it, so a fresh box can have ffmpeg and Xvfb
 * and still be unable to launch a browser. Tests that need one must ask this
 * and skip, rather than fail on a launch error.
 */
export function checkChromium() {
  try {
    const { chromium } = require0('playwright');
    const path = chromium.executablePath();
    return typeof path === 'string' && fs.existsSync(path);
  } catch {
    return false;
  }
}

/** Sync require, so this can be called from a plain function. */
function require0(id) {
  return createRequire(import.meta.url)(id);
}

export function checkSystemTools() {
  // ffmpeg and ffprobe use a single-dash -version flag, and Xvfb exits non-zero
  // for -help, so probing the PATH is the reliable check for those.
  return {
    ffmpeg: onPath('ffmpeg'),
    ffprobe: onPath('ffprobe'),
    xvfb: onPath('Xvfb') || fs.existsSync('/usr/bin/Xvfb'),
    pulse: onPath('pulseaudio') || fs.existsSync('/usr/bin/pulseaudio'),
    pactl: onPath('pactl'),
  };
}

export class VirtualDisplay {
  /**
   * @param {object} o
   * @param {number} [o.width]
   * @param {number} [o.height]
   * @param {string} [o.display] fixed display number, otherwise auto
   * @param {(m:string)=>void} [o.log]
   */
  constructor({ width = 1920, height = 1080, display, log = () => {} } = {}) {
    this.width = width;
    this.height = height;
    this.requestedDisplay = display;
    this.log = log;
    this.proc = null;
    this.display = null;
    this.claimFile = null;
  }

  get envDisplay() {
    return this.display; // e.g. ":99"
  }

  async start() {
    if (process.env.DISPLAY && !this.requestedDisplay) {
      // A display already exists (for example xvfb-run or a real X session).
      this.display = process.env.DISPLAY;
      this.log(`using existing DISPLAY=${this.display}`);
      return this;
    }
    const n = this.requestedDisplay ? String(this.requestedDisplay).replace(':', '') : this._claimDisplay();
    this.display = `:${n}`;
    this.claimFile = claimPath(n);
    const lock = `/tmp/.X${n}-lock`;
    this.proc = track(spawn('Xvfb', [this.display, '-screen', '0', `${this.width}x${this.height}x24`, '-nolisten', 'tcp', '-I', XVFB_MARKER], {
      stdio: 'ignore',
      detached: false,
    }));
    const died = new Promise((_resolve, reject) => {
      this.proc.once('exit', (code) => {
        this.log(`Xvfb exited with code ${code}`);
        reject(new Error(`Xvfb exited immediately with code ${code} on display ${this.display}`));
      });
    });
    // Xvfb writes its lock file once it accepts clients. Poll for that, but
    // treat an early exit as the real answer instead of waiting it out.
    let ready = false;
    for (let i = 0; i < 50 && !ready; i++) {
      ready = fs.existsSync(lock);
      if (!ready) await Promise.race([sleep(100), died.catch(() => {})]);
    }
    if (!ready) {
      this.proc.kill('SIGKILL');
      throw new Error(`Xvfb did not start on display ${this.display}`);
    }
    this.log(`Xvfb on ${this.display} at ${this.width}x${this.height}`);
    return this;
  }

  stop() {
    if (this.proc && !this.proc.killed) {
      this.proc.kill('SIGTERM');
      this.proc = null;
    }
    // Release our claim. A display we found already running is not ours to
    // stop, and has no claim file.
    if (this.claimFile) {
      try { fs.unlinkSync(this.claimFile); } catch { /* already gone */ }
      this.claimFile = null;
    }
  }
}

/** True when no process with that pid is alive any more. */
function pidIsGone(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    // ESRCH means no such process. EPERM means it exists but is not ours.
    return err.code === 'ESRCH';
  }
}

/**
 * Clear a lock file whose owner is dead.
 *
 * Xvfb writes its pid into `/tmp/.X<n>-lock` and removes the file on a clean
 * exit. After a reboot or a SIGKILL the file stays behind and would otherwise
 * make that display number unusable until someone cleans it up by hand.
 */
/**
 * Report whether an X display number can be taken.
 *
 * Exported so this can be tested directly instead of only being reachable
 * through a full display start.
 */
export function displaySlotIsFree(n) {
  return clearStaleLock(n);
}

function clearStaleLock(n) {
  const lock = `/tmp/.X${n}-lock`;
  if (!fs.existsSync(lock)) return true;
  let owner = NaN;
  try {
    owner = Number.parseInt(fs.readFileSync(lock, 'utf8').trim(), 10);
  } catch { /* unreadable, leave it alone */ }
  if (!pidIsGone(owner)) return false;
  try {
    fs.unlinkSync(lock);
    return true;
  } catch {
    return false;
  }
}

/**
 * Claim a free display number with a marker file of our own.
 *
 * Looking for a missing `/tmp/.X<n>-lock` is not enough: Xvfb writes that file
 * a moment after it starts, so two displays started back to back can pick the
 * same number and fight over it. We cannot write Xvfb's lock file ourselves
 * either, because Xvfb refuses to start when it already exists. A separate
 * marker created with the exclusive flag gives us the atomicity we need.
 */
VirtualDisplay.prototype._claimDisplay = function claimDisplay() {
  for (let n = 99; n < 130; n++) {
    if (!clearStaleLock(n)) continue;
    const claim = claimPath(n);
    // A claim left behind by a process that died must not block the number
    // forever, or a box that crashed a few times runs out of displays.
    if (fs.existsSync(claim)) {
      const owner = Number.parseInt(fs.readFileSync(claim, 'utf8').trim(), 10);
      if (!pidIsGone(owner)) continue;
      try { fs.unlinkSync(claim); } catch { /* lost the race, try the next */ }
    }
    try {
      fs.writeFileSync(claim, `${process.pid}\n`, { flag: 'wx' });
      return n;
    } catch {
      continue;
    }
  }
  throw new Error('No free X display number between 99 and 129');
};

function claimPath(n) {
  return `/tmp/.anime-stream-display-${n}.claim`;
}

export class NullSinkAudio {
  /**
   * @param {object} o
   * @param {string} [o.sinkName]
   * @param {(m:string)=>void} [o.log]
   */
  constructor({ sinkName = 'animestream_sink', log = () => {} } = {}) {
    this.sinkName = sinkName;
    this.log = log;
    this.proc = null;
    this.runtimeDir = null;
    this.socketPath = null;
    this.asoundrc = null;
    this.started = false;
  }

  /** The PulseAudio source FFmpeg should record from. */
  get monitorSource() {
    return `${this.sinkName}.monitor`;
  }

  get daemonEnv() {
    const env = { ...process.env };
    if (this.runtimeDir) {
      env.PULSE_RUNTIME_PATH = this.runtimeDir;
      env.XDG_RUNTIME_DIR = this.runtimeDir;
      delete env.PULSE_SERVER;
    }
    return env;
  }

  get env() {
    const env = this.daemonEnv;
    if (this.socketPath) env.PULSE_SERVER = `unix:${this.socketPath}`;
    if (this.runtimeDir) {
      env.PULSE_SINK = this.sinkName;
      if (this.asoundrc) env.ALSA_CONFIG_PATH = this.asoundrc;
    }
    return env;
  }

  async start() {
    if (!checkSystemTools().pulse) {
      this.log('pulseaudio not installed; capture will run without audio');
      return this;
    }
    this.runtimeDir = fs.mkdtempSync('/tmp/pulse-anime-');
    fs.chmodSync(this.runtimeDir, 0o700);

    this.proc = track(spawn(
      'pulseaudio',
      [
        '--daemonize=no',
        '--exit-idle-time=-1',
        '--disallow-exit',
        '--log-target=stderr',
        '-L',
        `module-null-sink sink_name=${this.sinkName} rate=48000 format=s16le channels=2 sink_properties=device.description=AnimeStream`,
      ],
      { stdio: ['ignore', 'ignore', 'pipe'], env: this.daemonEnv },
    ));

    let stderr = '';
    this.proc.stderr?.on('data', (d) => { stderr += d.toString().slice(0, 2000); });
    this.proc.on('exit', (code) => this.log(`pulseaudio exited with code ${code}`));

    // Wait for the sink to register.
    for (let i = 0; i < 60; i++) {
      await sleep(150);
      if (this._sinkExists()) break;
    }
    if (!this._sinkExists()) {
      this.log(`pulse sink did not appear; last output: ${stderr.slice(-300)}`);
      return this;
    }
    this.socketPath = [path.join(this.runtimeDir, 'native'), path.join(this.runtimeDir, 'pulse', 'native')].find((p) => fs.existsSync(p)) || null;
    this.asoundrc = path.join(this.runtimeDir, 'asoundrc');
    const server = this.socketPath ? `unix:${this.socketPath}` : '';
    fs.writeFileSync(this.asoundrc, [
      'pcm.!default {',
      '  type pulse',
      server ? `  server "${server}"` : '',
      `  device ${this.sinkName}`,
      '}',
      'ctl.!default {',
      '  type pulse',
      server ? `  server "${server}"` : '',
      '}',
      '',
    ].filter(Boolean).join('\n'));
    try {
      execFileSync('pactl', ['set-default-sink', this.sinkName], { env: this.env, stdio: 'ignore' });
    } catch (err) {
      this.log(`could not set the default sink: ${err.message}`);
    }
    this.started = true;
    this.log(`pulse null sink ${this.sinkName} ready`);
    return this;
  }

  _sinkExists() {
    try {
      const out = execFileSync('pactl', ['list', 'short', 'sinks'], { env: this.env, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
      return out.includes(this.sinkName);
    } catch {
      return false;
    }
  }

  stop() {
    if (this.proc && !this.proc.killed) {
      this.proc.kill('SIGTERM');
      this.proc = null;
    }
    if (this.runtimeDir) {
      try { fs.rmSync(this.runtimeDir, { recursive: true, force: true }); } catch { /* ignore */ }
      this.runtimeDir = null;
    }
  }
}
