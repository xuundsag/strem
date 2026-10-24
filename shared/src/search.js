import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { lookup } from './metadata.js';

const INDEX_URL = new URL('../data/title-index.json', import.meta.url);

let cachedIndex = null;

export function normalizeTitle(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function squash(value) {
  return normalizeTitle(value).replace(/ /g, '');
}

function vowels(value) {
  return squash(value).replace(/[aeiou]/g, 'a');
}

function damerau(a, b) {
  const n = a.length;
  const m = b.length;
  if (!n) return m;
  if (!m) return n;
  const row = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = 0; i <= n; i++) row[i][0] = i;
  for (let j = 0; j <= m; j++) row[0][j] = j;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min(row[i - 1][j] + 1, row[i][j - 1] + 1, row[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        best = Math.min(best, row[i - 2][j - 2] + 1);
      }
      row[i][j] = best;
    }
  }
  return row[n][m];
}

function similarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  return 1 - damerau(a, b) / Math.max(a.length, b.length);
}

export function scoreTitle(query, title) {
  const q = normalizeTitle(query);
  const t = normalizeTitle(title);
  if (!q || !t) return 0;
  if (q === t) return 1;
  const qs = q.replace(/ /g, '');
  const ts = t.replace(/ /g, '');
  if (qs === ts) return 0.99;
  if (qs.length >= 4 && ts.length >= 4 && vowels(q) === vowels(t) && Math.abs(qs.length - ts.length) <= 2) return 0.95;
  if (qs.length >= 6 && ts.length >= 6 && ts.startsWith(qs)) return 0.94;
  if (t.startsWith(`${q} `)) return 0.93;
  if (t.includes(q)) return 0.9;
  const qTokens = q.split(' ');
  const tTokens = t.split(' ');
  let token = 0;
  for (const part of qTokens) {
    let best = 0;
    for (const other of tTokens) best = Math.max(best, similarity(part, other));
    token += best;
  }
  token /= qTokens.length;
  const full = similarity(qs, ts);
  const vowel = similarity(vowels(q), vowels(t));
  return Math.max(token * 0.92, full, vowel * 0.9);
}

export function rankTitles(query, index, limit = 5) {
  const ranked = [];
  for (const entry of index || []) {
    const titles = entry.titles || [];
    let score = 0;
    let matched = titles[0] || '';
    for (const title of titles) {
      const next = scoreTitle(query, title);
      if (next > score) {
        score = next;
        matched = title;
      }
    }
    if (score < 0.72) continue;
    const extra = Math.max(0, normalizeTitle(matched).length - normalizeTitle(query).length);
    const formatBoost = entry.format === 'TV' ? 0.008 : entry.format === 'MOVIE' ? -0.015 : 0;
    ranked.push({
      malId: entry.id,
      title: matched,
      titles,
      score: score - extra * 0.002 + formatBoost,
      popularity: entry.pop || 0,
      episodes: entry.episodes ?? null,
      format: entry.format || '',
    });
  }
  ranked.sort((a, b) => b.score - a.score || b.popularity - a.popularity);
  return ranked.slice(0, limit);
}

export function titlesAgree(candidateTitles, fetchedTitle) {
  const got = normalizeTitle(fetchedTitle);
  if (!got) return false;
  return (candidateTitles || []).some((title) => {
    const want = normalizeTitle(title);
    if (!want) return false;
    return want === got || want.startsWith(got) || got.startsWith(want);
  });
}

export function loadTitleIndex(path = fileURL(INDEX_URL)) {
  if (cachedIndex && !path) return cachedIndex;
  const raw = JSON.parse(fs.readFileSync(path, 'utf8'));
  if (!path || path === fileURL(INDEX_URL)) cachedIndex = raw;
  return raw;
}

function fileURL(url) {
  return fileURLToPath(url);
}

async function anilistSearch(query, signal) {
  const res = await fetch('https://graphql.anilist.co', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      query: `query ($search: String) {
        Page(page: 1, perPage: 8) {
          media(search: $search, type: ANIME, sort: SEARCH_MATCH) {
            idMal
            popularity
            format
            episodes
            title { romaji english native }
            synonyms
          }
        }
      }`,
      variables: { search: query },
    }),
    signal,
  });
  if (!res.ok) return [];
  const json = await res.json();
  return (json?.data?.Page?.media || [])
    .filter((m) => m.idMal)
    .map((m) => ({
      id: m.idMal,
      pop: m.popularity || 0,
      format: m.format || '',
      episodes: Number.isFinite(m.episodes) ? m.episodes : null,
      titles: [m.title?.english, m.title?.romaji, m.title?.native, ...(m.synonyms || []).slice(0, 4)].filter(Boolean),
    }));
}

export async function resolveAnimeName(query, { lookupTitle = lookup, index, signal, log = () => {}, searchLive = anilistSearch } = {}) {
  const text = String(query || '').trim();
  if (text.length < 2) {
    const err = new Error('Type at least 2 letters of the anime name.');
    err.code = 'bad_query';
    throw err;
  }
  const catalog = index || loadTitleIndex();
  let live = [];
  try {
    live = await searchLive(text, signal);
  } catch (err) {
    log(`anilist search failed: ${err.message}`);
  }
  live = live.filter((entry) => {
    const mains = (entry.titles || []).slice(0, 2);
    return Math.max(0, ...mains.map((title) => scoreTitle(text, title))) >= 0.7;
  });
  const merged = new Map();
  for (const entry of [...live, ...catalog]) {
    if (!merged.has(entry.id)) merged.set(entry.id, entry);
    else {
      const prev = merged.get(entry.id);
      prev.titles = [...new Set([...(prev.titles || []), ...(entry.titles || [])])];
      prev.pop = Math.max(prev.pop || 0, entry.pop || 0);
      prev.format = prev.format || entry.format;
    }
  }
  const ranked = rankTitles(text, [...merged.values()], 5);
  if (!ranked.length) {
    const err = new Error(`No anime matched "${text}".`);
    err.code = 'no_match';
    throw err;
  }
  const best = ranked[0].score;
  const verified = [];
  let last = null;
  for (const candidate of ranked) {
    if (candidate.score < best - 0.06) break;
    let meta = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        meta = await lookupTitle({ malId: candidate.malId, log, signal });
      } catch (err) {
        log(`could not verify MAL ${candidate.malId}: ${err.message}`);
      }
      if (meta?.title && meta.source !== 'none' && !/^MAL \d+$/.test(meta.title)) break;
      if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 1200));
    }
    last = meta;
    if (!meta?.title || meta.source === 'none' || /^MAL \d+$/.test(meta.title)) {
      log(`rejected MAL ${candidate.malId}: lookup did not return a real title`);
      continue;
    }
    if (!titlesAgree(candidate.titles, meta.title)) {
      log(`rejected MAL ${candidate.malId}: index said ${candidate.title}, lookup said ${meta.title}`);
      continue;
    }
    const fetchedScore = scoreTitle(text, meta.title);
    if (fetchedScore < 0.8) {
      log(`rejected MAL ${candidate.malId}: fetched title ${meta.title} does not match "${text}"`);
      continue;
    }
    verified.push({
      malId: candidate.malId,
      title: meta.title,
      logoUrl: meta.logoUrl || null,
      episodeCount: meta.episodeCount ?? candidate.episodes ?? null,
      format: candidate.format || '',
      score: candidate.score,
      fetchedScore,
      verified: true,
    });
  }
  verified.sort((a, b) => b.fetchedScore - a.fetchedScore || a.title.length - b.title.length);
  if (verified.length) return verified[0];
  const err = new Error(`No verified anime matched "${text}".`);
  err.code = 'unverified';
  if (last?.title) err.detail = last.title;
  throw err;
}
