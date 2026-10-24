// The playback engine.
//
// One object owns a single episode from start to finish:
//
//   resolve -> proxy -> backend (browser or ffmpeg) -> NUT stream out
//
// It also owns the recovery logic: restart Chromium after a crash and resume
// from the last known timestamp, retry resolution with backoff, and watch for
// frozen frames.
//
// The streamer process uses exactly one engine at a time, which is what
// enforces "one active stream per guild".

import { EventEmitter } from 'node:events';
import { resolveEpisodeWithFallbacks } from '@anime-stream/shared/megaplay.js';
import { STATE } from '@anime-stream/shared/ipc-protocol.js';
import { sleep } from '@anime-stream/shared/retry.js';
import { HlsProxy } from './hls-proxy.js';
import { StaticServer } from './static-server.js';
import { VirtualDisplay, NullSinkAudio, checkSystemTools } from './display.js';
import { BrowserPlayer } from './browser-player.js';
import { ScreenCapture, Watchdog } from './capture.js';
import { findOrphans, ORPHAN_MARKERS } from './process-guard.js';
import { playbackFinished } from './end-detect.js';

/** How often the engine reports its position, in ms. */
const POSITION_INTERVAL_MS = 1000;

export function recapSeek(source, position) {
  const start = Number(source?.intro?.start);
  if (!Number.isFinite(start) || start < 8) return { ok: false, error: 'This episode has no recap timestamp.' };
  if (Number(position) >= start - 1) return { ok: false, error: 'The recap already passed.' };
  return { ok: true, to: start };
}

async function readSourceFps(player) {
  const deadline = Date.now() + 1200;
  while (Date.now() < deadline) {
    const st = await player.status().catch(() => null);
    const fps = Number(st?.fps);
    if (fps >= 12 && fps <= 60) return Math.round(fps);
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return 0;
}

export class PlaybackEngine extends EventEmitter {
  /**
   * @param {object} [o]
   * @param {'auto'|'browser'|'ffmpeg'} [o.backend] which capture path to prefer
   * @param {{width:number,height:number}} [o.size]
   * @param {number} [o.fps]
   * @param {string[]} [o.mirrors] alternate megaplay hosts to try
   * @param {(req:object)=>Promise<{source:object,fallbacks:string[]}>} [o.resolve]
   *        source resolver. Tests inject a local one so they never touch the
   *        network; production uses the real megaplay client.
   * @param {(m:string)=>void} [o.log]
   */
  constructor({ size = { width: 1920, height: 1080 }, fps = 24, mirrors = [], resolve, log = () => {} } = {}) {
    super();
    this.backendPreference = 'browser';
    this.size = size;
    this.fps = fps;
    this.mirrors = mirrors;
    this.resolve = resolve || ((req) => resolveEpisodeWithFallbacks({
      malId: req.malId,
      episode: req.episode,
      lang: req.audio,
      mirrors: this.mirrors,
      log: this.log,
    }));
    this.log = log;

    /** @type {object|null} resolved source for the current episode */
    this.source = null;
    /** @type {object|null} the request that started this episode */
    this.request = null;

    this.state = STATE.IDLE;
    this.error = null;
    this.position = 0;
    this.duration = 0;
    this.backendInUse = null;
    this.restarts = 0;
    this.streamLoop = 0;
    this._endedEmitted = false;
    this.endedNaturally = false;
    this._stopPromise = null;
    this._stableDuration = 0;
    this._durationStableSince = 0;
    this._endEdgePos = null;
    this._endEdgeSince = 0;
    this._sawEndList = false;

    this.proxy = null;
    this.staticServer = null;
    this.display = null;
    this.audio = null;
    this.browserPlayer = null;
    this.capture = null;
    this.watchdog = null;
    this.volume = 1;
    this.positionTimer = null;
    this.stopping = false;
    this.stream = null;
  }

  /** True when something is loaded and not stopped. */
  get active() {
    return this.state !== STATE.IDLE;
  }

  /** Snapshot used by the panel and by /status. */
  status() {
    return {
      state: this.state,
      error: this.error,
      position: Math.max(0, Math.floor(this.position)),
      duration: Math.max(0, Math.floor(this.duration)),
      backend: this.backendInUse,
      restarts: this.restarts,
      ended: this.endedNaturally === true,
      source: this.source
        ? {
            malId: this.source.malId,
            episode: this.source.episode,
            lang: this.source.lang,
            intro: this.source.intro,
            outro: this.source.outro,
            captionCount: this.source.captions.length,
            masterUrl: this.source.masterUrl,
          }
        : null,
      request: this.request
        ? {
            malId: this.request.malId,
            episode: this.request.episode,
            audio: this.request.audio,
            captions: this.request.captions,
            guildId: this.request.guildId,
            channelId: this.request.channelId,
            requesterId: this.request.requesterId,
          }
        : null,
    };
  }

  _setState(state, error = null) {
    this.state = state;
    this.error = error;
    this.emit('state', this.status());
  }

  /**
   * Load an episode and start producing media.
   * Resolves with the readable NUT stream; the caller pipes it to Discord.
   *
   * @param {object} req a validated play request (see validatePlayRequest)
   * @param {object} [opts]
   * @param {number} [opts.startAt] seconds in to begin from, used when resuming
   *        an episode someone already started
   * @returns {Promise<import('node:stream').Readable>}
   */
  async play(req, { startAt = 0, streamLoop = 0 } = {}) {
    if (this.active) throw new Error('An episode is already loaded. Stop it first.');
    this.stopping = false;
    this._endedEmitted = false;
    this.endedNaturally = false;
    this._stableDuration = 0;
    this._durationStableSince = 0;
    this._endEdgePos = null;
    this._endEdgeSince = 0;
    this._sawEndList = false;
    this.request = req;
    this._setState(STATE.LOADING);

    try {
      const { source, fallbacks = [] } = await this.resolve(req);
      for (const note of fallbacks) this.log(`fallback: ${note}`);
      this.source = source;
      this.emit('resolved', source);

      // Which language we actually got may differ from what was asked for.
      if (source.lang !== req.audio) {
        this.request = { ...req, audio: source.lang, captions: req.captions };
      }

      // Clamp the resume point so a stale record cannot start us past the end.
      this.position = Math.max(0, Number(startAt) || 0);
      const stream = await this._startBackend({ startAt: this.position, streamLoop });
      this.stream = stream;
      this._setState(STATE.PLAYING);
      this._startPositionLoop();
      return stream;
    } catch (err) {
      this._setState(STATE.ERROR, err.message);
      await this.stop();
      throw err;
    }
  }

  async _startBackend({ startAt, streamLoop = 0 }) {
    if (!this.proxy) {
      this.proxy = new HlsProxy({ masterUrl: this.source.masterUrl, log: this.log });
      await this.proxy.start();
    }
    this.streamLoop = streamLoop;
    return this._startBrowser({ startAt, loop: !!streamLoop });
  }

  async _startBrowser({ startAt, loop = false }) {
    if (!this.staticServer) {
      this.staticServer = new StaticServer({ log: this.log });
      await this.staticServer.start();
    }
    if (!this.display) {
      this.display = new VirtualDisplay({ width: this.size.width, height: this.size.height, log: this.log });
      await this.display.start();
    }
    if (!this.audio) {
      this.audio = new NullSinkAudio({ log: this.log });
      await this.audio.start();
    }

    this.browserPlayer = new BrowserPlayer({
      staticServer: this.staticServer,
      display: this.display,
      audio: this.audio,
      viewport: this.size,
      log: this.log,
    });
    this.browserPlayer.on('crash', () => this._onCrash());
    await this.browserPlayer.launch();

    const captionUrl = pickCaption(this.source, this.request?.captions);
    await this.browserPlayer.load({
      playlistUrl: this.proxy.playlistUrl,
      startAt,
      captionUrl,
      captions: !!this.request?.captions,
      loop,
      volume: this.volume,
    });

    const measured = await readSourceFps(this.browserPlayer);
    if (measured) this.fps = measured;
    this.log(`capture ${this.size.width}x${this.size.height} at ${this.fps} fps`);

    this.capture = new ScreenCapture({
      display: this.display.envDisplay,
      pulseSource: this.audio?.started ? this.audio.monitorSource : null,
      size: this.size,
      fps: this.fps,
      env: this.audio?.env ?? process.env,
      log: this.log,
    });
    const out = this.capture.start();
    this._wireCapture(this.capture);
    this.backendInUse = 'browser';
    this._startWatchdog();
    return out;
  }

  _wireCapture(capturer) {
    capturer.on('exit', ({ code, stderrTail }) => {
      // A capturer we stopped on purpose (seek on the ffmpeg path, shutdown, or
      // a backend switch) is not a failure.
      if (this.stopping || capturer.stopping) return;
      this.log(`capture ended unexpectedly (code ${code})`);
      this._setState(STATE.ERROR, `capture ended (code ${code}) ${String(stderrTail || '').slice(-160)}`);
      this.emit('capture-exit', { code });
    });
  }

  _startWatchdog() {
    this.watchdog?.stop();
    this.watchdog = new Watchdog({
      readClock: async () => {
        if (this.backendInUse === 'browser' && this.browserPlayer) return this.browserPlayer.status();
        // ffmpeg backend: the video clock is our own estimate.
        return { currentTime: this.position, paused: this.state === STATE.PAUSED, phase: this.state };
      },
      captureFrameAge: () => (this.capture ? this.capture.secondsSinceFrame : 0),
      log: this.log,
    });
    this.watchdog.on('frozen', (info) => {
      if (this._endedEmitted || this.stopping) return;
      const atEnd = playbackFinished({
        ended: false,
        phase: info.phase,
        currentTime: info.currentTime,
        duration: this.duration,
        endList: this._sawEndList,
      }, {
        userPaused: this.state === STATE.PAUSED,
        stalledMs: 12000,
        durationStableMs: this._durationStableSince ? Date.now() - this._durationStableSince : 0,
      });
      if (atEnd) {
        this.log('frozen at the end of the episode, ending the stream');
        this._onEpisodeEnd();
        return;
      }
      this.log(`watchdog: frozen picture at ${info.currentTime.toFixed(1)}s`);
      this.emit('frozen', info);
      this._recover().catch((e) => this.log(`recovery failed: ${e.message}`));
    });
    this.watchdog.on('stalled', (info) => {
      this.log(`watchdog: capture stalled for ${info.secondsSinceFrame.toFixed(1)}s`);
      this.emit('stalled', info);
    });
    this.watchdog.start();
  }

  /**
   * The episode ran out.
   *
   * Tearing down here is what lets the controller move on. It watches for the
   * transition into idle, so if playback just sat there at the end the panel
   * would freeze on the last frame and autoplay would never happen.
   */
  _onEpisodeEnd() {
    if (this._endedEmitted) return;
    this._endedEmitted = true;
    this.endedNaturally = true;
    this.stopping = true;
    this.emit('ended', { position: this.position, duration: this.duration });
    this.stop().catch((err) => this.log(`teardown after the episode ended failed: ${err.message}`));
  }

  _noteClock(st) {
    const now = Date.now();
    const dur = Number(st.duration) || 0;
    const pos = Number(st.currentTime) || 0;
    if (!(dur > 0) || Math.abs(dur - (this._stableDuration || 0)) > 0.75) {
      this._stableDuration = dur;
      this._durationStableSince = now;
    }
    const near = dur > 5 && pos >= dur - 1.5;
    if (!near || pos > (this._endEdgePos ?? -1) + 0.05) {
      this._endEdgePos = pos;
      this._endEdgeSince = now;
    }
    return {
      stalledMs: near ? now - this._endEdgeSince : 0,
      durationStableMs: this._durationStableSince ? now - this._durationStableSince : 0,
    };
  }

  /** Poll the backend for its position so the panel can show progress. */
  _startPositionLoop() {
    if (this.positionTimer) clearInterval(this.positionTimer);
    this.positionTimer = setInterval(async () => {
      try {
        if (this.backendInUse === 'browser' && this.browserPlayer && !this._endedEmitted) {
          const st = await this.browserPlayer.status();
          if (st) {
            this.position = st.currentTime;
            if (st.duration > 0) this.duration = st.duration;
            if (st.endList) this._sawEndList = true;
            const clock = this._noteClock(st);
            if (!this.streamLoop && playbackFinished(st, {
              userPaused: this.state === STATE.PAUSED,
              stalledMs: clock.stalledMs,
              durationStableMs: clock.durationStableMs,
            })) {
              this._onEpisodeEnd();
            }
          }
        }
        this.emit('position', this.status());
      } catch {
        /* page is busy or gone; next tick will try again */
      }
    }, POSITION_INTERVAL_MS);
    this.positionTimer.unref?.();
  }

  /** Chromium died. Restart it and resume from where we were. */
  async _onCrash() {
    if (this.stopping || this._endedEmitted) return;
    const resumeAt = Math.max(0, this.position - 1);
    this.restarts++;
    this.log(`chromium crashed, restarting and resuming at ${resumeAt.toFixed(1)}s (restart #${this.restarts})`);
    this._setState(STATE.LOADING);
    try {
      await this._teardownBrowser();
      this.stream = await this._startBackend({ startAt: resumeAt, streamLoop: this.streamLoop });
      this.position = resumeAt;
      this._setState(STATE.PLAYING);
      this.emit('restarted', { at: resumeAt, restarts: this.restarts, stream: this.stream });
    } catch (err) {
      this._setState(STATE.ERROR, `restart failed: ${err.message}`);
    }
  }

  /** Generic recovery used by the watchdog. */
  async _recover() {
    if (this.stopping || this._endedEmitted || this.state === STATE.LOADING) return;
    const resumeAt = Math.max(0, this.position - 2);
    this.restarts++;
    this._setState(STATE.LOADING);
    try {
      await this._teardownBrowser();
      this.stream = await this._startBackend({ startAt: resumeAt, streamLoop: this.streamLoop });
      this.position = resumeAt;
      this._setState(STATE.PLAYING);
      this.emit('restarted', { at: resumeAt, restarts: this.restarts, stream: this.stream });
    } catch (err) {
      this._setState(STATE.ERROR, `recovery failed: ${err.message}`);
    }
  }

  async pause() {
    if (this.state !== STATE.PLAYING) return false;
    if (this.backendInUse === 'browser') await this.browserPlayer?.pause();
    this._setState(STATE.PAUSED);
    this.watchdog?.nudge();
    return true;
  }

  async resume() {
    if (this.state !== STATE.PAUSED) return false;
    if (this.backendInUse === 'browser') await this.browserPlayer?.resume();
    this._setState(STATE.PLAYING);
    this.watchdog?.nudge();
    return true;
  }

  /**
   * Seek to an absolute position.
   * The browser path moves the video element. The ffmpeg path cannot move
   * backwards in place, so it restarts the encoder with -ss.
   */
  async seek(seconds) {
    if (!this.active) throw new Error('Nothing is playing.');
    const target = Math.max(0, Number(seconds) || 0);
    if (this.duration > 0 && target >= this.duration) {
      throw new Error('Cannot seek past the end of the episode.');
    }
    const actual = await this.browserPlayer.seek(target);
    this.position = actual ?? target;
    this.watchdog?.nudge();
    this.emit('position', this.status());
    return this.position;
  }

  async setVolume(level) {
    const n = Number(level);
    if (!Number.isFinite(n) || n < 0 || n > 5) throw new Error('Volume must be between 0 and 5.');
    this.volume = n;
    if (this.browserPlayer) await this.browserPlayer.setVolume(n);
    return n;
  }

  async setCaptions(on) {
    if (this.request) this.request = { ...this.request, captions: !!on };
    if (this.browserPlayer) await this.browserPlayer.setCaptions(!!on);
    return !!on;
  }

  async skipIntro() {
    if (!this.active) throw new Error('Nothing is playing.');
    const intro = this.source?.intro;
    if (!intro || !(intro.end > intro.start)) throw new Error('This episode has no intro timestamp.');
    const to = await this.seek(intro.end);
    return { to, reason: 'skipped the intro' };
  }

  async skipRecap() {
    if (!this.active) throw new Error('Nothing is playing.');
    const plan = recapSeek(this.source, this.position);
    if (!plan.ok) throw new Error(plan.error);
    const to = await this.seek(plan.to);
    return { to, reason: 'skipped the recap' };
  }

  async skipOutro() {
    if (!this.active) throw new Error('Nothing is playing.');
    const outro = this.source?.outro;
    if (!outro || !(outro.end > outro.start)) throw new Error('This episode has no outro timestamp.');
    if (this.position < outro.start - 1) throw new Error(`The outro starts at ${Math.floor(outro.start)}s.`);
    const to = await this.seek(Math.min(outro.end, this.duration > 0 ? this.duration - 0.5 : outro.end));
    return { to, reason: 'skipped the outro' };
  }

  /**
   * Skip the current intro, outro or recap.
   *
   * The API only gives us intro and outro ranges, so recap is handled the same
   * way as intro: a marked range at the start of the episode.
   *
   * Rule: if we are inside a marked range, jump to its end. If we are not, jump
   * to the end of the episode's outro start so the viewer stops watching
   * credits. When neither marker exists we fall back to a plain 85 second jump,
   * which is the typical anime opening length.
   *
   * @returns {Promise<{to:number, reason:string}>}
   */
  async skip() {
    if (!this.active) throw new Error('Nothing is playing.');
    const pos = this.position;
    const { intro, outro } = this.source || {};
    let to = null;
    let reason = null;

    if (intro && pos >= intro.start - 1 && pos < intro.end) {
      to = intro.end;
      reason = 'skipped the opening';
    } else if (outro && pos >= outro.start - 1 && pos < outro.end) {
      to = outro.end;
      reason = 'skipped the ending';
    } else if (intro && pos < intro.start) {
      to = intro.end;
      reason = 'skipped the opening';
    } else if (outro) {
      to = outro.start;
      reason = 'skipped to the ending';
    } else {
      to = Math.min(pos + 85, Math.max(0, this.duration - 1) || pos + 85);
      reason = 'no timestamps available, jumped ahead 85 seconds';
    }
    if (this.duration > 0) to = Math.min(to, this.duration - 0.5);

    const actual = await this.seek(to);
    return { to: actual, reason };
  }

  /** Tear down only the browser side, keeping the proxy and display alive. */
  async _teardownBrowser() {
    // Awaited: an unwaited stop() leaves FFmpeg running, and on a short-lived
    // process the deferred kill never happens.
    await this.capture?.stop();
    this.capture = null;
    await this.browserPlayer?.stop();
    this.browserPlayer = null;
  }

  /** Stop everything and leave no process behind. */
  async stop() {
    if (this._stopPromise) return this._stopPromise;
    this._stopPromise = this._stopBody().finally(() => {
      this._stopPromise = null;
    });
    return this._stopPromise;
  }

  async _stopBody() {
    this.stopping = true;
    this.watchdog?.stop();
    this.watchdog = null;
    if (this.positionTimer) clearInterval(this.positionTimer);
    this.positionTimer = null;

    try {
      await this._teardownBrowser();
      await this.proxy?.stop();
      await this.staticServer?.stop();
      this.audio?.stop();
      this.display?.stop();
    } catch (err) {
      this.log(`teardown failed: ${err.message}`);
    }

    this.proxy = null;
    this.staticServer = null;
    this.audio = null;
    this.display = null;
    this.stream = null;
    this.source = null;
    this.request = null;
    this.position = 0;
    this.duration = 0;
    this.backendInUse = null;
    this.restarts = 0;
    this.streamLoop = 0;
    this._setState(STATE.IDLE);
    this.stopping = false;

    for (const { pid } of findOrphans(ORPHAN_MARKERS)) {
      try {
        process.kill(pid, 'SIGKILL');
        this.log(`killed leftover process ${pid}`);
      } catch { /* already gone */ }
    }
  }
}


/**
 * Choose a caption track.
 * Prefers the track the API marks as default, then anything labelled English,
 * then the first available track.
 */
export function pickCaption(source, wanted) {
  if (!wanted || !source?.captions?.length) return null;
  const list = source.captions;
  return (
    list.find((c) => c.default)?.file ||
    list.find((c) => /english/i.test(c.label))?.file ||
    list[0].file
  );
}

export { checkSystemTools };
export { sleep };
