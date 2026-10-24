// The IPC contract between the two halves of the system.
//
//   CONTROLLER (official bot, has the slash command and the panel)
//        |
//        |  JSON messages over HTTP on 127.0.0.1
//        v
//   STREAMER  (selfbot, owns the browser + ffmpeg + video)
//
// The controller never touches video. The streamer never touches Discord UI.
// Keeping the wire format in one file means both sides cannot drift apart.
//
// Every message is { v: 1, type: <string>, ...payload }.
// Every reply is { ok: boolean, ... }.

export const IPC_VERSION = 1;

/** Commands the controller is allowed to send to the streamer. */
export const CMD = Object.freeze({
  PLAY: 'play',
  PAUSE: 'pause',
  RESUME: 'resume',
  SEEK: 'seek',
  SKIP: 'skip',
  SKIP_INTRO: 'skip-intro',
  SKIP_OUTRO: 'skip-outro',
  SKIP_RECAP: 'skip-recap',
  VOLUME: 'volume',
  CAPTIONS: 'captions',
  STOP: 'stop',
  STATUS: 'status',
  PING: 'ping',
  STREAMERS: 'streamers',
  STREAMERS_RELOAD: 'streamers-reload',
  PICK_CHANNEL: 'pick-channel',
});

/** Push notifications the streamer sends to the controller. */
export const EVT = Object.freeze({
  STATE: 'state', // position / status changed, panel should refresh
  ERROR: 'error', // something broke, reason included
  ENDED: 'ended', // episode reached the end
});

/** Machine readable playback states shown on the panel. */
export const STATE = Object.freeze({
  IDLE: 'idle',
  LOADING: 'loading',
  PLAYING: 'playing',
  PAUSED: 'paused',
  ERROR: 'error',
});

/**
 * Wrap a payload into an IPC envelope.
 * @param {string} type one of CMD.*
 * @param {object} [payload]
 */
export function encode(type, payload = {}) {
  return { v: IPC_VERSION, type, ...payload };
}

/**
 * Check an incoming IPC envelope. Returns a reason string when it is wrong,
 * or null when it looks fine. We validate rather than trust, because this
 * socket is the only thing stopping a stray request from killing a stream.
 */
export function validate(msg) {
  if (!msg || typeof msg !== 'object') return 'body must be a JSON object';
  if (msg.v !== IPC_VERSION) return `unsupported protocol version ${msg.v}`;
  if (typeof msg.type !== 'string') return 'missing message type';
  return null;
}

/**
 * Shared secret check. IPC binds to 127.0.0.1 only, but a token stops any
 * other process on the same VPS from driving the stream.
 */
export function checkAuth(header, expected) {
  if (!expected) return true; // auth disabled on purpose
  return typeof header === 'string' && header === `Bearer ${expected}`;
}

/**
 * Validate a play request before it ever reaches the pipeline.
 * This is the single source of truth for "is this a legal play command",
 * used by both the IPC server and its tests.
 *
 * @param {object} req
 * @returns {{ok:true, value:object}|{ok:false, error:string, code:string}}
 */
export function validatePlayRequest(req) {
  const fail = (code, error) => ({ ok: false, code, error });
  if (!req || typeof req !== 'object') return fail('bad_request', 'Empty request body.');

  // MAL id: positive integer. MAL ids are numeric and well under 2^31 today,
  // but we keep the bound generous.
  const malId = Number(req.malId);
  if (!Number.isInteger(malId) || malId <= 0 || malId > 2147483647) {
    return fail('invalid_id', 'animeid must be a positive MAL id number, for example 21.');
  }

  // Episode: positive number. Episodes like 1045.5 exist for specials, so we
  // allow a fractional part but require something real.
  const episode = Number(req.episode);
  if (!Number.isFinite(episode) || episode <= 0 || episode > 100000) {
    return fail('missing_episode', 'episode must be a positive number, for example 1.');
  }
  if (!Number.isInteger(episode * 100)) {
    return fail('bad_episode', 'episode has too many decimals, use at most 2.');
  }

  // Audio track.
  const audio = String(req.audio ?? '').toLowerCase();
  if (!['sub', 'dub'].includes(audio)) {
    return fail('bad_audio', 'audio must be either sub or dub.');
  }

  // Captions. Accept booleans and the yes/no words from the slash command.
  let captions;
  if (typeof req.captions === 'boolean') captions = req.captions;
  else if (['yes', 'true', 'on', '1'].includes(String(req.captions).toLowerCase())) captions = true;
  else if (['no', 'false', 'off', '0'].includes(String(req.captions).toLowerCase())) captions = false;
  else return fail('bad_captions', 'captions must be yes or no.');

  // Voice target is mandatory: the streamer cannot guess where to go.
  const guildId = String(req.guildId ?? '').trim();
  const channelId = String(req.channelId ?? '').trim();
  if (!/^\d{15,25}$/.test(guildId)) return fail('no_voice', 'Missing guild id for the voice channel.');
  if (!/^\d{15,25}$/.test(channelId)) return fail('no_voice', 'Missing voice channel id.');

  // Resume point. Optional, and clamped to zero because a stale record must
  // never produce a negative seek.
  const startAt = Number(req.startAt);
  const safeStartAt = Number.isFinite(startAt) && startAt > 0 ? Math.floor(startAt) : 0;

  return {
    ok: true,
    value: {
      malId,
      episode,
      audio,
      captions,
      guildId,
      channelId,
      requesterId: req.requesterId ? String(req.requesterId) : null,
      title: typeof req.title === 'string' ? req.title : null,
      startAt: safeStartAt,
    },
  };
}
