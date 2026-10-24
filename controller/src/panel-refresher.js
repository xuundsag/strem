// Panel refresh, rate limited.
//
// Discord allows roughly one edit per channel per second, and a panel that
// rewrites itself on every position tick will get the bot rate limited within
// minutes. So edits are coalesced: ask as often as you like, and this will
// perform at most one edit per interval, using the newest state it was given.
//
// It also refuses to send an edit when nothing visible changed, which cuts most
// of the traffic on a paused stream.

import { buildPanel } from '@anime-stream/shared/panel.js';

export class PanelRefresher {
  /**
   * @param {object} o
   * @param {number} [o.intervalMs] minimum time between edits
   * @param {number} [o.flags] message flags to set on every edit. The panel is
   *   a Container, so this has to include Components V2 or Discord rejects it.
   * @param {(m: string) => void} [o.log]
   */
  constructor({ intervalMs = 5000, flags = 0, log = () => {} } = {}) {
    this.intervalMs = intervalMs;
    this.flags = flags;
    this.log = log;
    /** @type {Map<string, object>} message id -> bookkeeping */
    this.targets = new Map();
    this.timer = null;
  }

  /**
   * Register the message to keep up to date.
   * @param {string} key a stable id, normally `${guildId}`
   * @param {import('discord.js').Message} message
   */
  setTarget(key, message) {
    this.targets.set(key, { message, flags: this.flags, lastPayload: null, pending: null, lastEditAt: 0, failures: 0 });
    this._ensureTimer();
  }

  dropTarget(key) {
    this.targets.delete(key);
    if (!this.targets.size && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Queue the newest state for a key. Does not edit by itself. */
  update(key, state) {
    const entry = this.targets.get(key);
    if (!entry) return;
    entry.pending = state;
    this._ensureTimer();
  }

  _ensureTimer() {
    if (this.timer) return;
    this.timer = setInterval(() => this.flush().catch((e) => this.log(`panel refresh failed: ${e.message}`)), 500);
    this.timer.unref?.();
  }

  /** Perform any edits that are due. Exposed so tests can drive it directly. */
  async flush() {
    const now = Date.now();
    for (const [key, entry] of this.targets) {
      if (!entry.pending) continue;
      if (now - entry.lastEditAt < this.intervalMs) continue;

      const state = entry.pending;
      const container = await buildPanel(state);
      const payload = JSON.stringify(container.toJSON());
      // Same panel as last time: nothing to do.
      if (payload === entry.lastPayload) {
        entry.pending = null;
        continue;
      }

      try {
        // IsComponentsV2 is required for a Container to be accepted at the top
        // level. Passing it on every edit keeps it set even if the message was
        // created some other way.
        await entry.message.edit({ components: [container], flags: entry.flags });
        entry.lastPayload = payload;
        entry.lastEditAt = Date.now();
        entry.failures = 0;
        entry.pending = null;
      } catch (err) {
        entry.failures++;
        this.log(`could not edit the panel (${err.message})`);
        // A message that has been deleted cannot come back, so stop trying.
        if (err.code === 10008 || err.code === 50001 || entry.failures >= 5) {
          this.log('giving up on this panel message');
          this.targets.delete(key);
        }
      }
    }
    if (!this.targets.size && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Edit immediately, ignoring the interval. Used right after a button press. */
  async force(key, state) {
    const entry = this.targets.get(key);
    if (!entry) return;
    entry.lastEditAt = 0;
    entry.pending = state;
    await this.flush();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.targets.clear();
  }
}
