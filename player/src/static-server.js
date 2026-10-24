// Serves the player page to Chromium.
//
// hls.js is inlined into the HTML at request time, so the browser makes
// exactly one request and nothing can fail because a CDN is down.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.resolve(__dirname, '../web');

/** Locate the vendored hls.js inside node_modules. */
export function findHlsJs() {
  const candidates = [
    path.resolve(__dirname, '../../../node_modules/hls.js/dist/hls.min.js'),
    path.resolve(__dirname, '../node_modules/hls.js/dist/hls.min.js'),
    path.resolve(process.cwd(), 'node_modules/hls.js/dist/hls.min.js'),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return null;
}

let cachedPage = null;

/** Build the player page with hls.js inlined. Cached after the first call. */
export function buildPlayerPage() {
  if (cachedPage) return cachedPage;
  const html = fs.readFileSync(path.join(WEB_DIR, 'player.html'), 'utf8');
  const hlsPath = findHlsJs();
  const hls = hlsPath ? fs.readFileSync(hlsPath, 'utf8') : '/* hls.js not found */';
  cachedPage = html.replace('/*__HLSJS__*/', () => hls);
  return cachedPage;
}

export class StaticServer {
  constructor({ host = '127.0.0.1', log = () => {} } = {}) {
    this.host = host;
    this.log = log;
    this.server = null;
    this.port = null;
  }

  async start() {
    this.server = http.createServer((req, res) => {
      const url = (req.url || '/').split('?')[0];
      if (url === '/' || url === '/player.html') {
        const body = buildPlayerPage();
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(body);
      }
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    });
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, this.host, resolve);
    });
    this.port = this.server.address().port;
    this.log(`static server on ${this.host}:${this.port}`);
    return this;
  }

  get playerUrl() {
    return `http://${this.host}:${this.port}/player.html`;
  }

  async stop() {
    if (!this.server) return;
    await new Promise((resolve) => this.server.close(resolve));
    this.server = null;
  }
}
