// Public surface of the player package.
export { HlsProxy, rewritePlaylist } from './hls-proxy.js';
export { StaticServer, buildPlayerPage, findHlsJs } from './static-server.js';
export { VirtualDisplay, NullSinkAudio, checkSystemTools } from './display.js';
export { BrowserPlayer } from './browser-player.js';
export { ScreenCapture, Watchdog } from './capture.js';
export { PlaybackEngine, pickCaption } from './playback-engine.js';
export { track, killOrphans, findOrphans, installExitGuard, trackedCount, ORPHAN_MARKERS, XVFB_MARKER, run } from './process-guard.js';
