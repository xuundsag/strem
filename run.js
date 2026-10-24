#!/usr/bin/env node
// Starts both halves of Jinx and keeps their logs in one terminal.
//
//   node run.js              start the streamer and the controller
//   node run.js streamer     start only the selfbot
//   node run.js controller   start only the official bot
//   node run.js check        verify the setup and exit
//
// The two processes are independent: the controller talks to the streamer over
// localhost, so either can be restarted on its own. This script just watches
// both, prefixes their output so you can tell them apart, and shuts them down
// together on Ctrl-C.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

const TARGETS = {
  streamer: { script: 'streamer/src/index.js', label: 'streamer', needs: ['DISCORD_USER_TOKEN'], tokenType: 'user' },
  controller: { script: 'controller/src/index.js', label: 'jinx', needs: ['DISCORD_BOT_TOKEN'], tokenType: 'bot' },
};

const MODE_COLORS = { streamer: '\x1b[36m', jinx: '\x1b[35m' };
const RESET = '\x1b[0m';
const DIM = '\x1b[2m';

function say(message) {
  process.stdout.write(`${DIM}[run]${RESET} ${message}\n`);
}

/** Read .env without pulling in a dependency, so `check` works before install. */
function readEnvFile(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!match) continue;
    let value = match[2];
    if (/^".*"$/.test(value) || /^'.*'$/.test(value)) value = value.slice(1, -1);
    out[match[1]] = value;
  }
  return out;
}

/** Values that are still empty or still the placeholder from .env.example. */
function missingVars(target, env) {
  const missing = [];
  for (const name of target.needs) {
    const value = process.env[name] ?? env[name];
    if (!value || /your[-_ ]|changeme|replace/i.test(value)) missing.push(name);
  }
  return missing;
}

async function runCheck() {
  const env = readEnvFile(path.join(ROOT, '.env'));
  const hasEnvFile = fs.existsSync(path.join(ROOT, '.env'));
  say(hasEnvFile ? 'found .env' : 'no .env yet, copy .env.example to .env first');

  const problems = [];
  for (const [name, target] of Object.entries(TARGETS)) {
    const missing = missingVars(target, env);
    if (missing.length) problems.push(`${name} is missing ${missing.join(', ')}`);
    else say(`${name}: token present`);
  }

  // System tools the streamer needs. Checked by hand here so the message is
  // readable, rather than as a stack trace from a failed launch.
  const tools = ['ffmpeg', 'ffprobe', 'Xvfb', 'pulseaudio', 'pactl'];
  const absent = tools.filter((tool) => !commandExists(tool));
  if (absent.length) problems.push(`missing system tools: ${absent.join(', ')} (run npm run setup)`);
  else say(`system tools present: ${tools.join(', ')}`);

  if (!fs.existsSync(path.join(ROOT, 'node_modules'))) {
    problems.push('node_modules is missing, run npm install');
  }

  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (nodeMajor < 22) {
    problems.push(`node ${process.versions.node} is older than 22.4.0, which the streaming library requires`);
  } else {
    say(`node ${process.versions.node}`);
  }

  // Ask Discord whether each token is real. This is the one thing that cannot
  // be checked offline, and a typo here otherwise shows up as a confusing
  // login failure minutes later.
  for (const [name, target] of Object.entries(TARGETS)) {
    const token = process.env[target.needs[0]] ?? env[target.needs[0]];
    if (!token || /your[-_ ]|changeme|replace/i.test(token)) continue;
    const result = await checkToken(token, target.tokenType);
    if (result.ok) say(`${name}: token accepted, logged in as ${result.as}`);
    else problems.push(`${name}: ${result.error}`);
  }

  if (problems.length) {
    say('not ready:');
    for (const p of problems) say(`  - ${p}`);
    process.exitCode = 1;
    return;
  }
  say('ready. start both with: node run.js');
}

/** Look the binary up on PATH instead of guessing at install locations. */
function commandExists(name) {
  try {
    const res = spawnSync('sh', ['-c', `command -v ${name}`], { stdio: 'ignore' });
    return res.status === 0;
  } catch {
    return false;
  }
}

/**
 * Confirm a token with Discord and return the account name.
 *
 * Only the name is reported. A token is a credential, so it is never echoed
 * back, not even partially.
 */
async function checkToken(token, type) {
  // A selfbot logs in with the raw user token. An application bot needs the
  // Bot prefix, and gets a 401 without it.
  const authorization = type === 'user' ? token : token.startsWith('Bot ') ? token : `Bot ${token}`;
  try {
    const res = await fetch('https://discord.com/api/v10/users/@me', {
      headers: { authorization, 'user-agent': 'Jinx (anime streamer, 1.0)' },
    });
    if (!res.ok) {
      const hint = res.status === 401 ? 'the token is not valid' : `Discord answered ${res.status}`;
      return { ok: false, error: hint };
    }
    const me = await res.json();
    return { ok: true, as: `${me.username} (${me.id})` };
  } catch (err) {
    return { ok: false, error: `could not reach Discord (${err.message})` };
  }
}

function start(target) {
  const child = spawn(process.execPath, [path.join(ROOT, target.script)], {
    cwd: ROOT,
    stdio: ['inherit', 'pipe', 'pipe'],
    env: { ...process.env },
  });

  const colour = MODE_COLORS[target.label] || '';
  const prefix = (stream) => {
    let buffer = '';
    stream.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (line.trim()) process.stdout.write(`${colour}[${target.label}]${RESET} ${line}\n`);
      }
    });
  };
  prefix(child.stdout);
  prefix(child.stderr);

  return child;
}

function killPort(port) {
  const hex = Number(port).toString(16).toUpperCase().padStart(4, '0');
  const inodes = new Set();
  for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, 'utf8').split('\n').slice(1)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 10) continue;
      if (!parts[1].toUpperCase().endsWith(`:${hex}`)) continue;
      if (parts[3] !== '0A') continue;
      inodes.add(parts[9]);
    }
  }
  if (!inodes.size) return [];
  const killed = [];
  for (const pid of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(pid)) continue;
    let fds = [];
    try { fds = fs.readdirSync(`/proc/${pid}/fd`); } catch { continue; }
    for (const fd of fds) {
      let link = '';
      try { link = fs.readlinkSync(`/proc/${pid}/fd/${fd}`); } catch { continue; }
      const match = /socket:\[(\d+)\]/.exec(link);
      if (!match || !inodes.has(match[1])) continue;
      try {
        process.kill(Number(pid), 'SIGKILL');
        killed.push(Number(pid));
      } catch { /* already gone */ }
      break;
    }
  }
  return killed;
}

function npmReady() {
  return ['discord.js', 'playwright', 'hls.js', 'dotenv'].every((name) =>
    fs.existsSync(path.join(ROOT, 'node_modules', name, 'package.json')),
  );
}

function chromiumReady() {
  try {
    const { chromium } = createRequire(import.meta.url)('playwright');
    const bin = chromium.executablePath();
    return typeof bin === 'string' && fs.existsSync(bin);
  } catch {
    return false;
  }
}

function ensureRuntime() {
  const needed = [
    ['ffmpeg', 'ffmpeg'],
    ['ffprobe', 'ffmpeg'],
    ['Xvfb', 'xvfb'],
    ['pulseaudio', 'pulseaudio'],
    ['pactl', 'pulseaudio-utils'],
  ];
  const missingBins = needed.filter(([bin]) => !commandExists(bin)).map(([, pkg]) => pkg);
  const pkgs = [...new Set(missingBins)];
  if (pkgs.length) {
    if (!commandExists('sudo') || !commandExists('apt-get')) {
      throw new Error(`missing system tools: ${pkgs.join(', ')}`);
    }
    say(`installing ${pkgs.join(', ')}`);
    const apt = spawnSync('sudo', ['apt-get', 'install', '-y', '--no-install-recommends', ...pkgs, 'fonts-dejavu-core', 'libnss3', 'libnspr4', 'libatk1.0-0', 'libatk-bridge2.0-0', 'libcups2', 'libdrm2', 'libxkbcommon0', 'libxcomposite1', 'libxdamage1', 'libxfixes3', 'libxrandr2', 'libgbm1', 'libpango-1.0-0', 'libcairo2', 'libasound2'], {
      cwd: ROOT,
      stdio: 'inherit',
    });
    if (apt.status !== 0) throw new Error('system package install failed');
  }

  if (!npmReady()) {
    say('installing npm packages');
    const npm = spawnSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: ROOT, stdio: 'inherit' });
    if (npm.status !== 0) throw new Error('npm install failed');
  }

  if (!chromiumReady()) {
    say('installing playwright chromium');
    const pw = spawnSync('npx', ['--yes', 'playwright', 'install', 'chromium'], { cwd: ROOT, stdio: 'inherit' });
    if (pw.status !== 0) throw new Error('playwright chromium install failed');
  }
}

async function main() {
  const arg = (process.argv[2] || 'all').toLowerCase();
  if (arg !== 'check') {
    const killed = killPort(8787);
    if (killed.length) say(`killed process ${killed.join(', ')} on port 8787`);
  }

  if (arg === 'check') return runCheck();

  const wanted = arg === 'all' ? ['streamer', 'controller'] : [arg];
  for (const name of wanted) {
    if (!TARGETS[name]) {
      say(`unknown target "${name}". use: all, streamer, controller or check`);
      process.exitCode = 1;
      return;
    }
  }

  try {
    ensureRuntime();
  } catch (err) {
    say(err.message);
    process.exitCode = 1;
    return;
  }

  const env = readEnvFile(path.join(ROOT, '.env'));
  for (const name of wanted) {
    const missing = missingVars(TARGETS[name], env);
    if (missing.length) {
      say(`refusing to start ${name}: ${missing.join(', ')} is not set. copy .env.example to .env and fill it in.`);
      process.exitCode = 1;
      return;
    }
  }

  // Load .env into this process so the children inherit it. dotenv in the
  // children would do the same thing, but doing it here keeps one source.
  for (const [key, value] of Object.entries(env)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }

  const children = wanted.map((name) => {
    say(`starting ${name}`);
    return { name, child: start(TARGETS[name]) };
  });

  let shuttingDown = false;
  const shutdown = (reason) => {
    if (shuttingDown) return;
    shuttingDown = true;
    say(`${reason}, stopping`);
    for (const { child } of children) {
      if (!child.killed) child.kill('SIGTERM');
    }
    // A streamer that ignores SIGTERM still has ffmpeg and chromium to clean up,
    // so give it a moment before forcing.
    setTimeout(() => {
      for (const { child } of children) {
        if (!child.killed) child.kill('SIGKILL');
      }
      process.exit(0);
    }, 8000).unref();
  };

  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => shutdown(signal));

  for (const { name, child } of children) {
    child.on('exit', (code, signal) => {
      say(`${name} exited (code ${code}, signal ${signal})`);
      if (!shuttingDown) shutdown(`${name} died`);
    });
  }

  say('both processes are up. Ctrl-C stops them together.');
}

main().catch((err) => {
  say(`fatal: ${err.message}`);
  process.exit(1);
});
