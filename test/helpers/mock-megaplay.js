// A local stand-in for megaplay.buzz.
//
// It answers the same three things the real service does, with the same shapes,
// so the resolver and the HLS proxy can be tested without a network and without
// depending on someone else's uptime:
//
//   GET /stream/mal/{malId}/{ep}/{lang}   the player page, carrying data-id
//   GET /stream/getSources?id=...         tracks, intro, outro, enc
//   GET /anime/.../master.m3u8            the video CDN, with disguised segment
//                                         extensions and a JPEG content type
//
// Failures can be switched on per test: missing dub, missing episode, empty
// source list, slow responses.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

/**
 * @param {object} [o]
 * @param {string} o.mediaDir directory holding master.m3u8 and the segments
 * @param {object} [o.behaviour]
 * @param {Set<string>} [o.behaviour.noDubFor] episode keys with no dub
 * @param {Set<string>} [o.behaviour.missingEpisodes] episode keys that 404
 * @param {boolean} [o.behaviour.emptySources] return a source list with no tracks
 * @param {number} [o.behaviour.delayMs] slow every answer down
 * @param {boolean} [o.behaviour.requireReferer] 403 without the Referer header
 */
export async function startMockMegaplay({ mediaDir, behaviour = {} } = {}) {
  const noDubFor = behaviour.noDubFor || new Set();
  const missingEpisodes = behaviour.missingEpisodes || new Set();
  const state = { requests: [], embedHits: 0, sourceHits: 0, segmentHits: 0, playlistHits: 0 };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    state.requests.push(`${req.method} ${url.pathname}${url.search}`);

    if (behaviour.delayMs) await new Promise((r) => setTimeout(r, behaviour.delayMs));

    const send = (code, body, type = 'text/html') => {
      res.writeHead(code, { 'content-type': type });
      res.end(body);
    };

    // Player page, addressed by MAL id.
    const mal = /^\/stream\/mal\/(\d+)\/([\d.]+)\/(sub|dub)$/.exec(url.pathname);
    if (mal) {
      const [, malId, episode, lang] = mal;
      const key = `${malId}:${episode}`;
      // The real service answers HTTP 200 with an error page in the body, so
      // the mock does the same. Matching it exactly is what makes the test
      // worth anything.
      if (missingEpisodes.has(key)) {
        state.embedHits++;
        return send(200, errorPage(404, "The page you're looking for doesn't exist or has been moved."));
      }
      if (lang === 'dub' && noDubFor.has(key)) {
        // The real service serves the sub player and writes type: 'sub' into
        // window.settings, which is how the client detects a missing dub.
        state.embedHits++;
        return send(200, embedPage({ id: 900001, realId: 800001, mediaId: 7001, type: 'sub' }));
      }
      state.embedHits++;
      return send(200, embedPage({ id: 100000 + Number(episode), realId: 200000, mediaId: 7001, type: lang }));
    }

    // Player page, addressed by catalogue episode id.
    const cat = /^\/stream\/s-2\/(\d+)\/(sub|dub)$/.exec(url.pathname);
    if (cat) {
      state.embedHits++;
      return send(200, embedPage({ id: Number(cat[1]), realId: 200000, mediaId: 7001, type: cat[2] }));
    }

    // Sources.
    if (url.pathname === '/stream/getSources') {
      state.sourceHits++;
      if (behaviour.emptySources) return send(200, JSON.stringify({ tracks: [], intro: {}, outro: {} }), 'application/json');
      const host = `http://127.0.0.1:${server.address().port}`;
      return send(
        200,
        JSON.stringify({
          tracks: [
            { file: `${host}/anime/aaa/bbb/subtitles/track_0_eng.vtt`, label: 'English', kind: 'captions', default: true },
            { file: `${host}/anime/aaa/bbb/preview/thumbnails.vtt`, kind: 'thumbnails' },
          ],
          t: 1,
          intro: { start: 31, end: 111 },
          outro: { start: 1215, end: 1307 },
          server: 4,
          image: `${host}/anime/aaa/bbb/preview/thumbnail.jpg`,
          enc: 'not-a-real-token',
        }),
        'application/json',
      );
    }

    // The fake video CDN.
    if (url.pathname.startsWith('/anime/')) {
      if (behaviour.requireReferer && req.headers.referer !== 'https://megaplay.buzz/') {
        return send(403, 'blocked: missing referer', 'text/plain');
      }
      const file = path.join(mediaDir, path.basename(url.pathname));
      if (!fs.existsSync(file)) return send(404, 'no such file', 'text/plain');
      if (url.pathname.endsWith('.m3u8')) {
        state.playlistHits++;
        return send(200, rewriteToMock(fs.readFileSync(file, 'utf8'), server.address().port), 'application/vnd.apple.mpegurl');
      }
      state.segmentHits++;
      // The real CDN lies about the content type, so this one does too.
      return send(200, fs.readFileSync(file), 'image/jpeg');
    }

    return send(404, errorPage(404, 'not found'));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    state,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** Point the fixture's segment lines at this mock's own CDN path. */
function rewriteToMock(playlist, port) {
  return playlist
    .split('\n')
    .map((line) => (line.trim() && !line.startsWith('#') ? `http://127.0.0.1:${port}/anime/${line.trim()}` : line))
    .join('\n');
}

function embedPage({ id, realId, mediaId, type }) {
  return `<!DOCTYPE html><html><head><title>File ${id} - MegaPlay</title>
<script>window.settings = { time: 0, autoPlay: "1", type: '${type}', cid: '4e4f', cidu: '6ad881fa3257f' };</script>
</head><body><div class="mg-3mb3d"><div class="mg3-player">
<div class="fix-area" id="megaplay-player" data-id="${id}" data-realid="${realId}" data-mediaid="${mediaId}" data-fileversion="0">
</div></div></div></body></html>`;
}

function errorPage(code, text) {
  return `<!DOCTYPE html><html><head><title>Error - MegaPlay</title></head><body>
<div class="error-container"><div class="error-content">
<h1>Oops! Something went wrong</h1><p>${text}</p>
<div class="error-code">Error Code: <span>${code}</span></div>
</div></div></body></html>`;
}
