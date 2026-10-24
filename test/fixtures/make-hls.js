// Build a local HLS test stream.
//
// The E2E tests need real video with known properties, and downloading an
// episode every run would be slow and dependent on a third party. So we make
// our own:
//
//   - 12 segments of 4 seconds = 48 seconds total
//   - each segment is a distinct solid colour, so "did the picture change" and
//     "did seek land in the right place" are both answerable from the pixels
//   - a burned-in timestamp so a decoded frame can be matched to a position
//   - a WebVTT file with cues at known times
//
// Output goes into a temp directory that the caller serves over HTTP.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const SEGMENT_SECONDS = 4;
export const SEGMENT_COUNT = 12;
export const TOTAL_SECONDS = SEGMENT_SECONDS * SEGMENT_COUNT;

/** One colour per segment, easily told apart. */
const COLOURS = [
  'red', 'green', 'blue', 'yellow', 'magenta', 'cyan',
  'orange', 'purple', 'lime', 'teal', 'navy', 'maroon',
];

/**
 * Generate the fixture.
 * @param {object} [o]
 * @param {string} [o.dir] output directory, defaults to a fresh temp dir
 * @param {boolean} [o.disguised] rename segments to .jpg/.html/.js like the real CDN
 * @returns {{dir:string, masterUrlPath:string, playlistFile:string, vttFile:string}}
 */
export function makeHlsFixture({ dir, disguised = false } = {}) {
  const out = dir || fs.mkdtempSync(path.join(os.tmpdir(), 'anime-hls-'));
  fs.mkdirSync(out, { recursive: true });

  // Build one continuous source with a changing colour and a running clock.
  // drawtext needs a font; DejaVu ships with the ffmpeg package on Debian.
  const fontCandidates = [
    '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  ];
  const font = fontCandidates.find((f) => fs.existsSync(f));

  const filterParts = [];
  const inputs = [];
  for (let i = 0; i < SEGMENT_COUNT; i++) {
    inputs.push('-f', 'lavfi', '-t', String(SEGMENT_SECONDS), '-i', `color=c=${COLOURS[i]}:s=1280x720:r=30`);
    filterParts.push(`[${i}:v]null[v${i}]`);
  }
  const concatInputs = Array.from({ length: SEGMENT_COUNT }, (_v, i) => `[v${i}]`).join('');
  let filter = filterParts.join(';') + `;${concatInputs}concat=n=${SEGMENT_COUNT}:v=1:a=0[cat]`;
  // Burn a big readable timer into the frame so tests can verify position.
  if (font) {
    filter += `;[cat]drawtext=fontfile=${font}:text='%{pts\\:hms}':fontsize=90:fontcolor=white:x=(w-text_w)/2:y=(h-text_h)/2[vt]`;
  } else {
    filter += ';[cat]null[vt]';
  }
  const segPattern = disguised ? 'seg-%05d.jpg' : 'seg-%05d.ts';
  const args = [
    '-hide_banner', '-loglevel', 'error', '-y',
    ...inputs,
    '-f', 'lavfi', '-t', String(TOTAL_SECONDS), '-i', `sine=frequency=440:sample_rate=48000`,
    '-filter_complex', filter,
    '-map', '[vt]', '-map', `${SEGMENT_COUNT}:a`, '-t', String(TOTAL_SECONDS),
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-g', '30',
    '-c:a', 'aac', '-b:a', '96k',
    '-f', 'hls',
    '-hls_time', String(SEGMENT_SECONDS),
    '-hls_playlist_type', 'vod',
    '-hls_segment_filename', path.join(out, segPattern),
    '-hls_flags', 'independent_segments',
    path.join(out, 'master.m3u8'),
  ];
  try {
    execFileSync('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (err) {
    const detail = err.stderr ? err.stderr.toString().slice(-800) : err.message;
    throw new Error(`ffmpeg failed to build the test fixture:\n${detail}`);
  }

  const vtt = makeVtt();
  const vttFile = path.join(out, 'captions.vtt');
  fs.writeFileSync(vttFile, vtt, 'utf8');

  return { dir: out, playlistFile: path.join(out, 'master.m3u8'), vttFile, masterUrlPath: '/master.m3u8' };
}

/** Captions at known times, so the E2E test can assert the right one shows. */
export function makeVtt() {
  const stamp = (s) => {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = (s % 60).toFixed(3).padStart(6, '0');
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${sec}`;
  };
  const lines = ['WEBVTT', ''];
  for (let i = 0; i < SEGMENT_COUNT; i++) {
    const start = i * SEGMENT_SECONDS;
    lines.push(`${i + 1}`, `${stamp(start)} --> ${stamp(start + SEGMENT_SECONDS - 0.2)}`, `Caption block ${i + 1}`, '');
  }
  return lines.join('\n');
}

/** Remove a fixture directory. */
export function cleanupFixture(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch { /* ignore */ }
}
