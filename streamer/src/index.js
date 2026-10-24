// STREAMER entry point.
//
// This process is the selfbot half. It has no commands and no user interface.
// All it does is:
//
//   - log a user account in
//   - listen on a loopback port for commands from the controller
//   - run the playback engine (browser or ffmpeg) and push video to Discord
//
// Run it with:  npm run start:streamer

import 'dotenv/config';
import path from 'node:path';
import { IpcServer } from './ipc-server.js';
import { StreamerPool } from './pool.js';
import { PlaybackEngine } from '../../player/src/playback-engine.js';
import { installExitGuard, killOrphans } from '../../player/src/process-guard.js';
import { CMD, STATE } from '../../shared/src/ipc-protocol.js';
import { withRetry } from '../../shared/src/retry.js';

const log = (...args) => console.log('[streamer]', ...args);

async function main() {
  installExitGuard(log);

  // Clear out anything a previous run left behind. A crashed streamer orphans
  // its FFmpeg and Xvfb children, and on a small VPS those add up fast enough
  // to stop the next run from starting.
  killOrphans(undefined, log);

  const ipcPort = Number(process.env.IPC_PORT || 8787);
  const ipcToken = process.env.IPC_TOKEN || '';
  const mirrors = (process.env.MEGAPLAY_MIRRORS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (process.env.PLAYER_BACKEND && process.env.PLAYER_BACKEND !== 'browser') {
    log(`ignoring PLAYER_BACKEND=${process.env.PLAYER_BACKEND}, playback is browser only`);
  }

  const engine = new PlaybackEngine({ mirrors, log });
  const pool = new StreamerPool({
    file: process.env.STREAMER_FILE || path.resolve(process.cwd(), 'Streamer.json'),
    publicSpec: process.env.PUBLIC_STREAMERS || '',
    log,
  });
  let active = null;

  // Voice and stream auto-reconnect: the library raises gateway events, and we
  // additionally re-join on a timer when the connection has gone away.
  let reconnectTimer = null;
  const startReconnectWatcher = () => {
    if (reconnectTimer) return;
    reconnectTimer = setInterval(async () => {
      if (engine.stopping || engine.endedNaturally || !engine.active || active?.discord.connected) return;
      const req = engine.request;
      if (!req || !active) return;
      log('voice connection lost, rejoining');
      try {
        await withRetry(() => active.discord.joinVoice(req.guildId, req.channelId), { attempts: 5, baseMs: 1000, maxMs: 15000, signal: undefined });
        await active.discord.streamTo({ guildId: req.guildId, input: engine.stream });
      } catch (e) {
        log(`reconnect failed: ${e.message}`);
      }
    }, 5000);
    reconnectTimer.unref?.();
  };

  // Login with retries, because a cold network is the usual reason it fails.
  await pool.reload().catch((err) => log(`streamer roster failed: ${err.message}`));

  const ipc = new IpcServer({ port: ipcPort, token: ipcToken, log });
  await ipc.start();
    log('ready. playback is browser only');

  /** Currently running stream promise, so stop can cancel it. */
  let streamPromise = null;
  let streamAbort = null;
  let gate = Promise.resolve();

  function gateRun(fn) {
    const run = gate.then(fn, fn);
    gate = run.then(() => {}, () => {});
    return run;
  }

  async function endLive() {
    const abort = streamAbort;
    const account = active;
    try { abort?.abort(); } catch { /* ignore */ }
    await account?.discord.endStream();
    if (streamPromise) {
      await Promise.race([
        streamPromise.catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, 4000)),
      ]);
    }
    if (streamAbort === abort) streamAbort = null;
    streamPromise = null;
    if (account) await pool.release(account.id).catch((err) => log(`park failed: ${err.message}`));
    if (active === account) active = null;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  async function startPlay(body) {
    if (engine.active || active) {
      const err = new Error('A stream is already running. Stop it first.');
      err.code = 'conflict';
      throw err;
    }
    let channelId = body.channelId;
    const picked = pool.acquire({ guildId: body.guildId, channelId });
    if (!picked) {
      const err = new Error('No streamer is free. Add one with /streamer or set PUBLIC_STREAMERS.');
      err.code = 'conflict';
      throw err;
    }
    if (!picked.channelId) channelId = await picked.account.discord.pickVoiceChannel(body.guildId);
    else channelId = picked.channelId;
    active = picked.account;
    let input;
    try {
      await picked.account.discord.nickname(body.guildId, picked.label);
      await picked.account.discord.joinVoice(body.guildId, channelId);
      startReconnectWatcher();
      input = await engine.play({ ...body, channelId }, { startAt: body.startAt || 0 });
    } catch (err) {
      await pool.release(picked.account.id).catch(() => {});
      if (active === picked.account) active = null;
      throw err;
    }
    streamAbort = new AbortController();
    const abort = streamAbort;
    streamPromise = picked.account.discord
      .streamTo({ guildId: body.guildId, input, signal: abort.signal })
      .then(async () => {
        log('media ended');
        if (streamAbort === abort) {
          await picked.account.discord.endStream().catch((err) => log(`end stream failed: ${err.message}`));
        }
      })
      .catch((e) => {
        if (!abort.signal.aborted) log(`stream error: ${e.message}`);
      });
    return { started: true, status: engine.status(), channelId, streamerId: picked.account.id, userId: picked.userId };
  }

  async function stopPlay() {
    const abort = streamAbort;
    const account = active;
    try { abort?.abort(); } catch { /* ignore */ }
    await account?.discord.stopAll();
    await engine.stop();
    if (account) await pool.release(account.id).catch((err) => log(`park failed: ${err.message}`));
    if (active === account) active = null;
    if (streamAbort === abort) streamAbort = null;
    streamPromise = null;
    return { stopped: true, status: engine.status() };
  }

  ipc.on('command', async (type, body) => {
    switch (type) {
      case CMD.PING:
        return { pong: true, active: engine.active };

      case CMD.STATUS:
        return { status: engine.status(), connected: !!active?.discord.connected };

      case CMD.STREAMERS:
        return { streamers: pool.list() };

      case CMD.STREAMERS_RELOAD:
        return { streamers: await pool.reload() };

      case CMD.PICK_CHANNEL:
        return { channelId: await pool.pickChannel(body.guildId) };

      case CMD.PLAY:
        return gateRun(() => startPlay(body));

      case CMD.PAUSE:
        return { paused: await engine.pause(), status: engine.status() };

      case CMD.RESUME:
        return { resumed: await engine.resume(), status: engine.status() };

      case CMD.SEEK: {
        const to = await engine.seek(Number(body.seconds));
        return { position: to, status: engine.status() };
      }

      case CMD.SKIP: {
        const result = await engine.skip();
        return { ...result, status: engine.status() };
      }

      case CMD.SKIP_INTRO: {
        const result = await engine.skipIntro();
        return { ...result, status: engine.status() };
      }

      case CMD.SKIP_OUTRO: {
        const result = await engine.skipOutro();
        return { ...result, status: engine.status() };
      }

      case CMD.SKIP_RECAP: {
        const result = await engine.skipRecap();
        return { ...result, status: engine.status() };
      }

      case CMD.VOLUME: {
        const level = await engine.setVolume(body.level);
        return { level, status: engine.status() };
      }

      case CMD.CAPTIONS: {
        const on = await engine.setCaptions(body.on);
        return { captions: on, status: engine.status() };
      }

      case CMD.STOP:
        return gateRun(() => stopPlay());

      default:
        throw new Error(`Unhandled command ${type}`);
    }
  });

  // When the engine errors or restarts, the controller finds out on its next
  // status poll, so no push channel is needed.
  engine.on('state', (s) => log(`state -> ${s.state}${s.error ? ` (${s.error})` : ''}`));
  engine.on('restarted', (info) => log(`restarted at ${info.at.toFixed(1)}s, new stream ready`));
  engine.on('ended', () => {
    log('episode reached the end, ending the Go Live');
    gateRun(() => endLive()).catch((err) => log(`end stream failed: ${err.message}`));
  });

  const shutdown = async (reason) => {
    log(`shutting down (${reason})`);
    try { streamAbort?.abort(); } catch { /* ignore */ }
    await pool.close().catch(() => {});
    await engine.stop().catch(() => {});
    await ipc.stop().catch(() => {});
    killOrphans(undefined, log);
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[streamer] fatal:', err?.message);
  killOrphans(undefined, log);
  process.exit(1);
});
