// Shared test harness.
//
// The E2E tests all need the same scaffolding: a local HLS server, the proxy,
// the static server, a virtual display, a null sink and a browser. Rather than
// repeat it, this file starts and stops the lot and hands the pieces back.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { makeHlsFixture, cleanupFixture, SEGMENT_SECONDS, TOTAL_SECONDS } from '../fixtures/make-hls.js';
import { HlsProxy } from '../../player/src/hls-proxy.js';
import { StaticServer } from '../../player/src/static-server.js';
import { VirtualDisplay, NullSinkAudio, checkSystemTools } from '../../player/src/display.js';
import { BrowserPlayer } from '../../player/src/browser-player.js';

export { makeHlsFixture, cleanupFixture, SEGMENT_SECONDS, TOTAL_SECONDS };

/** Serve a directory of files over HTTP on a random loopback port. */
export async function serveDir(dir, { contentTypeFor } = {}) {
  const server = http.createServer((req, res) => {
    const p = (req.url || '/').split('?')[0];
    const file = path.join(dir, p);
    if (!file.startsWith(dir) || !fs.existsSync(file)) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('not found');
    }
    const type = contentTypeFor?.(file) || guessType(file);
    res.writeHead(200, { 'content-type': type });
    res.end(fs.readFileSync(file));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    server,
    base: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function guessType(file) {
  if (file.endsWith('.m3u8')) return 'application/vnd.apple.mpegurl';
  if (file.endsWith('.vtt')) return 'text/vtt';
  if (file.endsWith('.ts')) return 'video/mp2t';
  // The real CDN serves segments as image/jpeg - tests can opt into that.
  return 'application/octet-stream';
}

/** Everything the browser path needs, started and wired together. */
export async function startBrowserStack({ disguised = false, captions = true, log = () => {} } = {}) {
  const tools = checkSystemTools();
  const fixture = makeHlsFixture({ disguised });
  const staticDir = await serveDir(fixture.dir, {
    // Mirror the real CDN: segments are served under a lying content type.
    contentTypeFor: (f) => (f.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : f.endsWith('.vtt') ? 'text/vtt' : 'image/jpeg'),
  });

  const proxy = new HlsProxy({ masterUrl: `${staticDir.base}/master.m3u8`, log });
  await proxy.start();
  const staticServer = new StaticServer({ log });
  await staticServer.start();

  const display = new VirtualDisplay({ log });
  await display.start();
  const audio = new NullSinkAudio({ log });
  await audio.start();

  const player = new BrowserPlayer({ staticServer, display, audio, log });
  await player.launch();
  await player.load({
    playlistUrl: proxy.playlistUrl,
    captionUrl: captions ? `${staticDir.base}/captions.vtt` : undefined,
    captions,
  });

  const teardown = async () => {
    await player.stop().catch(() => {});
    await proxy.stop().catch(() => {});
    await staticServer.stop().catch(() => {});
    audio.stop();
    display.stop();
    await staticDir.close().catch(() => {});
    cleanupFixture(fixture.dir);
  };

  return { tools, fixture, staticDir, proxy, staticServer, display, audio, player, teardown };
}

/** Grab one frame from a media file as a PNG buffer. */
export function frameAt(file, seconds) {
  return execFileSync(
    'ffmpeg',
    ['-hide_banner', '-loglevel', 'error', '-ss', String(seconds), '-i', file, '-frames:v', '1', '-f', 'image2', '-vcodec', 'png', 'pipe:1'],
    { maxBuffer: 64 * 1024 * 1024 },
  );
}

/**
 * Average RGB of an image, via ffmpeg's signalstats.
 * Useful for asserting "the picture is a different colour now".
 */
export function meanColour(imageBuffer) {
  const out = execFileSync(
    'ffprobe',
    ['-hide_banner', '-v', 'error', '-f', 'image2pipe', '-i', 'pipe:0', '-f', 'lavfi', '-i', 'null', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', 'pipe:0'],
    { input: imageBuffer },
  ).toString();
  return out.trim();
}

/**
 * Record the browser output with FFmpeg for a number of seconds.
 * Returns the path to the recorded file.
 */
export async function recordCapture({ display, audio, seconds, size = { width: 1920, height: 1080 }, fps = 30, out, log = () => {} }) {
  const file = out || `/tmp/anime-capture-${Date.now()}.nut`;
  const proc = spawn(
    'ffmpeg',
    [
      '-hide_banner', '-loglevel', 'warning', '-y',
      '-f', 'x11grab', '-draw_mouse', '0', '-framerate', String(fps),
      '-video_size', `${size.width}x${size.height}`, '-i', display.envDisplay,
      ...(audio?.started
        ? ['-f', 'pulse', '-thread_queue_size', '1024', '-i', audio.monitorSource, '-map', '0:v:0', '-map', '1:a:0']
        : ['-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000', '-map', '0:v:0', '-map', '1:a:0']),
      '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-pix_fmt', 'yuv420p',
      '-r', String(fps), '-c:a', 'libopus', '-b:a', '128k', '-ar', '48000', '-ac', '2',
      '-t', String(seconds), file,
    ],
    { env: audio?.env ?? process.env, stdio: ['ignore', 'ignore', 'pipe'] },
  );
  let stderr = '';
  proc.stderr.on('data', (d) => { stderr += d.toString(); });
  const code = await new Promise((resolve) => proc.on('exit', resolve));
  if (code !== 0) log(`capture ffmpeg exited ${code}: ${stderr.slice(-300)}`);
  return { file, stderr, code };
}

/** ffprobe a media file and return parsed JSON. */
export function probe(file) {
  const out = execFileSync('ffprobe', ['-hide_banner', '-v', 'error', '-show_format', '-show_streams', '-of', 'json', file]).toString();
  return JSON.parse(out);
}

/** Consume a readable for N seconds and report how many bytes arrived. */
export function measureStream(stream, seconds) {
  return new Promise((resolve) => {
    let bytes = 0;
    let chunks = 0;
    const onData = (d) => {
      bytes += d.length;
      chunks++;
    };
    stream.on('data', onData);
    setTimeout(() => {
      stream.off('data', onData);
      resolve({ bytes, chunks });
    }, seconds * 1000);
  });
}
