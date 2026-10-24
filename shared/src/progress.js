// Per user watch progress, kept in a JSON file on the VPS.
//
// Two things are remembered for each (user, anime, episode):
//   how many seconds in they got, and which episode they were on.
// That is enough to offer "continue where you left off" and to know where an
// autoplay run had reached.
//
// The file is written atomically (write a temp file, then rename) so a crash
// mid-write cannot corrupt the whole history.

import fs from 'node:fs';
import path from 'node:path';

// Past this fraction of an episode we call it watched, and resume starts from
// the beginning instead of the last few seconds of credits.
export const FINISHED_FRACTION = 0.95;
// Below this many seconds there is nothing worth resuming.
export const MIN_RESUME_SECONDS = 30;

export class ProgressStore {
  /**
   * @param {string} file where the JSON lives
   * @param {(m: string) => void} [log]
   */
  constructor(file, log = () => {}) {
    this.file = file;
    this.log = log;
    this.data = { progress: {} };
    this.load();
    // Date.now() can return the same millisecond twice in a row, which makes a
    // timestamp-only ordering ambiguous. Every save also takes the next number
    // in this sequence, so "most recent" is always decided.
    this.seq = Object.values(this.data.progress).reduce((max, row) => Math.max(max, row.seq || 0), 0);
  }

  load() {
    try {
      if (fs.existsSync(this.file)) {
        this.data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        if (!this.data.progress) this.data.progress = {};
      }
    } catch (err) {
      // A broken history file should not stop the bot from starting.
      this.log(`could not read progress file (${err.message}), starting fresh`);
      this.data = { progress: {} };
    }
  }

  /** Save now. Cheap enough to call on every meaningful change. */
  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
      fs.renameSync(tmp, this.file);
    } catch (err) {
      this.log(`could not write progress file: ${err.message}`);
    }
  }

  static key(userId, malId, episode) {
    return `${userId}:${malId}:${episode}`;
  }

  /**
   * Record where someone is in an episode.
   *
   * @param {object} p
   * @param {string} p.userId
   * @param {number} p.malId
   * @param {number} p.episode
   * @param {number} p.position seconds in
   * @param {number} p.duration episode length in seconds
   * @param {'sub'|'dub'} [p.audio]
   * @param {boolean} [p.captions]
   */
  set({ userId, malId, episode, position, duration, audio, captions, title, format }) {
    const key = ProgressStore.key(userId, malId, episode);
    const finished = duration > 0 && position >= duration * FINISHED_FRACTION;
    const prev = this.data.progress[key];
    this.seq += 1;
    this.data.progress[key] = {
      position: Math.max(0, Math.floor(position)),
      duration: Math.max(0, Math.floor(duration || 0)),
      audio: audio ?? prev?.audio ?? 'sub',
      captions: captions ?? prev?.captions ?? true,
      title: title ?? prev?.title ?? null,
      format: format ?? prev?.format ?? null,
      finished,
      updatedAt: Date.now(),
      seq: this.seq,
    };
    this.save();
    return this.data.progress[key];
  }

  get(userId, malId, episode) {
    return this.data.progress[ProgressStore.key(userId, malId, episode)] || null;
  }

  /**
   * Where playback should start for this episode.
   * Returns 0 when there is nothing worth resuming: no record, already
   * finished, or only a few seconds watched.
   */
  resumeAt(userId, malId, episode) {
    const rec = this.get(userId, malId, episode);
    if (!rec || rec.finished) return 0;
    if (rec.position < MIN_RESUME_SECONDS) return 0;
    if (rec.duration > 0 && rec.position >= rec.duration - 5) return 0;
    return rec.position;
  }

  /** Everything stored for one user, newest first. */
  forUser(userId) {
    return Object.entries(this.data.progress)
      .filter(([key]) => key.startsWith(`${userId}:`))
      .map(([key, value]) => {
        const [, malId, episode] = key.split(':');
        return { malId: Number(malId), episode: Number(episode), ...value };
      })
      .sort((a, b) => (b.seq || 0) - (a.seq || 0) || b.updatedAt - a.updatedAt);
  }

  /**
   * The most recent unfinished episode for a user.
   * This is what "continue where you left off" points at.
   */
  latestUnfinished(userId) {
    return this.forUser(userId).find((r) => !r.finished) || null;
  }

  namesForUser(userId) {
    const seen = new Set();
    const names = [];
    for (const row of this.forUser(userId)) {
      const title = String(row.title || '').trim();
      if (!title) continue;
      const key = title.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      names.push(title);
    }
    return names;
  }

  latestForMal(userId, malId) {
    return this.forUser(userId).find((row) => row.malId === Number(malId)) || null;
  }

  latestForTitle(userId, title) {
    const want = String(title || '').trim().toLowerCase();
    if (!want) return null;
    const rows = this.forUser(userId).filter((row) => String(row.title || '').trim().toLowerCase() === want);
    return rows.find((row) => !row.finished) || rows[0] || null;
  }

  /** The highest episode number seen for a series, finished or not. */
  furthestEpisode(userId, malId) {
    const rows = this.forUser(userId).filter((r) => r.malId === malId);
    if (!rows.length) return null;
    return rows.reduce((best, r) => (r.episode > best ? r.episode : best), rows[0].episode);
  }

  /** Drop one record. Used when an episode is marked watched on purpose. */
  clear(userId, malId, episode) {
    delete this.data.progress[ProgressStore.key(userId, malId, episode)];
    this.save();
  }
}
