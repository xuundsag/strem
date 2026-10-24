// The streamer's control socket.
//
// A small HTTP server bound to 127.0.0.1 only. The controller posts JSON
// commands here and gets JSON back. Nothing is ever exposed to the network:
// the VPS firewall does not need to know this port exists.
//
// Endpoints
//   POST /cmd/play    { malId, episode, audio, captions, guildId, channelId, ... }
//   POST /cmd/pause
//   POST /cmd/resume
//   POST /cmd/seek    { seconds }
//   POST /cmd/skip
//   POST /cmd/stop
//   GET  /status
//   GET  /healthz
//
// Auth is a shared bearer token from .env. Loopback already limits who can
// connect; the token stops other processes on the same box from driving it.

import http from 'node:http';
import { EventEmitter } from 'node:events';
import { CMD, validate, validatePlayRequest, checkAuth } from '@anime-stream/shared/ipc-protocol.js';
import { redact } from '@anime-stream/shared/http.js';

const MAX_BODY = 64 * 1024;

export class IpcServer extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} [o.host]
   * @param {number} [o.port] 0 picks a free port
   * @param {string} [o.token] shared secret
   * @param {(m:string)=>void} [o.log]
   */
  constructor({ host = '127.0.0.1', port = 8787, token = '', log = () => {} } = {}) {
    super();
    this.host = host;
    this.port = port;
    this.token = token;
    this.log = log;
    this.server = null;
    this.actualPort = null;
  }

  async start() {
    this.server = http.createServer((req, res) => this._handle(req, res).catch((e) => this._reply(res, 500, { ok: false, error: e.message })));
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.port, this.host, resolve);
    });
    this.actualPort = this.server.address().port;
    this.log(`ipc listening on ${this.host}:${this.actualPort}`);
    return this;
  }

  get url() {
    return `http://${this.host}:${this.actualPort}`;
  }

  async _handle(req, res) {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const path = url.pathname;

    if (req.method === 'GET' && path === '/healthz') {
      return this._reply(res, 200, { ok: true, service: 'streamer' });
    }

    // Everything else needs the token.
    if (!checkAuth(req.headers.authorization, this.token)) {
      this.log('ipc: rejected a request with a bad token');
      return this._reply(res, 401, { ok: false, error: 'Not authorised.' });
    }

    if (req.method === 'GET' && path === '/status') {
      const status = await this._emitCommand(CMD.STATUS, {});
      return this._reply(res, 200, { ok: true, ...status });
    }

    if (req.method !== 'POST' || !path.startsWith('/cmd/')) {
      return this._reply(res, 404, { ok: false, error: `No route for ${req.method} ${path}` });
    }

    // Refuse oversized bodies before reading them. Rejecting after the read
    // would mean closing the socket mid-response, which shows up to the client
    // as a connection reset instead of a usable 413.
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > MAX_BODY) {
      return this._reply(res, 413, { ok: false, error: `Request body is larger than ${MAX_BODY} bytes` });
    }
    let body;
    try {
      body = await readBody(req);
    } catch (err) {
      // Unreadable or unparseable input is a 4xx. Letting it reach the outer
      // handler would report the client's mistake as our failure.
      return this._reply(res, err.status || 400, { ok: false, error: err.message });
    }
    const envelopeError = validate(body);
    if (envelopeError) return this._reply(res, 400, { ok: false, error: envelopeError });

    const type = body.type ?? path.slice('/cmd/'.length);
    if (!Object.values(CMD).includes(type)) {
      return this._reply(res, 400, { ok: false, error: `Unknown command "${type}"` });
    }

    if (type === CMD.PLAY) {
      const check = validatePlayRequest(body);
      if (!check.ok) return this._reply(res, 400, { ok: false, code: check.code, error: check.error });
    }
    if (type === CMD.SEEK && !Number.isFinite(Number(body.seconds))) {
      return this._reply(res, 400, { ok: false, error: 'seek needs a numeric seconds field' });
    }

    this.log(`ipc: ${type} ${redact(JSON.stringify(body)).slice(0, 160)}`);
    try {
      const result = await this._emitCommand(type, body);
      return this._reply(res, 200, { ok: true, ...(result || {}) });
    } catch (err) {
      // 409 for "you cannot do that right now", 500 for genuine failures.
      const code = err.status || (err.code === 'conflict' ? 409 : 500);
      return this._reply(res, code, { ok: false, error: err.message });
    }
  }

  /**
   * Hand the command to whoever is listening. The streamer process registers a
   * single handler, which keeps this server free of playback logic.
   */
  async _emitCommand(type, body) {
    const listeners = this.listeners('command');
    if (!listeners.length) throw Object.assign(new Error('Streamer is not ready yet.'), { code: 'conflict' });
    return listeners[0](type, body);
  }

  _reply(res, status, payload) {
    if (res.writableEnded || res.destroyed) return;
    const body = JSON.stringify(payload);
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
    res.end(body);
  }

  async stop() {
    if (!this.server) return;
    await new Promise((resolve) => this.server.close(resolve));
    this.server = null;
  }
}

/** Read a JSON body with a size cap so a bad client cannot exhaust memory. */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error(`Request body is larger than ${MAX_BODY} bytes`), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text.trim()) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        // A client mistake is a 400, not a server fault.
        reject(Object.assign(new Error('Body is not valid JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}
