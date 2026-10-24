// Configuration, read once at startup.
//
// Everything comes from .env. Nothing here has a usable default for a secret,
// so a missing token fails loudly at boot instead of half an hour into a
// stream.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Split a comma separated env value into a trimmed, non-empty list. */
function list(value) {
  return String(value || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function int(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function bool(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

export function loadConfig(env = process.env) {
  return {
    botName: env.BOT_NAME || 'Jinx',

    botToken: env.DISCORD_BOT_TOKEN || '',
    clientId: env.DISCORD_CLIENT_ID || '',
    guildId: env.GUILD_ID || '',

    // Who is allowed to press the panel buttons besides the person who started
    // playback. Empty means "only the requester".
    allowedRoleIds: list(env.ALLOWED_ROLE_IDS),
    // Who may use /play at all. Empty means "anyone who can see the channel".
    allowedCommandRoleIds: list(env.ALLOWED_COMMAND_ROLE_IDS),

    // Where the streamer listens.
    ipcBaseUrl: env.IPC_URL || 'http://127.0.0.1:8787',
    ipcToken: env.IPC_TOKEN || '',

    // Optional metadata keys. Both are free to obtain and both are optional:
    // without them Jinx falls back to the MAL cover.
    tmdbKey: env.TMDB_API_KEY || '',
    fanartKey: env.FANART_API_KEY || '',

    progressFile: env.PROGRESS_FILE || path.join(ROOT, 'data', 'progress.json'),
    streamerFile: env.STREAMER_FILE || path.join(ROOT, 'Streamer.json'),
    publicStreamers: env.PUBLIC_STREAMERS || '',

    // The panel is edited at most this often, which keeps us clear of Discord's
    // per channel edit rate limit.
    panelRefreshMs: int(env.PANEL_REFRESH_MS, 5000),

    // Where Jinx saves progress, in seconds.
    progressSaveIntervalMs: int(env.PROGRESS_SAVE_MS, 15000),

    autoplayDefault: bool(env.AUTOPLAY_DEFAULT, true),
    logLevel: env.LOG_LEVEL || 'info',
  };
}

/** Fail early with a message that says exactly which variable to set. */
export function assertConfig(config) {
  const problems = [];
  if (!config.botToken) problems.push('DISCORD_BOT_TOKEN');
  if (!config.clientId) problems.push('DISCORD_CLIENT_ID');
  if (problems.length) {
    throw new Error(
      `Missing ${problems.join(' and ')} in .env. Copy .env.example to .env, fill those in, then start again.`,
    );
  }
  if (!fs.existsSync(config.progressFile)) {
    fs.mkdirSync(path.dirname(config.progressFile), { recursive: true });
  }
}
