import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { mediaHeaders } from '@anime-stream/shared/urls.js';
import { sleep } from '@anime-stream/shared/retry.js';
import { track } from './process-guard.js';

export class BrowserPlayer extends EventEmitter {
  constructor({ staticServer, display, audio, viewport = { width: 1920, height: 1080 }, log = () => {} } = {}) {
    super();
    this.staticServer = staticServer;
    this.display = display;
    this.audio = audio;
    this.viewport = viewport;
    this.log = log;
    this.browser = null;
    this.proc = null;
    this.context = null;
    this.page = null;
    this.crashed = false;
    this.playlistUrl = null;
  }

  async launch() {
    if (this.page) return this;
    const { chromium } = await import('playwright');
    const { width, height } = this.viewport;
    const args = [
      `--app=${this.staticServer.playerUrl}`,
      '--window-position=0,0',
      `--window-size=${width},${height}`,
      '--autoplay-policy=no-user-gesture-required',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-dev-shm-usage',
      '--disable-infobars',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--force-device-scale-factor=1',
      '--hide-scrollbars',
      '--alsa-output-device=default',
      '--disable-features=TranslateUI,AudioServiceSandbox,AudioServiceOutOfProcess,GlobalMediaControls,HardwareMediaKeyHandling,MediaRouter,PictureInPicture',
      '--ozone-platform=x11',
      '--enable-unsafe-swiftshader',
      '--remote-debugging-port=0',
    ];

    this.proc = track(spawn(chromium.executablePath(), args, {
      env: buildEnv(this.display, this.audio),
      stdio: ['ignore', 'pipe', 'pipe'],
    }));
    const ws = await waitForDevtools(this.proc);
    this.browser = await chromium.connectOverCDP(ws);
    this.browser.on('disconnected', () => {
      if (this.page) {
        this.crashed = true;
        this.log('chromium disconnected unexpectedly');
        this.emit('crash');
      }
    });

    const deadline = Date.now() + 15000;
    while (Date.now() < deadline && !this.page) {
      this.context = this.browser.contexts()[0];
      this.page = this.context?.pages()[0] || null;
      if (!this.page) await sleep(100);
    }
    if (!this.page) throw new Error('chromium app window did not appear');
    this.page.on('pageerror', (e) => this.log(`page error: ${e.message}`));
    this.page.on('console', (m) => {
      if (m.type() === 'error') this.log(`console: ${m.text().slice(0, 200)}`);
    });
    await this.page.waitForFunction(() => !!window.__player, { timeout: 20000 });
    await this.fitWindow();
    this.crashed = false;
    this.log('chromium ready');
    return this;
  }

  async fitWindow() {
    const { width, height } = this.viewport;
    const cdp = await this.page.context().newCDPSession(this.page);
    const { windowId } = await cdp.send('Browser.getWindowForTarget');
    let wantW = width;
    let wantH = height;
    for (let i = 0; i < 4; i++) {
      await cdp.send('Browser.setWindowBounds', { windowId, bounds: { left: 0, top: 0, width: wantW, height: wantH } });
      await sleep(150);
      const box = await this.page.evaluate(() => ({
        w: window.innerWidth,
        h: window.innerHeight,
        ow: window.outerWidth,
        oh: window.outerHeight,
        x: window.screenX,
        y: window.screenY,
      }));
      this.log(`window ${box.w}x${box.h} outer ${box.ow}x${box.oh} at ${box.x},${box.y}`);
      if (box.w === width && box.h === height && box.ow === width && box.oh === height && box.x === 0 && box.y === 0) return;
      wantW += width - box.w;
      wantH += height - box.h;
    }
  }

  async load({ playlistUrl, startAt = 0, captionUrl, captions = false, loop = false, volume = 1 }) {
    if (!this.page) await this.launch();
    this.playlistUrl = playlistUrl;

    let vtt = '';
    if (captionUrl && captions) {
      try {
        const res = await fetch(captionUrl, { headers: mediaHeaders() });
        if (res.ok) vtt = await res.text();
        else this.log(`caption fetch failed: HTTP ${res.status}`);
      } catch (e) {
        this.log(`caption fetch error: ${e.message}`);
      }
    }

    await this.page.evaluate((on) => window.__player.setLoop(on), !!loop);
    await this.page.evaluate((level) => window.__player.setVolume(level), volume);
    await this.page.evaluate(
      ([text, on]) => window.__player.loadCaptions(text, on),
      [vtt, captions],
    );
    await this.page.evaluate(
      ([u, s]) => window.__player.load({ url: u, startAt: s }),
      [playlistUrl, startAt],
    );

    const ok = await this.waitForReady(30000);
    if (!ok) {
      const st = await this.status().catch(() => null);
      throw new Error(`video did not become ready (phase=${st?.phase}, error=${st?.error})`);
    }
    if (startAt > 0) await this.page.evaluate((t) => window.__player.seek(t), startAt);
    await this.page.evaluate((level) => window.__player.setVolume(level), volume);
    return this;
  }

  async waitForReady(timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const st = await this.status().catch(() => null);
      if (st && st.readyState >= 2 && st.videoWidth > 0 && st.duration > 0) return true;
      if (st?.phase === 'error' && /no hls support/.test(st.error || '')) return false;
      await sleep(250);
    }
    return false;
  }

  async status() {
    if (!this.page) return null;
    return this.page.evaluate(() => window.__player.status());
  }

  async pause() {
    if (!this.page) return false;
    return this.page.evaluate(() => window.__player.pause());
  }

  async resume() {
    if (!this.page) return false;
    await this.page.evaluate(() => window.__player.play());
    return true;
  }

  async seek(seconds) {
    if (!this.page) return null;
    const target = await this.page.evaluate((t) => window.__player.seek(t), seconds);
    await sleep(400);
    const st = await this.status();
    return st?.currentTime ?? target;
  }

  async setCaptions(on) {
    if (!this.page) return false;
    return this.page.evaluate((v) => window.__player.setCaptions(v), !!on);
  }

  async setVolume(level) {
    if (!this.page) return null;
    return this.page.evaluate((v) => window.__player.setVolume(v), level);
  }

  async setLoop(on) {
    if (!this.page) return false;
    return this.page.evaluate((v) => window.__player.setLoop(v), !!on);
  }

  async windowBox() {
    if (!this.page) return null;
    return this.page.evaluate(() => {
      const r = document.getElementById('v').getBoundingClientRect();
      return {
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        outerWidth: window.outerWidth,
        outerHeight: window.outerHeight,
        screenX: window.screenX,
        screenY: window.screenY,
        video: { x: r.x, y: r.y, width: r.width, height: r.height },
      };
    });
  }

  async stop() {
    this.page = null;
    try { if (this.browser) await this.browser.close(); } catch { /* gone */ }
    this.context = null;
    this.browser = null;
    if (this.proc && !this.proc.killed) {
      this.proc.kill('SIGTERM');
      this.proc = null;
    }
  }
}

function waitForDevtools(proc, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error('chromium did not open a debugging port')), timeoutMs);
    const onData = (chunk) => {
      buf += chunk.toString();
      const match = /ws:\/\/\S+/.exec(buf);
      if (!match) return;
      clearTimeout(timer);
      resolve(match[0]);
    };
    proc.stdout?.on('data', onData);
    proc.stderr?.on('data', onData);
    proc.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`chromium exited before the debugging port was ready (${code})`));
    });
  });
}

function buildEnv(display, audio) {
  const env = { ...process.env };
  if (display?.envDisplay) env.DISPLAY = display.envDisplay;
  if (audio?.env) {
    for (const key of ['PULSE_SERVER', 'PULSE_SINK', 'PULSE_RUNTIME_PATH', 'XDG_RUNTIME_DIR', 'ALSA_CONFIG_PATH']) {
      if (audio.env[key]) env[key] = audio.env[key];
    }
  } else if (audio?.runtimeDir) {
    env.PULSE_RUNTIME_PATH = audio.runtimeDir;
    env.XDG_RUNTIME_DIR = audio.runtimeDir;
    env.PULSE_SERVER = `unix:${audio.runtimeDir}/pulse/native`;
    env.PULSE_SINK = audio.sinkName;
  }
  return env;
}
