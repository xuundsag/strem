// megaplay.buzz client.
//
// Everything here was verified against the live API on 2026-10-23. The
// evidence (raw requests and responses) is written up in docs/API.md.
//
// Resolution chain for (MAL id, episode, language):
//
//   1. GET https://megaplay.buzz/stream/mal/{malId}/{ep}/{lang}
//        -> an HTML player page. The <div id="megaplay-player"> carries
//           data-id / data-realid / data-mediaid.
//        -> window.settings has type:'sub'|'dub', which is the truth about
//           which language we actually got.
//        -> a missing episode returns a 410-style "Error - MegaPlay" page.
//
//   2. GET https://megaplay.buzz/stream/getSources?id={data-id}&platform=OTHER
//        -> { tracks[], intro{start,end}, outro{start,end}, server, image, enc }
//           Only `id = data-id` resolves. data-realid and data-mediaid 404.
//
//   3. The tracks array contains subtitle URLs on the video CDN, e.g.
//        https://<cdn>/anime/<hashA>/<hashB>/subtitles/track_0_eng.vtt
//      The video master playlist sits at the same path with a different tail:
//        https://<cdn>/anime/<hashA>/<hashB>/master.m3u8
//
//   4. That playlist is public to anyone who sends a Referer of
//      https://megaplay.buzz/ . The `token` query parameter the web player
//      uses is NOT validated - verified by requesting it with a bogus token
//      and with none at all, both return 200.
//
// Note on the web player: megaplay serves a 410 page when the embed is opened
// as a top level document. It only renders inside an iframe. That is why the
// fallback path here (plain HTTP) exists - it needs no browser at all.

import { fetchJson, HttpError } from './http.js';
import { mediaHeaders, megaplayEmbedByMal, megaplayEmbedByEpisodeId, megaplaySources, mediaLocationFromTrackUrl } from './urls.js';

/** Raised when we know for sure the episode is not there. */
export class EpisodeNotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EpisodeNotFoundError';
    this.retryable = false;
  }
}

/** Raised when the requested audio track does not exist for that episode. */
export class LanguageUnavailableError extends Error {
  constructor(message, available) {
    super(message);
    this.name = 'LanguageUnavailableError';
    this.retryable = false;
    this.available = available; // e.g. ['sub']
  }
}

const EMBED_ID_RE = /data-id="(\d+)"/;
const REALID_RE = /data-realid="(\d+)"/;
const MEDIAID_RE = /data-mediaid="(\d+)"/;
const TITLE_RE = /<title>([^<]*)<\/title>/i;
const SETTINGS_TYPE_RE = /window\.settings\s*=\s*\{[\s\S]*?type:\s*'(sub|dub)'/;
const ERROR_CODE_RE = /Error Code:\s*<span>(\d+)<\/span>/i;

/**
 * Pull the useful fields out of a megaplay embed page.
 * Exported for testing: it is pure string parsing with no network.
 *
 * @param {string} html
 * @returns {{found:boolean, mediaId?:string, realId?:string, dataMediaId?:string,
 *            settingsType?:'sub'|'dub', errorCode?:string, title?:string, reason?:string}}
 */
export function parseEmbedPage(html) {
  if (typeof html !== 'string' || !html.length) {
    return { found: false, reason: 'empty response from the video server' };
  }
  const id = html.match(EMBED_ID_RE)?.[1];
  if (!id) {
    // No player div means megaplay handed back its error page.
    const errorCode = html.match(ERROR_CODE_RE)?.[1];
    const title = html.match(TITLE_RE)?.[1]?.trim();
    return {
      found: false,
      errorCode: errorCode ?? undefined,
      title,
      reason: errorCode === '410' ? 'episode not found on the video server' : `video server error page (${title || errorCode || 'unknown'})`,
    };
  }
  return {
    found: true,
    mediaId: id,
    realId: html.match(REALID_RE)?.[1],
    dataMediaId: html.match(MEDIAID_RE)?.[1],
    settingsType: html.match(SETTINGS_TYPE_RE)?.[1],
    title: html.match(TITLE_RE)?.[1]?.trim(),
  };
}

/**
 * Normalise the getSources payload into what the rest of the app wants.
 * Pure function, exported for testing.
 *
 * @param {object} raw the JSON from getSources
 */
export function normaliseSources(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.tracks)) {
    throw Object.assign(new Error('Video server returned a malformed source list.'), { retryable: false });
  }
  // An empty list means the server has no media for this episode. Say so
  // directly rather than letting it fall through to a location error.
  if (raw.tracks.length === 0) {
    throw Object.assign(new Error('The video server returned an empty source list for this episode.'), {
      retryable: false,
    });
  }

  const captions = raw.tracks
    .filter((t) => t && t.kind === 'captions' && typeof t.file === 'string')
    .map((t) => ({ file: t.file, label: t.label || 'Unknown', default: t.default === true }));

  // The location comes from any track URL. We prefer a caption track because
  // those are always present, then fall back to the thumbnail track.
  const anyTrack = captions[0]?.file || raw.tracks.find((t) => t && typeof t.file === 'string')?.file;
  const location = anyTrack ? mediaLocationFromTrackUrl(anyTrack) : null;
  if (!location) {
    throw Object.assign(new Error('Could not derive the video location from the source list.'), { retryable: false });
  }

  // intro/outro come as {start,end} in seconds. A zero-length range means
  // "no marker", which the Skip button has to know about.
  const marker = (m) => {
    const start = Number(m?.start);
    const end = Number(m?.end);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
    if (end <= start) return null;
    return { start, end };
  };

  return {
    masterUrl: location.master,
    cdnHost: location.host,
    mediaPath: location.path,
    captions,
    intro: marker(raw.intro),
    outro: marker(raw.outro),
    server: raw.server ?? null,
    poster: typeof raw.image === 'string' ? raw.image : null,
  };
}

/**
 * Resolve one episode to something the player can actually use.
 *
 * @param {object} p
 * @param {number} p.malId
 * @param {number} p.episode
 * @param {'sub'|'dub'} p.lang
 * @param {AbortSignal} [p.signal]
 * @param {(msg:string)=>void} [p.log]
 * @param {string} [p.baseUrl] override for tests / mirrors
 * @returns {Promise<object>} resolved source
 */
export async function resolveEpisode({ malId, episode, lang, signal, log = () => {}, baseUrl }) {
  const embedUrl = baseUrl
    ? `${baseUrl}/stream/mal/${malId}/${episode}/${lang}`
    : megaplayEmbedByMal(malId, episode, lang);

  log(`resolving MAL ${malId} episode ${episode} (${lang})`);

  // Step 1: the embed page.
  let html;
  try {
    html = await fetchJson(embedUrl, {
      headers: mediaHeaders(),
      asJson: false,
      signal,
      attempts: 3,
      timeoutMs: 20000,
    });
  } catch (err) {
    // megaplay normally answers 200 with an error page, but a hard 404 means the
    // same thing and should not be retried as a server fault.
    if (err.status === 404) {
      throw new EpisodeNotFoundError(`Episode ${episode} is not on the video server for MAL id ${malId}.`);
    }
    throw err;
  }

  const page = parseEmbedPage(html);
  if (!page.found) {
    // megaplay answers HTTP 200 even for its error page, so the body decides.
    // Verified live:
    //   unknown MAL id or episode  -> Error Code 404 "doesn't exist"
    //   blocked / removed file     -> Error Code 410 "can't find the file"
    if (page.errorCode === '404') {
      throw new EpisodeNotFoundError(
        `MAL id ${malId} has no episode ${episode} on the video server.`,
      );
    }
    if (page.errorCode === '410' || /not find the file/i.test(html)) {
      throw new EpisodeNotFoundError(
        `Episode ${episode} was removed from the video server (code 410).`,
      );
    }
    // Any other error page is treated as transient so a mirror can be tried.
    throw Object.assign(new Error(page.reason || 'Video server returned an unexpected page.'), { retryable: true });
  }

  // The web player writes the language it actually loaded into window.settings.
  // When we asked for dub and it loaded sub, the dub does not exist.
  if (lang === 'dub' && page.settingsType && page.settingsType !== 'dub') {
    throw new LanguageUnavailableError(
      `There is no dubbed version of episode ${episode}.`,
      ['sub'],
    );
  }

  // Step 2: sources.
  const sourcesUrl = baseUrl ? `${baseUrl}/stream/getSources?id=${page.mediaId}&platform=OTHER` : megaplaySources(page.mediaId);
  const raw = await fetchJson(sourcesUrl, { headers: mediaHeaders(), signal, attempts: 3, timeoutMs: 20000 });
  const sources = normaliseSources(raw);

  return {
    malId,
    episode,
    lang,
    /** id megaplay uses for the sources call - useful when debugging */
    megaplayId: page.mediaId,
    realId: page.realId ?? null,
    embedUrl,
    ...sources,
  };
}

/**
 * Resolve with the fallbacks the spec asks for:
 *   - try the requested language, then fall back to sub if dub is missing
 *   - try alternate mirrors when one host fails
 *
 * @returns {Promise<{source:object, fallbacks:string[]}>}
 */
export async function resolveEpisodeWithFallbacks({ malId, episode, lang, mirrors = [], baseUrl, signal, log = () => {} }) {
  const notes = [];
  let lastError = null;

  const languages = lang === 'dub' ? ['dub', 'sub'] : ['sub'];

  for (const want of languages) {
    if (want !== lang) notes.push(`Dub unavailable, falling back to sub for episode ${episode}.`);

    // The chosen host first, then any mirrors. baseUrl is the override tests
    // use to point at a local server; without it the default host is tried.
    const targets = [baseUrl, ...mirrors.filter((m) => m !== baseUrl)];
    for (const baseUrl of targets) {
      try {
        const source = await resolveEpisode({ malId, episode, lang: want, signal, log, baseUrl });
        return { source, fallbacks: notes, requestedLang: lang, actualLang: want };
      } catch (err) {
        lastError = err;
        // A definite "no dub" is not a mirror problem: stop trying mirrors and
        // let the outer loop move on to sub.
        if (err instanceof LanguageUnavailableError) break;
        // A definite "no such episode" is not a mirror problem either.
        if (err instanceof EpisodeNotFoundError) break;
        log(`mirror ${baseUrl ?? 'megaplay.buzz'} failed: ${err.message}`);
      }
    }
  }
  throw lastError ?? new Error('Could not resolve that episode.');
}
