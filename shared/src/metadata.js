import { fetchJson } from './http.js';

const UA = { 'User-Agent': 'jinx/1.0', Accept: 'application/json' };

export function presentTitle(title) {
  if (!title) return title;
  if (title.length > 3 && title === title.toUpperCase() && /[A-Z]/.test(title)) {
    return title.toLowerCase().replace(/(^|[\s:-])([a-z])/g, (m, a, b) => a + b.toUpperCase());
  }
  return title;
}

export function fromAnilist(body) {
  const media = body?.data?.Media;
  if (!media) return null;
  const titles = media.title || {};
  const title = titles.english || titles.romaji || titles.native || null;
  if (!title) return null;
  return {
    title: presentTitle(title),
    poster: media.coverImage?.extraLarge || media.coverImage?.large || null,
    episodeCount: Number.isFinite(media.episodes) ? media.episodes : null,
  };
}

export function pickKitsu(res) {
  const anime = res?.data?.attributes ? res.data : res?.data?.[0];
  const attrs = anime?.attributes;
  if (!attrs?.titles && !attrs?.canonicalTitle) return {};
  const t = attrs.titles || {};
  return {
    title: presentTitle(t.en || t.en_jp || attrs.canonicalTitle || t.ja_jp || null),
    poster: attrs.posterImage?.original || attrs.posterImage?.large || null,
    episodeCount: Number.isFinite(attrs.episodeCount) ? attrs.episodeCount : null,
  };
}

async function anilistLookup(malId, signal) {
  const body = await fetchJson('https://graphql.anilist.co', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      query: 'query ($id: Int) { Media(idMal: $id, type: ANIME) { title { romaji english native } episodes coverImage { extraLarge large } } }',
      variables: { id: malId },
    }),
    signal,
    attempts: 2,
    timeoutMs: 8000,
  });
  return fromAnilist(body);
}

async function kitsuLookup(malId, signal) {
  const headers = { ...UA, Accept: 'application/vnd.api+json' };
  const mapped = await fetchJson(
    `https://kitsu.io/api/edge/mappings?filter[externalSite]=myanimelist/anime&filter[externalId]=${malId}&page[limit]=1`,
    { headers, signal, attempts: 2, timeoutMs: 8000 },
  );
  const animeId = mapped?.data?.[0]?.relationships?.item?.data?.id;
  if (!animeId) return null;
  const anime = await fetchJson(`https://kitsu.io/api/edge/anime/${animeId}`, {
    headers,
    signal,
    attempts: 2,
    timeoutMs: 8000,
  });
  const pick = pickKitsu(anime);
  return pick.title ? pick : null;
}

async function jikanLookup(malId, signal) {
  const res = await fetchJson(`https://api.jikan.moe/v4/anime/${malId}`, {
    headers: UA,
    signal,
    attempts: 1,
    timeoutMs: 6000,
  });
  const d = res?.data;
  if (!d?.title && !d?.title_english) return null;
  return {
    title: presentTitle(d.title_english || d.title),
    poster: d.images?.jpg?.large_image_url || d.images?.jpg?.image_url || null,
    episodeCount: Number.isFinite(d.episodes) ? d.episodes : null,
  };
}

async function fanartLogo(malId, key, log, signal) {
  try {
    const full = await fetchJson(`https://api.jikan.moe/v4/anime/${malId}/full`, {
      headers: UA,
      signal,
      attempts: 1,
      timeoutMs: 6000,
    });
    const tmdb = full?.data?.external?.tmdb;
    if (!tmdb) return null;
    const res = await fetchJson(`https://webservice.fanart.tv/v3/tv/${tmdb}?api_key=${key}`, {
      signal,
      attempts: 1,
      timeoutMs: 8000,
    });
    const logos = res?.hdtvlogo || res?.hdclearlogo || res?.clearlogo;
    if (!Array.isArray(logos) || !logos.length) return null;
    const pick = logos.find((l) => l.lang === 'en' && /\.png$/i.test(l.url)) || logos[0];
    return pick?.url || null;
  } catch (e) {
    log(`fanart.tv lookup failed: ${e.message}`);
    return null;
  }
}

async function tmdbLogo(title, key, log, signal) {
  try {
    const search = await fetchJson(
      `https://api.themoviedb.org/3/search/tv?api_key=${key}&query=${encodeURIComponent(title)}&page=1`,
      { signal, attempts: 1, timeoutMs: 8000 },
    );
    const id = search?.results?.[0]?.id;
    if (!id) return null;
    const images = await fetchJson(
      `https://api.themoviedb.org/3/tv/${id}/images?api_key=${key}&include_image_language=en,null`,
      { signal, attempts: 1, timeoutMs: 8000 },
    );
    const logo = images?.logos?.[0];
    if (!logo?.file_path) return null;
    return `https://image.tmdb.org/t/p/w500${logo.file_path}`;
  } catch (e) {
    log(`tmdb lookup failed: ${e.message}`);
    return null;
  }
}

export async function lookup({ malId, tmdbKey, fanartKey, log = () => {}, signal } = {}) {
  const out = { title: `MAL ${malId}`, logoUrl: null, posterUrl: null, episodeCount: null, source: 'none' };
  const steps = [
    ['anilist', () => anilistLookup(malId, signal)],
    ['kitsu', () => kitsuLookup(malId, signal)],
    ['mal', () => jikanLookup(malId, signal)],
  ];
  for (const [name, run] of steps) {
    if (out.source !== 'none') break;
    try {
      const hit = await run();
      if (!hit?.title) continue;
      out.title = hit.title;
      out.posterUrl = hit.poster || null;
      out.episodeCount = hit.episodeCount ?? null;
      out.source = name;
    } catch (e) {
      log(`${name} lookup failed: ${e.message}`);
    }
  }

  if (fanartKey) {
    const logo = await fanartLogo(malId, fanartKey, log, signal);
    if (logo) out.logoUrl = logo;
  }
  if (!out.logoUrl && tmdbKey && out.source !== 'none') {
    const logo = await tmdbLogo(out.title, tmdbKey, log, signal);
    if (logo) out.logoUrl = logo;
  }
  if (!out.logoUrl && out.posterUrl) out.logoUrl = out.posterUrl;
  return out;
}
