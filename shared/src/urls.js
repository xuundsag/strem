// URL builders.
//
// Every outbound URL in the project is built here so the format only exists in
// one place. The megaplay / Anikoto shapes below were captured from the live
// API - see docs/API.md for the evidence.

export const MEGAPLAY_BASE = 'https://megaplay.buzz';
export const ANIKOTO_BASE = 'https://anikotoapi.site';

/**
 * Google search URL for the panel title link.
 * We search "<title> episode <n>" so the top hit is the episode page.
 */
export function googleSearchUrl(title, episode) {
  const q = episode == null || episode === '' ? String(title) : `${title} episode ${episode}`;
  return `https://www.google.com/search?q=${encodeURIComponent(q)}`;
}

/**
 * MegaPlay embed URL addressed by MAL id + episode number.
 * Verified live: GET https://megaplay.buzz/stream/mal/21/1/sub
 * Returns the player page whose <div id="megaplay-player"> carries data-id.
 */
export function megaplayEmbedByMal(malId, episode, lang) {
  return `${MEGAPLAY_BASE}/stream/mal/${malId}/${formatEpisodeForUrl(episode)}/${lang}`;
}

/**
 * MegaPlay embed URL addressed by the catalogue episode id
 * (Anikoto `episode_embed_id`, same id system as the old HiAnime).
 */
export function megaplayEmbedByEpisodeId(episodeEmbedId, lang) {
  return `${MEGAPLAY_BASE}/stream/s-2/${episodeEmbedId}/${lang}`;
}

/**
 * MegaPlay sources endpoint. `id` is the `data-id` attribute from the embed
 * page (NOT data-realid and NOT data-mediaid - only data-id resolves).
 * Verified live: GET https://megaplay.buzz/stream/getSources?id=36396&platform=OTHER
 */
export function megaplaySources(mediaId) {
  return `${MEGAPLAY_BASE}/stream/getSources?id=${mediaId}&platform=OTHER`;
}

/** Anikoto catalogue: recent anime, paginated. */
export function anikotoRecent(page = 1, perPage = 20) {
  return `${ANIKOTO_BASE}/recent-anime?page=${page}&per_page=${perPage}`;
}

/** Anikoto catalogue: one series with its full episode list. */
export function anikotoSeries(seriesId) {
  return `${ANIKOTO_BASE}/series/${seriesId}`;
}

/**
 * Build the HLS master playlist URL from data that getSources already gave us.
 *
 * getSources hands back subtitle URLs that look like
 *   https://<cdn>/anime/<hashA>/<hashB>/subtitles/track_0_eng.vtt
 * The video lives at
 *   https://<cdn>/anime/<hashA>/<hashB>/master.m3u8
 * so we only have to swap the tail. No decryption and no browser needed.
 *
 * @param {string} trackUrl any URL from the tracks array
 * @returns {string|null} master playlist URL, or null when the shape is unexpected
 */
export function masterPlaylistFromTrackUrl(trackUrl) {
  if (typeof trackUrl !== 'string') return null;
  const m = trackUrl.match(/^(https?):\/\/([^/]+)\/(.+?)\/(?:subtitles|preview)\/[^/]+$/);
  if (!m) return null;
  // The scheme is carried over rather than forced to https, so a plain http
  // host (a mirror, or the test server) keeps working.
  return `${m[1]}://${m[2]}/${m[3]}/master.m3u8`;
}

/** Same, but return the pieces so the proxy can mirror variants. */
export function mediaLocationFromTrackUrl(trackUrl) {
  if (typeof trackUrl !== 'string') return null;
  const m = trackUrl.match(/^(https?):\/\/([^/]+)\/(.+?)\/(?:subtitles|preview)\/[^/]+$/);
  if (!m) return null;
  return {
    scheme: m[1],
    host: m[2],
    path: m[3],
    origin: `${m[1]}://${m[2]}`,
    master: `${m[1]}://${m[2]}/${m[3]}/master.m3u8`,
  };
}

/**
 * Episode numbers can be fractional (1045.5 for specials). MegaPlay wants the
 * plain decimal form in the path.
 */
export function formatEpisodeForUrl(episode) {
  const n = Number(episode);
  if (!Number.isFinite(n)) return String(episode);
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(2)));
}

/**
 * Headers that megaplay and the video CDN both require.
 * Verified live: without Referer the CDN answers with a Cloudflare block page,
 * and megaplay's embed answers with a 410 page.
 */
export function mediaHeaders(referer = `${MEGAPLAY_BASE}/`) {
  return {
    Referer: referer,
    'User-Agent':
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    Accept: '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
  };
}

/**
 * Logo lookup URLs, in preference order.
 * fanart.tv and TMDB both need an API key, so they are only returned when one
 * is configured. MAL and Kitsu need no key and act as the fallback.
 */
export function logoCandidates({ malId, tmdbKey, fanartKey, tmdbId }) {
  const out = [];
  if (fanartKey) {
    out.push({
      source: 'fanart.tv',
      url: `https://webservice.fanart.tv/v3/tv/${tmdbId || malId}?api_key=${fanartKey}`,
      needsJsonPick: 'hdtvlogo',
    });
  }
  if (tmdbKey && tmdbId) {
    out.push({
      source: 'tmdb',
      url: `https://api.themoviedb.org/3/tv/${tmdbId}/images?api_key=${tmdbKey}`,
      needsJsonPick: 'logos',
    });
  }
  // Kitsu: no key, gives us the cover we can use when no logo exists.
  out.push({ source: 'kitsu', url: `https://kitsu.io/api/edge/anime?filter[text]=&filter[malId]=${malId}` });
  // MAL: no key needed for the public cover CDN once we know the id.
  out.push({ source: 'mal', url: `https://api.jikan.moe/v4/anime/${malId}/full` });
  return out;
}
