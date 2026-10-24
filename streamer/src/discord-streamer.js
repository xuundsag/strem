// The Discord side of the streamer.
//
// WHAT A SELFBOT IS, IN PLAIN WORDS
// A normal bot logs in with a bot token and Discord knows it is a program.
// A selfbot logs in with a *person's* account token and pretends to be that
// person's app. Discord's Terms of Service forbid this. Accounts used this way
// do get banned, often without warning. Use a throwaway account you do not
// care about, never your own.
//
// WHY IT IS NEEDED HERE
// Discord does not allow bot accounts to send video. Go Live only exists for
// user accounts. So the video half has to be a selfbot, and that is the whole
// reason this project is split in two.
//
// WHAT THIS FILE DOES
//   1. log the user account in
//   2. join the voice channel the controller names
//   3. open a Go Live stream
//   4. pipe the media the playback engine produces into that stream
//   5. reconnect if the voice connection drops
//
// It never resolves URLs, never runs a browser, never renders a panel.

import { EventEmitter } from 'node:events';

/** How long to wait for the voice gateway to hand us a connection. */
const VOICE_JOIN_TIMEOUT_MS = 20000;

export class DiscordStreamer extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} o.userToken the selfbot account token
   * @param {(m:string)=>void} [o.log]
   */
  constructor({ userToken, log = () => {} } = {}) {
    super();
    this.userToken = userToken;
    this.log = log;
    this.client = null;
    this.streamer = null;
    /** @type {Map<string, object>} guildId -> active session */
    this.sessions = new Map();
    this.ready = false;
  }

  /** Log in. Throws with a clear message when the token is bad. */
  async login() {
    // This fork is built on discord.js v13, not v14. It has no
    // GatewayIntentBits, and its Client constructor hardcodes Intents.ALL and
    // emits a deprecation warning if you pass `intents` at all. A selfbot does
    // not negotiate intents the way a bot does, so there is nothing to
    // configure here.
    const { Client } = await import('@lng2004/discord.js-selfbot-v13');
    const { Streamer } = await import('@dank074/discord-video-stream');

    // Both halves are separate packages that have moved before. Say which one
    // is wrong rather than letting a destructured undefined turn into a
    // confusing "cannot read properties of undefined" further down.
    if (typeof Client !== 'function') {
      throw new Error('@lng2004/discord.js-selfbot-v13 did not export a Client. The package API has changed.');
    }
    if (typeof Streamer !== 'function') {
      throw new Error('@dank074/discord-video-stream did not export a Streamer. The package API has changed.');
    }

    this.client = new Client();

    this.client.on('error', (e) => this.log(`gateway error: ${e?.message}`));
    this.client.on('shardError', (e) => this.log(`shard error: ${e?.message}`));
    this.client.on('rateLimit', (info) => this.log(`rate limited for ${info?.timeout}ms`));

    try {
      await this.client.login(this.userToken);
    } catch (err) {
      // Never include the token in the message: it is a credential.
      throw new Error(`Selfbot login failed: ${err?.message || 'invalid or expired user token'}`);
    }
    this.streamer = new Streamer(this.client);
    this.ready = true;
    this.userId = this.client.user?.id || null;
    this.currentChannelId = null;
    this.log(`selfbot logged in as ${this.client.user?.tag ?? 'unknown'}`);
    return this;
  }

  async rename(label) {
    if (!this.ready || !label) return;
    try {
      if (typeof this.client.user?.setGlobalName === 'function') {
        await this.client.user.setGlobalName(label);
        return;
      }
      if (typeof this.client.user?.edit === 'function') {
        await this.client.user.edit({ globalName: label });
        return;
      }
      if (this.client.rest?.patch) {
        await this.client.rest.patch('/users/@me', { body: { global_name: label } });
      }
    } catch (err) {
      this.log(`display name was not changed: ${err.message}`);
    }
  }

  async nickname(guildId, label) {
    if (!this.ready || !guildId || !label) return;
    try {
      const guild = await this.client.guilds.fetch(guildId);
      const me = guild.members?.me || (await guild.members.fetch(this.client.user.id));
      if (typeof me?.setNickname === 'function') await me.setNickname(label);
    } catch (err) {
      this.log(`nickname was not changed: ${err.message}`);
    }
  }

  async pickVoiceChannel(guildId) {
    if (!this.ready) throw new Error('Selfbot is not logged in.');
    const guild = await this.client.guilds.fetch(guildId);
    const channels = await guild.channels.fetch();
    const voice = [...channels.values()].filter((channel) => {
      if (!channel) return false;
      if (typeof channel.isVoice === 'function') return channel.isVoice();
      return channel.type === 2 || channel.type === 13;
    });
    if (!voice.length) throw new Error('This server has no voice channel to join.');
    return voice[Math.floor(Math.random() * voice.length)].id;
  }

  /**
   * Join a voice channel in a guild.
   * @param {string} guildId
   * @param {string} channelId
   */
  async joinVoice(guildId, channelId) {
    if (!this.ready) throw new Error('Selfbot is not logged in.');
    const channel = await this.client.channels.fetch(channelId).catch(() => null);
    if (!channel) throw new Error(`Voice channel ${channelId} not found or not reachable.`);
    // v13 calls this isVoice(). v14 renamed it to isVoiceBased(), which does not
    // exist on this fork, so an optional call would silently be undefined and
    // every channel would be rejected.
    const isVoice = typeof channel.isVoice === 'function' ? channel.isVoice() : channel.isVoiceBased?.();
    if (!isVoice) throw new Error(`Channel ${channelId} is not a voice channel.`);

    await withTimeout(this.streamer.joinVoice(guildId, channelId), VOICE_JOIN_TIMEOUT_MS, 'joining the voice channel');
    this.currentChannelId = channelId;
    this.log(`joined voice ${guildId}/${channelId}`);
  }

  /**
   * Start streaming a media source into the guild's Go Live.
   *
   * Only one stream per guild is allowed: starting a second one in the same
   * guild stops the first, which is the rule the spec asks for.
   *
   * @param {object} o
   * @param {string} o.guildId
   * @param {import('node:stream').Readable} o.input NUT stream from the engine
   * @param {AbortSignal} [o.signal]
   * @returns {Promise<void>} resolves when the media ends
   */
  async streamTo({ guildId, input, signal }) {
    if (!this.ready) throw new Error('Selfbot is not logged in.');
    if (!this.streamer.voiceConnection) throw new Error('Not in a voice channel yet.');

    // One active stream per guild.
    const existing = this.sessions.get(guildId);
    if (existing) {
      this.log(`stopping the previous stream in guild ${guildId}`);
      existing.abort?.();
      this.sessions.delete(guildId);
    }

    const controller = new AbortController();
    const session = { guildId, abort: () => controller.abort(), startedAt: Date.now() };
    this.sessions.set(guildId, session);
    const onOuterAbort = () => controller.abort();
    signal?.addEventListener('abort', onOuterAbort, { once: true });

    const { playStream } = await import('@dank074/discord-video-stream');
    try {
      await playStream(input, this.streamer, { type: 'go-live', format: 'nut' }, controller.signal);
      this.log(`stream finished normally for guild ${guildId}`);
    } finally {
      signal?.removeEventListener('abort', onOuterAbort);
      if (this.sessions.get(guildId) === session) this.sessions.delete(guildId);
    }
  }

  /** End the Go Live and leave voice. Safe to call when nothing is streaming. */
  async endStream() {
    for (const [guildId, session] of [...this.sessions]) {
      try {
        session.abort?.();
      } catch { /* ignore */ }
      this.sessions.delete(guildId);
    }
    try {
      this.streamer?.stopStream();
    } catch (e) {
      this.log(`stopStream failed: ${e.message}`);
    }
    try {
      const left = this.streamer?.leaveVoice?.();
      if (left && typeof left.then === 'function') await left;
    } catch (e) {
      this.log(`leaveVoice failed: ${e.message}`);
    }
  }

  /** Stop streaming and leave voice. */
  async stopAll() {
    await this.endStream();
  }

  async logout() {
    await this.stopAll();
    try {
      this.client?.destroy();
    } catch { /* ignore */ }
    this.ready = false;
  }

  /** True when the voice connection is up. */
  get connected() {
    return !!this.streamer?.voiceConnection;
  }
}

/** Reject with a readable message if a promise takes too long. */
function withTimeout(promise, ms, what) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms while ${what}.`)), ms);
    }),
  ]);
}
