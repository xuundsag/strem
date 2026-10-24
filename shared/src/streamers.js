import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function streamerLabel(index) {
  let n = index;
  let suffix = '';
  do {
    suffix = String.fromCharCode(65 + (n % 26)) + suffix;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return `Streamer ${suffix}`;
}

export function looksLikeToken(value) {
  const token = String(value || '').trim();
  if (token.length < 50 || token.length > 400) return false;
  if (/\s/.test(token)) return false;
  return token.startsWith('mfa.') || token.split('.').length >= 3;
}

export function parsePublicStreamers(value) {
  return String(value || '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((entry) => {
      const at = entry.lastIndexOf('@');
      const channelId = at > 0 ? entry.slice(at + 1) : '';
      if (/^\d{15,25}$/.test(channelId)) {
        return {
          id: `pub-${crypto.createHash('sha256').update(entry.slice(0, at)).digest('hex').slice(0, 12)}`,
          token: entry.slice(0, at),
          channelId,
          public: true,
          userId: null,
        };
      }
      return {
        id: `pub-${crypto.createHash('sha256').update(entry).digest('hex').slice(0, 12)}`,
        token: entry,
        channelId: null,
        public: true,
        userId: null,
      };
    })
    .filter((row) => looksLikeToken(row.token));
}

export function mergeStreamers(privateRows, publicRows) {
  const seen = new Set();
  const rows = [];
  for (const row of [...(publicRows || []), ...(privateRows || [])]) {
    if (!row?.token || seen.has(row.token)) continue;
    seen.add(row.token);
    rows.push(row);
  }
  return rows.map((row, index) => ({ ...row, label: streamerLabel(index) }));
}

export function publicView(row) {
  return {
    id: row.id,
    label: row.label,
    userId: row.userId || null,
    public: !!row.public,
    channelId: row.channelId || null,
    active: !!row.active,
    busy: !!row.busy,
  };
}

export function chooseAccount(accounts, { channelId } = {}) {
  const free = (accounts || []).filter((row) => row.active && !row.busy);
  if (!free.length) return null;
  if (channelId) {
    const home = free.find((row) => row.channelId === channelId);
    if (home) return { account: home, channelId, mode: 'home' };
    const roam = free.find((row) => !row.channelId);
    if (roam) return { account: roam, channelId, mode: 'roam' };
    const pinned = free.find((row) => row.channelId);
    if (pinned) return { account: pinned, channelId: pinned.channelId, mode: 'pinned' };
  }
  const pinned = free.find((row) => row.channelId);
  if (pinned) return { account: pinned, channelId: pinned.channelId, mode: 'pinned' };
  const roam = free.find((row) => !row.channelId);
  if (roam) return { account: roam, channelId: null, mode: 'random' };
  return null;
}

export class StreamerStore {
  constructor(file) {
    this.file = file;
    this.data = { streamers: [] };
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(this.file)) {
        const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        this.data = { streamers: Array.isArray(parsed.streamers) ? parsed.streamers : [] };
      }
    } catch {
      this.data = { streamers: [] };
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }

  privateRows() {
    return this.data.streamers.filter((row) => row && !row.public && row.token);
  }

  add({ token, channelId, addedBy }) {
    const clean = String(token || '').trim();
    if (!looksLikeToken(clean)) {
      const err = new Error('That does not look like a user token.');
      err.code = 'bad_token';
      throw err;
    }
    if (this.data.streamers.some((row) => row.token === clean)) {
      const err = new Error('That streamer is already saved.');
      err.code = 'duplicate';
      throw err;
    }
    const row = {
      id: `s-${crypto.randomBytes(6).toString('hex')}`,
      token: clean,
      channelId: /^\d{15,25}$/.test(String(channelId || '')) ? String(channelId) : null,
      public: false,
      userId: null,
      addedBy: addedBy ? String(addedBy) : null,
      addedAt: Date.now(),
    };
    this.data.streamers.push(row);
    this.save();
    return { id: row.id, channelId: row.channelId };
  }

  remove(id) {
    const before = this.data.streamers.length;
    this.data.streamers = this.data.streamers.filter((row) => row.id !== id || row.public);
    if (this.data.streamers.length === before) return false;
    this.save();
    return true;
  }

  setUserId(id, userId) {
    const row = this.data.streamers.find((item) => item.id === id);
    if (!row || row.userId === userId) return;
    row.userId = userId;
    this.save();
  }
}
