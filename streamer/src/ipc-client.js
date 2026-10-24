// The controller's side of the IPC link.
//
// A thin fetch wrapper. It turns "pause" into a POST and turns a transport
// failure into a plain Error the panel can render.

import { CMD, encode } from '@anime-stream/shared/ipc-protocol.js';

export class IpcClient {
  /**
   * @param {object} o
   * @param {string} o.baseUrl e.g. http://127.0.0.1:8787
   * @param {string} [o.token]
   * @param {number} [o.timeoutMs]
   */
  constructor({ baseUrl, token = '', timeoutMs = 20000 } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.token = token;
    this.timeoutMs = timeoutMs;
  }

  async _post(type, payload = {}) {
    return this._request(`POST`, `/cmd/${type}`, encode(type, payload));
  }

  async _request(method, path, body) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error('timeout')), this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctrl.signal,
      });
      const text = await res.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : {};
      } catch {
        json = { error: text.slice(0, 200) };
      }
      if (!res.ok) {
        const err = new Error(json?.error || `IPC ${res.status}`);
        err.status = res.status;
        err.code = json?.code;
        throw err;
      }
      return json;
    } finally {
      clearTimeout(timer);
    }
  }

  play(req) { return this._post(CMD.PLAY, req); }
  pause() { return this._post(CMD.PAUSE); }
  resume() { return this._post(CMD.RESUME); }
  seek(seconds) { return this._post(CMD.SEEK, { seconds }); }
  skip() { return this._post(CMD.SKIP); }
  skipIntro() { return this._post(CMD.SKIP_INTRO); }
  skipOutro() { return this._post(CMD.SKIP_OUTRO); }
  skipRecap() { return this._post(CMD.SKIP_RECAP); }
  volume(level) { return this._post(CMD.VOLUME, { level }); }
  setCaptions(on) { return this._post(CMD.CAPTIONS, { on }); }
  stop() { return this._post(CMD.STOP); }
  streamers() { return this._post(CMD.STREAMERS); }
  reloadStreamers() { return this._post(CMD.STREAMERS_RELOAD); }
  pickChannel(guildId) { return this._post(CMD.PICK_CHANNEL, { guildId }); }
  status() { return this._request('GET', '/status'); }
  health() { return this._request('GET', '/healthz'); }
}
