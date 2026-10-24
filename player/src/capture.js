// Screen and audio capture.
//
// FFmpeg reads the virtual display with x11grab and the PulseAudio null sink
// with the pulse input, then transcodes to H.264 and Opus. The grab size and
// frame rate are the window size and the source frame rate.
//
// The output format is NUT written to stdout. That matters because
// @dank074/discord-video-stream's playStream() takes a Node Readable and demuxes
// it in process, so we never touch disk and we never need the special FFmpeg
// build with libzmq that its prepareStream() helper wants.

import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { track } from './process-guard.js';

export class ScreenCapture extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} o.display X display to grab, e.g. ":99"
   * @param {string} [o.pulseSource] pulse monitor source; omit for video only
   * @param {{width:number,height:number}} [o.size]
   * @param {number} [o.fps]
   * @param {object} [o.env]
   * @param {(m:string)=>void} [o.log]
   */
  constructor({ display, pulseSource, size = { width: 1920, height: 1080 }, fps = 24, env, log = () => {} } = {}) {
    super();
    this.display = display;
    this.pulseSource = pulseSource || null;
    this.size = size;
    this.fps = fps;
    this.env = env || process.env;
    this.log = log;
    this.proc = null;
    this.framesDecoded = 0;
    this.lastFrameAt = Date.now();
    this.started = false;
    /** Set by stop() so the exit handler can tell a crash from a shutdown. */
    this.stopping = false;
  }

  /** Build the FFmpeg argument list. Exported on the instance so tests can check it. */
  buildArgs() {
    const { width, height } = this.size;
    const args = [
      '-hide_banner',
      '-loglevel', 'warning',
      '-stats',
      // Video in: the virtual display.
      //
      // -thread_queue_size gives x11grab somewhere to put frames while the
      // encoder is busy; without it a slow frame is dropped and the audio
      // slips against the video.
      // -use_wallclock_as_timestamps stops x11grab's own timestamps from
      // drifting, which is the other half of the same desync.
      '-f', 'x11grab',
      '-thread_queue_size', '512',
      '-use_wallclock_as_timestamps', '1',
      '-draw_mouse', '0', // the cursor is hidden anyway; be explicit
      '-framerate', String(this.fps),
      '-video_size', `${width}x${height}`,
      '-i', this.display,
    ];

    if (this.pulseSource) {
      // Audio in: whatever is played into the null sink.
      // -thread_queue_size avoids dropped packets when video stalls.
      args.push(
        '-f', 'pulse',
        '-thread_queue_size', '1024',
        '-use_wallclock_as_timestamps', '1',
        '-i', this.pulseSource,
      );
      args.push('-af', 'aresample=48000:async=1:first_pts=0:min_hard_comp=0.100');
    } else {
      // No audio device: emit silence so the stream still has an audio track.
      // Discord is much happier with a present-but-silent track than with none.
      args.push('-f', 'lavfi', '-i', `anullsrc=channel_layout=stereo:sample_rate=48000`);
    }

    args.push(
      // Video out: H.264. ultrafast + zerolatency keeps the CPU cost down on a
      // small VPS and stops the encoder from buffering frames ahead.
      '-map', '0:v:0',
      '-map', '1:a:0',
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-tune', 'zerolatency',
      '-pix_fmt', 'yuv420p',
      '-profile:v', 'high',
      '-level', '4.2',
      '-g', String(Math.max(1, Math.round(this.fps * 2))),
      '-r', String(this.fps),
      '-s', `${width}x${height}`,
      '-b:v', '6000k',
      '-maxrate', '8000k',
      '-bufsize', '8000k',
      '-c:a', 'libopus',
      '-b:a', '192k',
      '-ar', '48000',
      '-ac', '2',
      // Keep audio and video on the same clock.
      '-vsync', 'cfr',
      '-fflags', '+genpts',
      // NUT on stdout: a container that carries H.264 + Opus and streams well.
      '-f', 'nut',
      '-',
    );
    return args;
  }

  /**
   * Start capture. Returns immediately; the media flows out of `stdout`.
   * @returns {import('node:stream').Readable}
   */
  start() {
    if (this.proc) throw new Error('capture already running');
    const args = this.buildArgs();
    this.log(`ffmpeg ${args.slice(0, 8).join(' ')} ...`);
    // Registering it means the exit guard can still find this child after a
    // hard crash, when no stop() call will ever run.
    this.proc = track(spawn('ffmpeg', args, { env: this.env, stdio: ['ignore', 'pipe', 'pipe'] }));

    let stderrTail = '';
    this.proc.stderr?.on('data', (d) => {
      const s = d.toString();
      stderrTail = (stderrTail + s).slice(-4000);
      // FFmpeg's -stats line tells us how many frames it has written.
      const m = /frame=\s*(\d+)/.exec(s);
      if (m) {
        this.framesDecoded = Number(m[1]);
        this.lastFrameAt = Date.now();
      }
    });

    this.proc.on('exit', (code, signal) => {
      this.log(`ffmpeg exited code=${code} signal=${signal}`);
      if (code !== 0 && code !== null && !this.stopping) {
        const lines = stderrTail.split('\n').map((l) => l.trim()).filter((l) => l && !/^frame=/.test(l));
        const reason = lines.find((l) => /error|invalid|failed/i.test(l)) || lines[lines.length - 1] || '';
        if (reason) this.log(`ffmpeg failed: ${reason}`);
      }
      this.emit('exit', { code, signal, stderrTail });
    });
    this.proc.on('error', (e) => {
      this.log(`ffmpeg failed to start: ${e.message}`);
      this.emit('error', e);
    });

    this.started = true;
    this.lastFrameAt = Date.now();
    return this.proc.stdout;
  }

  /** Seconds since FFmpeg last reported writing a frame. */
  get secondsSinceFrame() {
    return (Date.now() - this.lastFrameAt) / 1000;
  }

  /**
   * Stop the capture and wait for FFmpeg to be gone.
   *
   * Waiting matters: a capture left running outlives the test or the shutdown
   * that started it, and a box that leaks one FFmpeg per playback runs out of
   * memory. x11grab does not always die on the first SIGTERM, so escalate.
   */
  async stop() {
    if (!this.proc) return;
    this.stopping = true;
    const p = this.proc;
    this.proc = null;
    const exited = new Promise((resolve) => p.once('exit', resolve));
    const alive = exited.then(() => false).catch(() => false);

    // 'q' on stdin is the graceful way to end FFmpeg, but stdin is ignored
    // here, so signal it directly.
    try { p.kill('SIGTERM'); } catch { /* already gone */ }

    const settled = await Promise.race([
      alive,
      new Promise((resolve) => setTimeout(() => resolve(true), 2000)),
    ]);
    if (settled) {
      // Still there. Take it down for good rather than leaking it.
      try { p.kill('SIGKILL'); } catch { /* already gone */ }
      await Promise.race([alive, new Promise((resolve) => setTimeout(resolve, 1500))]);
    }
  }
}

/**
 * Watchdog.
 *
 * Detects the two failure modes that matter for a live stream:
 *   - a frozen picture: the video clock stops advancing
 *   - a stalled capture: FFmpeg stops writing frames
 *
 * It only reports; the pipeline decides what to do, so the recovery policy
 * stays in one place.
 */
export class Watchdog extends EventEmitter {
  /**
   * @param {object} o
   * @param {() => Promise<{currentTime:number, paused:boolean, phase:string}|null>} o.readClock
   * @param {() => number} o.captureFrameAge seconds since capture wrote a frame
   * @param {number} [o.intervalMs]
   * @param {number} [o.clockStallMs] how long the video clock may sit still
   * @param {number} [o.frameStallMs] how long capture may go quiet
   * @param {(m:string)=>void} [o.log]
   */
  constructor({ readClock, captureFrameAge, intervalMs = 2000, clockStallMs = 12000, frameStallMs = 15000, log = () => {} } = {}) {
    super();
    this.readClock = readClock;
    this.captureFrameAge = captureFrameAge;
    this.intervalMs = intervalMs;
    this.clockStallMs = clockStallMs;
    this.frameStallMs = frameStallMs;
    this.log = log;
    this.timer = null;
    this.lastClock = null;
    this.lastAdvanceAt = Date.now();
    this.enabled = true;
  }

  start() {
    if (this.timer) return this;
    this.lastAdvanceAt = Date.now();
    this.timer = setInterval(() => this.tick().catch((e) => this.log(`watchdog error: ${e.message}`)), this.intervalMs);
    this.timer.unref?.();
    return this;
  }

  /** Reset after a deliberate seek or pause, so we do not raise a false alarm. */
  nudge() {
    this.lastAdvanceAt = Date.now();
    this.lastClock = null;
  }

  async tick() {
    if (!this.enabled) return;
    const st = await this.readClock().catch(() => null);

    if (st && !st.paused && st.phase !== 'ended') {
      if (this.lastClock === null || st.currentTime > this.lastClock + 0.05) {
        this.lastAdvanceAt = Date.now();
      } else if (Date.now() - this.lastAdvanceAt > this.clockStallMs) {
        this.emit('frozen', { currentTime: st.currentTime, phase: st.phase });
        this.lastAdvanceAt = Date.now(); // report once, not every tick
      }
      this.lastClock = st.currentTime;
    } else {
      // Paused or ended: the clock is meant to stand still.
      this.lastAdvanceAt = Date.now();
      this.lastClock = st?.currentTime ?? null;
    }

    const age = this.captureFrameAge();
    if (age > this.frameStallMs) {
      this.emit('stalled', { secondsSinceFrame: age });
    }
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
