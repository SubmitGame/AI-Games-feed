#!/usr/bin/env node
/**
 * OFFLINE DEMO BUILDER — not the feed source of truth.
 *
 * Architecture A (default): the browser fetches the SubmitGame catalog
 * and maps cards in src/feed-from-catalog.js.
 *
 * This script still rebuilds public/games.json from a local catalog +
 * public/videos/ for air-gapped / offline demos. Prefer the raw fetch path.
 *
 * Usage: node scripts/build-feed.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const SRC = '/workspace/grokgames.json';
const CATALOG_SHOTS = '/workspace/Claude-vs-ChatGPT/screenshots';
const FRESH = '/workspace/opus-games-fresh';
const OUT_DIR = path.join(root, 'public');
const SHOTS = path.join(OUT_DIR, 'screenshots');
const VIDEOS = path.join(OUT_DIR, 'videos');
const AVATARS = path.join(OUT_DIR, 'avatars');

fs.mkdirSync(SHOTS, { recursive: true });
fs.mkdirSync(VIDEOS, { recursive: true });
fs.mkdirSync(AVATARS, { recursive: true });

const data = JSON.parse(fs.readFileSync(SRC, 'utf8'));
const filtered = (data.games || []).filter((g) => g?.play_url && String(g.play_url).trim());
const catalogCount = Array.isArray(data.games) ? data.games.length : 0;

// Dedup by play_url, keep highest screenshot_score.
// Dropped twin ids → kept id aliases for deep-link resolution.
const byUrl = new Map();
for (const g of filtered) {
  const url = g.play_url.replace(/\/$/, '');
  if (!byUrl.has(url)) byUrl.set(url, []);
  byUrl.get(url).push(g);
}

const uniqueMeta = [];
for (const group of byUrl.values()) {
  group.sort(
    (a, b) => (b.screenshot_score ?? -1) - (a.screenshot_score ?? -1),
  );
  const kept = group[0];
  const twinIds = [];
  for (const twin of group.slice(1)) {
    const twinId = twin?.id != null ? String(twin.id).trim() : '';
    const keptId = kept?.id != null ? String(kept.id).trim() : '';
    if (!twinId || !keptId || twinId === keptId) continue;
    twinIds.push(twinId);
  }
  uniqueMeta.push({ game: kept, aliases: twinIds });
}

uniqueMeta.sort(
  (a, b) =>
    (b.game.screenshot_score ?? -1) - (a.game.screenshot_score ?? -1),
);
const unique = uniqueMeta.map((x) => x.game);
const aliasesByKeptId = new Map(
  uniqueMeta
    .filter((x) => x.aliases.length && x.game?.id)
    .map((x) => [String(x.game.id), x.aliases]),
);

// Index existing videos by basename (without extension) → relative path
const videoByBasename = new Map();
for (const name of fs.readdirSync(VIDEOS)) {
  const m = name.match(/^(.+)\.(mp4|webm)$/i);
  if (!m) continue;
  const full = path.join(VIDEOS, name);
  if (fs.statSync(full).size <= 50_000) continue;
  const bas = m[1];
  const rel = `videos/${name}`;
  const prev = videoByBasename.get(bas);
  // Prefer mp4 over webm if both exist
  if (!prev || (name.toLowerCase().endsWith('.mp4') && !prev.endsWith('.mp4'))) {
    videoByBasename.set(bas, rel);
  }
}

function resolveVideo(g) {
  if (!g?.id) return null;
  if (videoByBasename.has(g.id)) return videoByBasename.get(g.id);
  // Fallback: basename of screenshot_path without numeric prefix (e.g. 131-splashline.jpg)
  if (g.screenshot_path) {
    const stem = path.basename(g.screenshot_path).replace(/\.[^.]+$/, '');
    if (videoByBasename.has(stem)) return videoByBasename.get(stem);
    const stripped = stem.replace(/^\d+-/, '');
    if (stripped && videoByBasename.has(stripped)) return videoByBasename.get(stripped);
  }
  return null;
}

function inferPlatforms(g) {
  if (Array.isArray(g.platforms) && g.platforms.length) {
    const set = new Set();
    for (const raw of g.platforms) {
      const v = String(raw).toLowerCase().trim();
      if (v === 'mobile' || v === 'touch' || v === 'phone' || v === 'tablet') set.add('mobile');
      else if (v === 'pc' || v === 'desktop' || v === 'web') set.add('pc');
    }
    if (set.has('mobile') && set.has('pc')) return ['mobile', 'pc'];
    if (set.has('mobile')) return ['mobile'];
    if (set.has('pc')) return ['pc'];
  }
  if (g.desktop_only === true) return ['pc'];
  if (g.mobile === true || g.touch === true) return ['mobile', 'pc'];

  const text = [g.title, g.description, g.screenshot_score_notes]
    .filter(Boolean)
    .join(' ');
  if (/desktop[- ]only|keyboard[- ]only|mouse[- ]only|pc[- ]only/i.test(text)) {
    return ['pc'];
  }
  if (
    /\b(touch(?:\s+controls?|\s+support)?|mobile(?:\s+support|\s+browser)?|phones?|tablets?|phone\s+or\s+pc|phone\s+controllers?)\b/i.test(
      text,
    )
  ) {
    return ['mobile', 'pc'];
  }
  return null;
}

const GH_RESERVED = new Set([
  'orgs', 'topics', 'features', 'about', 'pricing', 'login', 'signup',
  'settings', 'explore', 'sponsors', 'marketplace', 'pulls', 'issues',
  'notifications', 'new', 'codespaces', 'copilot', 'apps', 'enterprise',
]);

const X_RESERVED = new Set([
  'i', 'intent', 'share', 'home', 'explore', 'search', 'settings',
  'messages', 'notifications', 'compose', 'login', 'signup',
]);

/**
 * True for same-origin / relative public paths (e.g. /avatars/foo.png).
 * Absolute remote URLs return false.
 */
function isLocalPublicPath(url) {
  if (!url || typeof url !== 'string') return false;
  const u = url.trim();
  if (!u) return false;
  if (u.startsWith('/') && !u.startsWith('//')) return true;
  // relative path without scheme
  if (!/^[a-z][a-z0-9+.-]*:/i.test(u)) return true;
  return false;
}

/** Look for a cached file under public/avatars/ for github_user or x_handle. */
function findLocalAvatarFile(github_user, x_handle) {
  const names = [github_user, x_handle].filter(Boolean);
  const exts = ['png', 'jpg', 'jpeg', 'webp'];
  for (const name of names) {
    const candidates = [name, name.toLowerCase()];
    for (const base of candidates) {
      for (const ext of exts) {
        const file = `${base}.${ext}`;
        if (fs.existsSync(path.join(AVATARS, file))) {
          return `/avatars/${file}`;
        }
      }
    }
  }
  // Case-insensitive directory scan (handles mixed-case X handles vs lowercase files).
  let listing;
  try {
    listing = fs.readdirSync(AVATARS);
  } catch (_) {
    return null;
  }
  for (const name of names) {
    const want = String(name).toLowerCase();
    for (const file of listing) {
      const m = file.match(/^(.+)\.(png|jpe?g|webp)$/i);
      if (!m) continue;
      if (m[1].toLowerCase() !== want) continue;
      const full = path.join(AVATARS, file);
      if (fs.statSync(full).size > 100) return `/avatars/${file}`;
    }
  }
  return null;
}

/**
 * Infer author identity from play_url / source_url.
 * Avatar preference: local /avatars/* → source avatar_url if local → GitHub png.
 */
function inferAuthor(g) {
  const play = String(g.play_url || '');
  const source = String(g.source_url || '');
  let github_user = null;
  let x_handle = null;

  for (const u of [source, play]) {
    const m = u.match(
      /github\.com\/([A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38})(?:\/|$|\?|#)/i,
    );
    if (m && !GH_RESERVED.has(m[1].toLowerCase())) {
      github_user = m[1];
      break;
    }
  }
  if (!github_user) {
    const m = play.match(/https?:\/\/([A-Za-z0-9-]+)\.github\.io(?:\/|$|\?|#)/i);
    if (m) github_user = m[1];
  }

  const xm = source.match(
    /(?:x\.com|twitter\.com)\/([A-Za-z0-9_]{1,15})(?:\/|$|\?|#)/i,
  );
  if (xm && !X_RESERVED.has(xm[1].toLowerCase())) {
    x_handle = xm[1];
  }

  // Explicit fields from Overheard / grokgames win when present
  if (g.github_user && typeof g.github_user === 'string') {
    const gh = g.github_user.replace(/^@/, '').trim();
    if (/^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/.test(gh)) {
      github_user = gh;
    }
  }
  if (g.x_handle && typeof g.x_handle === 'string') {
    const xh = g.x_handle.replace(/^@/, '').trim();
    if (/^[A-Za-z0-9_]{1,15}$/.test(xh) && !X_RESERVED.has(xh.toLowerCase())) {
      x_handle = xh;
    }
  }

  const author = g.author || github_user || x_handle || null;

  // Prefer locally cached avatar, then local-path avatar_url from source, else GitHub.
  let avatar_url = findLocalAvatarFile(github_user, x_handle);
  if (!avatar_url && g.avatar_url && isLocalPublicPath(g.avatar_url)) {
    avatar_url = String(g.avatar_url).trim();
  }
  if (!avatar_url && github_user) {
    avatar_url = `https://github.com/${github_user}.png?size=80`;
  }

  return { author, github_user, x_handle, avatar_url };
}


/** Twitter/X snowflake epoch (ms). */
const TWITTER_EPOCH_MS = 1288834974657n;

/** ISO time from X/Twitter status id embedded in source_url, or null. */
function snowflakeIsoFromUrl(url) {
  const m = String(url || '').match(
    /(?:x\.com|twitter\.com)\/[^/]+\/status\/(\d+)/i,
  );
  if (!m) return null;
  try {
    const id = BigInt(m[1]);
    const ms = Number((id >> 22n) + TWITTER_EPOCH_MS);
    if (!Number.isFinite(ms) || ms < 1_000_000_000_000) return null;
    return new Date(ms).toISOString();
  } catch {
    return null;
  }
}

/** Promote YYYY-MM-DD (or parseable date) to ISO; pass through full ISO. */
function toIsoTimestamp(raw) {
  if (raw == null || raw === '') return null;
  const s = String(raw).trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return `${s}T00:00:00.000Z`;
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** Parse only timestamps that include a time, not Overheard day stamps. */
function toTimedIsoTimestamp(raw) {
  if (raw == null || raw === '') return null;
  const s = String(raw).trim();
  if (!s || !/[T ]\d{2}:\d{2}/.test(s)) return null;
  return toIsoTimestamp(s);
}

function videoMtimeIso(videoRel) {
  if (!videoRel) return null;
  try {
    const full = path.join(OUT_DIR, videoRel);
    return new Date(fs.statSync(full).mtimeMs).toISOString();
  } catch {
    return null;
  }
}

function maxIso(...vals) {
  let best = null;
  let bestT = -Infinity;
  for (const v of vals) {
    if (!v) continue;
    const t = Date.parse(v);
    if (!Number.isFinite(t)) continue;
    if (t >= bestT) {
      bestT = t;
      best = new Date(t).toISOString();
    }
  }
  return best;
}

/**
 * Resolve Overheard's publication/listing/rescan timestamps while retaining
 * the older snowflake and video-mtime fallbacks for incomplete catalog data.
 */
function resolveSeenTimestamps(g, videoRel) {
  const posted = snowflakeIsoFromUrl(g.source_url);
  const vMtime = videoMtimeIso(videoRel);
  const srcPublished = toTimedIsoTimestamp(g.published_at);
  const srcListed = toTimedIsoTimestamp(g.listed_at);
  const srcFirstTimed = toTimedIsoTimestamp(g.first_seen);
  const srcFirst = toIsoTimestamp(g.first_seen);
  const srcLastTimed = toTimedIsoTimestamp(g.last_seen);
  const srcLast = toIsoTimestamp(g.last_seen);

  // Overheard timestamps are authoritative when they carry time-of-day.
  const published_at = srcPublished || posted || null;
  const listed_at = srcListed || srcFirstTimed || null;
  const first_seen = listed_at || posted || srcFirst || vMtime || null;
  const last_seen =
    srcLastTimed || maxIso(srcLast, vMtime, posted, srcFirst) || first_seen;

  return {
    published_at,
    listed_at,
    first_seen,
    last_seen,
    video_mtime: vMtime,
  };
}

/** Pass through remote social-proof likes from Overheard / grokgames when present. */
function passRemoteLikes(g, entry) {
  if (g.remote_likes != null && g.remote_likes !== '') {
    const n = Number(g.remote_likes);
    if (Number.isFinite(n) && n >= 0) {
      entry.remote_likes = Math.floor(n);
    }
  }
  const src = g.likes_source;
  if (src === 'x' || src === 'github' || src === 'reddit') {
    entry.likes_source = src;
  }
}

/**
 * Pass Overheard `comments` through unchanged (array of objects).
 * Shape: { text, author, likes, created_at, url, avatar_url? } — already
 * top-N by likes with spam skipped upstream.
 */
function passComments(g, entry) {
  if (!Array.isArray(g.comments)) return;
  entry.comments = g.comments;
}

const feed = [];
let copied = 0;
let missing = 0;
let noVideo = 0;
let withAuthor = 0;
let withGithub = 0;
let withLocalAvatar = 0;
let withRemoteLikes = 0;
let withComments = 0;

for (const g of unique) {
  const video = resolveVideo(g);
  if (!video) {
    noVideo++;
    continue;
  }

  const basename = g.screenshot_path ? path.basename(g.screenshot_path) : '';
  let screenshot = null;
  if (basename) {
    const candidates = [path.join(CATALOG_SHOTS, basename), path.join(FRESH, basename)];
    const src = candidates.find((p) => fs.existsSync(p));
    if (src) {
      const dest = path.join(SHOTS, basename);
      fs.copyFileSync(src, dest);
      copied++;
      screenshot = `screenshots/${basename}`;
    } else if (fs.existsSync(path.join(SHOTS, basename))) {
      screenshot = `screenshots/${basename}`;
    } else {
      missing++;
    }
  }
  const platforms = inferPlatforms(g);
  const { author, github_user, x_handle, avatar_url } = inferAuthor(g);
  const {
    published_at,
    listed_at,
    first_seen,
    last_seen,
    video_mtime,
  } = resolveSeenTimestamps(g, video);
  const entry = {
    id: g.id,
    title: g.title,
    description: g.description || '',
    play_url: g.play_url,
    screenshot,
    screenshot_score: g.screenshot_score ?? null,
    source_url: g.source_url ?? null,
    published_at,
    listed_at,
    first_seen,
    last_seen,
    video,
  };
  if (video_mtime) entry.video_mtime = video_mtime;
  if (platforms) entry.platforms = platforms;
  if (author) {
    entry.author = author;
    withAuthor++;
  }
  if (github_user) {
    entry.github_user = github_user;
    withGithub++;
  }
  if (x_handle) entry.x_handle = x_handle;
  if (avatar_url) {
    entry.avatar_url = avatar_url;
    if (isLocalPublicPath(avatar_url)) withLocalAvatar++;
  }
  if (typeof g.iframe === 'boolean') entry.iframe = g.iframe;
  passRemoteLikes(g, entry);
  if (entry.remote_likes != null) withRemoteLikes++;
  passComments(g, entry);
  if (Array.isArray(entry.comments) && entry.comments.length) withComments++;
  const twinAliases = aliasesByKeptId.get(String(g.id));
  if (twinAliases?.length) entry.aliases = twinAliases;
  feed.push(entry);
}

const publishedAliases = Object.create(null);
for (const entry of feed) {
  if (!Array.isArray(entry.aliases) || !entry.id) continue;
  for (const alias of entry.aliases) {
    if (alias) publishedAliases[alias] = entry.id;
  }
}

const out = {
  updated_at: data.updated_at,
  catalog_count: catalogCount,
  count: feed.length,
  games: feed,
  id_aliases: publishedAliases,
};
fs.writeFileSync(path.join(OUT_DIR, 'games.json'), JSON.stringify(out, null, 2));
const withPlatforms = feed.filter((g) => g.platforms?.length).length;
const withMobile = feed.filter((g) => g.platforms?.includes('mobile')).length;
console.log(
  `Wrote ${feed.length} video games (screenshots copied: ${copied}, missing shots: ${missing}, skipped no-video: ${noVideo}, with platforms: ${withPlatforms}, mobile: ${withMobile}, authors: ${withAuthor}, github: ${withGithub}, local avatars: ${withLocalAvatar}, remote_likes: ${withRemoteLikes}, with comments: ${withComments})`,
);
const firsts = [...new Set(feed.map((g) => (g.first_seen || '').slice(0, 10)).filter(Boolean))];
const lasts = [...new Set(feed.map((g) => (g.last_seen || '').slice(0, 10)).filter(Boolean))];
console.log(
  'Top 3:',
  feed
    .slice(0, 3)
    .map((g) => `${g.screenshot_score} ${g.title}`)
    .join(' | '),
);
console.log(
  `Date spread: ${firsts.length} first_seen days, ${lasts.length} last_seen days; with video_mtime: ${feed.filter((g) => g.video_mtime).length}`,
);
