import { DiscordStreamer } from './discord-streamer.js';
import { StreamerStore, mergeStreamers, parsePublicStreamers, publicView, chooseAccount } from '../../shared/src/streamers.js';

export class StreamerPool {
  constructor({ file, publicSpec = '', userToken = '', log = () => {} } = {}) {
    this.store = new StreamerStore(file);
    this.publicSpec = publicSpec;
    this.userToken = userToken;
    this.log = log;
    this.accounts = new Map();
    this.timer = null;
  }

  specs() {
    const extras = [];
    if (looksPresent(this.userToken)) {
      extras.push({
        id: 'env-user',
        token: this.userToken.trim(),
        channelId: null,
        public: true,
        userId: null,
      });
    }
    return mergeStreamers(this.store.privateRows(), [...parsePublicStreamers(this.publicSpec), ...extras]);
  }

  async reload() {
    const wanted = this.specs();
    const keep = new Set(wanted.map((row) => row.id));
    for (const [id, account] of this.accounts) {
      if (keep.has(id)) continue;
      await account.discord.logout().catch(() => {});
      this.accounts.delete(id);
    }
    for (const row of wanted) {
      let account = this.accounts.get(row.id);
      if (!account) {
        account = { id: row.id, discord: new DiscordStreamer({ userToken: row.token, log: this.log }), busy: false, homeJoined: false };
        this.accounts.set(row.id, account);
        try {
          await account.discord.login();
          account.discord.userId = account.discord.userId || account.discord.client?.user?.id || null;
          if (!row.public) this.store.setUserId(row.id, account.discord.userId);
        } catch (err) {
          this.log(`streamer ${row.label} did not log in: ${err.message}`);
        }
      }
      account.record = { ...row, userId: account.discord.userId || row.userId || null };
      if (account.discord.ready && !account.named) {
        await account.discord.rename(row.label);
        account.named = true;
      }
      if (account.discord.ready && row.channelId) await this.park(account);
    }
    this.startParking();
    return this.list();
  }

  list() {
    return this.specs().map((row) => {
      const account = this.accounts.get(row.id);
      return publicView({
        ...row,
        userId: account?.discord.userId || account?.record?.userId || row.userId,
        active: !!account?.discord.ready,
        busy: !!account?.busy,
      });
    });
  }

  acquire({ guildId, channelId }) {
    const choice = chooseAccount(this.list(), { channelId });
    if (!choice) return null;
    const account = this.accounts.get(choice.account.id);
    if (!account?.discord.ready) return null;
    account.busy = true;
    account.guildId = guildId;
    return { account, channelId: choice.channelId, mode: choice.mode, userId: account.discord.userId, label: choice.account.label };
  }

  async release(id) {
    const account = this.accounts.get(id);
    if (!account) return;
    account.busy = false;
    if (account.record?.channelId) await this.park(account);
  }

  async park(account) {
    if (!account?.discord.ready || account.busy || !account.record?.channelId) return;
    if (account.discord.currentChannelId === account.record.channelId && account.discord.connected) return;
    const channel = await account.discord.client.channels.fetch(account.record.channelId).catch(() => null);
    if (!channel?.guildId && !channel?.guild?.id) return;
    const guildId = channel.guildId || channel.guild.id;
    await account.discord.joinVoice(guildId, account.record.channelId);
    await account.discord.nickname(guildId, account.record.label);
    account.homeJoined = true;
  }

  async pickChannel(guildId) {
    const ready = [...this.accounts.values()].find((account) => account.discord.ready && !account.busy);
    if (!ready) throw new Error('No streamer is logged in.');
    return ready.discord.pickVoiceChannel(guildId);
  }

  startParking() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      for (const account of this.accounts.values()) {
        this.park(account).catch((err) => this.log(`home channel rejoin failed: ${err.message}`));
      }
    }, 15000);
    this.timer.unref?.();
  }

  async close() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const account of this.accounts.values()) {
      await account.discord.logout().catch(() => {});
    }
    this.accounts.clear();
  }
}

function looksPresent(value) {
  return typeof value === 'string' && value.trim().length > 40;
}
