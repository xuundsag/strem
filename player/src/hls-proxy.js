// Local HLS proxy.
//
// Two problems, one fix:
//
//  1. The video CDN serves real MPEG-TS segments under disguised extensions
//     (seg-00000.jpg, seg-00001.html, seg-00002.js) and a JPEG content type.
//     Verified live with ffprobe: the bytes are a genuine H.264 MPEG-TS.
//     FFmpeg's HLS demuxer refuses them because it only accepts a whitelist of
//     segment extensions, and hls.js also wants a sane content type.
//
//  2. The CDN blocks requests without a Referer of https://megaplay.buzz/.
//     A browser loading a video can send a Referer, but not an arbitrary one,
//     so we cannot point hls.js straight at the CDN.
//
// So we serve the whole playlist tree from 127.0.0.1, rewrite every URI to
// point back at ourselves, and add the required headers on the way out.

import http from 'node:http';
import { mediaHeaders } from '@anime-stream/shared/urls.js';

const SEGMENT_MIME = 'video/mp2t';
const PLAYLIST_MIME = 'application/vnd.apple.mpegurl';

/** Is this URL a playlist rather than a media segment? */
function looksLikePlaylist(url) {
  return /\.m3u8(\?|$)/i.test(url);
}

/**
 * Rewrite one playlist body so every URI goes through the proxy.
 *
 * Handles the HLS tags that carry URIs:
 *   plain segment lines
 *   #EXT-X-STREAM-INF followed by a variant line
 *   #EXT-X-MEDIA ... URI="..."
 *   #EXT-X-MAP / #EXT-X-KEY / #EXT-X-I-FRAME-STREAM-INF ... URI="..."
 *
 * @param {string} text playlist body
 * @param {string} baseUrl the URL the playlist itself was fetched from
 * @param {(abs:string)=>string} toProxy maps an absolute upstream URL to a proxy path
 */
export function rewritePlaylist(text, baseUrl, toProxy) {
  const lines = text.split(/\r?\n/);
  const out = [];
  let pendingVariant = false;

  for (const line of lines) {
    if (line.startsWith('#EXT-X-STREAM-INF') || line.startsWith('#EXT-X-I-FRAME-STREAM-INF')) {
      out.push(rewriteUriAttribute(line, baseUrl, toProxy));
      if (line.startsWith('#EXT-X-STREAM-INF')) pendingVariant = true;
      continue;
    }
    if (line.startsWith('#')) {
      out.push(rewriteUriAttribute(line, baseUrl, toProxy));
      continue;
    }
    const trimmed = line.trim();
    if (!trimmed) {
      out.push(line);
      continue;
    }
    // A bare line is a URI: either the variant after EXT-X-STREAM-INF, or a
    // media segment.
    const abs = new URL(trimmed, baseUrl).toString();
    out.push(toProxy(abs));
    pendingVariant = false;
    void pendingVariant;
  }
  return out.join('\n');
}

/** Rewrite a URI="..." attribute inside an HLS tag, if present. */
function rewriteUriAttribute(line, baseUrl, toProxy) {
  return line.replace(/URI="([^"]+)"/g, (_m, u) => {
    const abs = new URL(u, baseUrl).toString();
    return `URI="${toProxy(abs)}"`;
  });
}

export class HlsProxy {
  /**
   * @param {object} o
   * @param {string} o.masterUrl upstream master playlist
   * @param {string} [o.host] bind address, defaults to loopback
   * @param {(msg:string)=>void} [o.log]
   */
  constructor({ masterUrl, host = '127.0.0.1', log = () => {} }) {
    this.masterUrl = masterUrl;
    this.host = host;
    this.log = log;
    /** @type {Map<string,string>} proxy key -> absolute upstream URL */
    this.routes = new Map();
    this.nextId = 1;
    this.server = null;
    this.port = null;
    this.stats = { playlistFetches: 0, segmentFetches: 0, errors: 0 };
    this.masterPath = null;
  }

  /**
   * Register an upstream URL and return the path that serves it.
   *
   * The path carries a file extension on purpose. FFmpeg's HLS demuxer checks
   * every segment URI against a whitelist of extensions and refuses anything
   * else, so an extensionless proxy path makes the whole playlist unreadable
   * (verified: "URL ... is not in allowed_segment_extensions"). Giving playlists
   * .m3u8 and segments .ts satisfies that check without changing the bytes we
   * serve.
   */
  _route(absUrl) {
    for (const [key, val] of this.routes) if (val === absUrl) return this._pathFor(key);
    const key = String(this.nextId++);
    this.routes.set(key, absUrl);
    return this._pathFor(key);
  }

  /** The extension a route should present, based on the upstream URL. */
  _pathFor(key) {
    const upstream = this.routes.get(key) || '';
    return `/m/${key}${looksLikePlaylist(upstream) ? '.m3u8' : '.ts'}`;
  }

  /** Absolute proxy URL for an upstream URL. */
  _toProxy(absUrl) {
    const base = `http://${this.host}:${this.port}`;
    return base + this._route(absUrl);
  }

  async start() {
    this.server = http.createServer((req, res) => this._handle(req, res).catch((e) => this._fail(res, e)));
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, this.host, resolve);
    });
    this.port = this.server.address().port;
    this.masterPath = this._route(this.masterUrl);
    this.log(`hls proxy listening on ${this.host}:${this.port}`);
    return this;
  }

  /** The URL hls.js should be given. */
  get playlistUrl() {
    return `http://${this.host}:${this.port}${this.masterPath}`;
  }

  async _handle(req, res) {
    // The browser page is served from the same loopback host but a different
    // port, so CORS headers are required.
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }
    if (req.method === 'GET' && req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, ...this.stats, routes: this.routes.size }));
    }

    const m = /^\/m\/([A-Za-z0-9]+)/.exec(req.url || '');
    if (!m) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('not found');
    }
    const upstream = this.routes.get(m[1]);
    if (!upstream) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('unknown route');
    }

    const upstreamRes = await fetch(upstream, { headers: mediaHeaders(), redirect: 'follow' });
    if (!upstreamRes.ok) {
      this.stats.errors++;
      res.writeHead(upstreamRes.status, { 'content-type': 'text/plain' });
      return res.end(`upstream ${upstreamRes.status}`);
    }

    const isPlaylist = looksLikePlaylist(upstream);
    if (isPlaylist) {
      this.stats.playlistFetches++;
      const text = await upstreamRes.text();
      const rewritten = rewritePlaylist(text, upstream, (abs) => this._toProxy(abs));
      res.writeHead(200, { 'content-type': PLAYLIST_MIME, 'cache-control': 'no-store' });
      return res.end(rewritten);
    }

    this.stats.segmentFetches++;
    const buf = Buffer.from(await upstreamRes.arrayBuffer());
    // The CDN lies about the content type; the bytes are MPEG-TS either way.
    res.writeHead(200, {
      'content-type': SEGMENT_MIME,
      'content-length': buf.length,
      'cache-control': 'public, max-age=3600',
    });
    return res.end(buf);
  }

  _fail(res, err) {
    this.stats.errors++;
    this.log(`proxy error: ${err.message}`);
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
    try {
      res.end('proxy error');
    } catch {
      /* socket already gone */
    }
  }

  async stop() {
    if (!this.server) return;
    await new Promise((resolve) => this.server.close(resolve));
    this.server = null;
  }
}
