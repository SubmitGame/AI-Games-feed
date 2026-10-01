/**
 * Map Overheard / Claude-vs-ChatGPT catalog JSON → AI Games Feed card entries.
 * Used at runtime in the browser (raw GitHub is the source of truth).
 */

/** Sole catalog and media source: SubmitGame/Claude-vs-ChatGPT. */
export const CATALOG_SOURCE = {
  name: 'SubmitGame/Claude-vs-ChatGPT',
  catalog:
    'https://raw.githubusercontent.com/SubmitGame/Claude-vs-ChatGPT/main/data/grokgames.json',
  rawBase: 'https://raw.githubusercontent.com/SubmitGame/Claude-vs-ChatGPT/main/',
  proxy: '/catalog-proxy/data/grokgames.json',
};

export const CATALOG_URL = CATALOG_SOURCE.catalog;

/** Media paths always resolve against the SubmitGame catalog repository. */
export let REPO_RAW_BASE = CATALOG_SOURCE.rawBase;

/** Vite-dev proxy for the same SubmitGame catalog when direct fetch fails. */
export const CATALOG_PROXY_URL = CATALOG_SOURCE.proxy;

const MADE_WITH_ALLOWED = new Set(['opus-5.5', 'sonnet-5.5', 'astra']);

const GH_RESERVED = new Set([
  'orgs', 'topics', 'features', 'about', 'pricing', 'login', 'signup',
  'settings', 'explore', 'sponsors', 'marketplace', 'pulls', 'issues',
  'notifications', 'new', 'codespaces', 'copilot', 'apps', 'enterprise',
]);

const X_RESERVED = new Set([
  'i', 'intent', 'share', 'home', 'explore', 'search', 'settings',
  'messages', 'notifications', 'compose', 'login', 'signup',
]);

const TWITTER_EPOCH_MS = 1288834974657n;

/** True for same-origin / relative public paths (e.g. /avatars/foo.png). */
export function isLocalPublicPath(url) {
  if (!url || typeof url !== 'string') return false;
  const u = url.trim();
  if (!u) return false;
  if (u.startsWith('/') && !u.startsWith('//')) return true;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(u)) return true;
  return false;
}

/**
 * Resolve a catalog-relative or absolute-ish path to a raw GitHub URL.
 * Leaves absolute http(s) URLs alone. Maps /workspace/... basenames into
 * screenshots/ or videos/ when the folder is known.
 */
export function resolveRepoAssetUrl(raw, { preferFolder } = {}) {
  if (raw == null || raw === '') return null;
  const s = String(raw).trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return s;
  if (s.startsWith('//')) return `https:${s}`;

  // Detect absolute / Overheard workspace paths BEFORE stripping slashes.
  const looksLocalAbs =
    s.startsWith('/') ||
    /^[A-Za-z]:[\\/]/.test(s) ||
    s.includes('/workspace/') ||
    /(?:^|[/\\])workspace[/\\]/.test(s) ||
    /(?:^|[/\\])opus-games-fresh[/\\]/.test(s);

  let rel;
  if (looksLocalAbs) {
    const base = s.split(/[/\\]/).pop();
    if (!base) return null;
    if (preferFolder) rel = `${preferFolder}/${base}`;
    else if (/\.(mp4|webm|mov)$/i.test(base)) rel = `videos/${base}`;
    else if (/\.(png|jpe?g|webp|gif)$/i.test(base)) rel = `screenshots/${base}`;
    else rel = base;
  } else {
    rel = s.replace(/^\.\//, '').replace(/^\/+/, '');
  }

  rel = rel.replace(/^\/+/, '');
  if (!rel) return null;
  return REPO_RAW_BASE + rel;
}

/** First playable video relative path from catalog game fields. */
export function extractVideoRel(g) {
  if (!g || typeof g !== 'object') return null;

  if (Array.isArray(g.videos) && g.videos.length) {
    for (const item of g.videos) {
      if (typeof item === 'string' && item.trim()) return item.trim().replace(/^\.?\//, '');
      if (item && typeof item === 'object') {
        const p = item.path || item.src || item.url || item.video;
        if (typeof p === 'string' && p.trim()) return p.trim().replace(/^\.?\//, '');
      }
    }
  }

  for (const key of ['video_path', 'video', 'video_url', 'clip', 'clip_path']) {
    const v = g[key];
    if (typeof v === 'string' && v.trim()) {
      const s = v.trim();
      if (/^https?:\/\//i.test(s)) return s;
      return s.replace(/^\.?\//, '');
    }
  }
  return null;
}

export function inferPlatforms(g) {
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

export function inferAuthor(g) {
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

  // Prefer catalog avatar when local/public or absolute http; else GitHub png.
  let avatar_url = null;
  if (g.avatar_url && typeof g.avatar_url === 'string') {
    const a = g.avatar_url.trim();
    if (a) {
      if (/^https?:\/\//i.test(a)) avatar_url = a;
      else if (isLocalPublicPath(a)) avatar_url = a.startsWith('/') ? a : `/${a}`;
      else {
        const resolved = resolveRepoAssetUrl(a, { preferFolder: 'avatars' });
        if (resolved) avatar_url = resolved;
      }
    }
  }
  if (!avatar_url && github_user) {
    avatar_url = `https://github.com/${github_user}.png?size=80`;
  }

  return { author, github_user, x_handle, avatar_url };
}

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

function toIsoTimestamp(raw) {
  if (raw == null || raw === '') return null;
  const s = String(raw).trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return `${s}T00:00:00.000Z`;
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

function toTimedIsoTimestamp(raw) {
  if (raw == null || raw === '') return null;
  const s = String(raw).trim();
  if (!s || !/[T ]\d{2}:\d{2}/.test(s)) return null;
  return toIsoTimestamp(s);
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

export function resolveSeenTimestamps(g) {
  const posted = snowflakeIsoFromUrl(g.source_url);
  const srcPublished = toTimedIsoTimestamp(g.published_at);
  const srcListed = toTimedIsoTimestamp(g.listed_at);
  const srcFirstTimed = toTimedIsoTimestamp(g.first_seen);
  const srcFirst = toIsoTimestamp(g.first_seen);
  const srcLastTimed = toTimedIsoTimestamp(g.last_seen);
  const srcLast = toIsoTimestamp(g.last_seen);

  const published_at = srcPublished || posted || null;
  const listed_at = srcListed || srcFirstTimed || null;
  const first_seen = listed_at || posted || srcFirst || null;
  const last_seen =
    srcLastTimed || maxIso(srcLast, posted, srcFirst) || first_seen;

  return { published_at, listed_at, first_seen, last_seen };
}

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

function passComments(g, entry) {
  if (!Array.isArray(g.comments)) return;
  entry.comments = g.comments;
}

/**
 * Map a raw catalog document to the feed payload shape consumed by main.js.
 * Only games with a playable video + play_url are included.
 */
export function mapCatalogToFeed(data) {
  const gamesIn = Array.isArray(data?.games) ? data.games : [];
  const catalogCount = gamesIn.length;
  const filtered = gamesIn.filter((g) => g?.play_url && String(g.play_url).trim());

  // Dedup by play_url, keep highest screenshot_score
  const byUrl = new Map();
  for (const g of filtered) {
    const url = String(g.play_url).replace(/\/$/, '');
    const score = g.screenshot_score ?? -1;
    const prev = byUrl.get(url);
    if (!prev || (prev.screenshot_score ?? -1) < score) byUrl.set(url, g);
  }

  const unique = [...byUrl.values()].sort(
    (a, b) => (b.screenshot_score ?? -1) - (a.screenshot_score ?? -1),
  );

  const feed = [];
  for (const g of unique) {
    const videoRel = extractVideoRel(g);
    if (!videoRel) continue;

    const video = /^https?:\/\//i.test(videoRel)
      ? videoRel
      : resolveRepoAssetUrl(videoRel, { preferFolder: 'videos' });
    if (!video) continue;

    let screenshot = null;
    let shotRaw = g.screenshot_path || g.screenshot || g.poster || null;
    if (!shotRaw && Array.isArray(g.screenshots) && g.screenshots.length) {
      const first = g.screenshots[0];
      shotRaw = typeof first === 'string' ? first : first?.path;
    }
    if (shotRaw) {
      screenshot = resolveRepoAssetUrl(shotRaw, { preferFolder: 'screenshots' });
    }

    const platforms = inferPlatforms(g);
    const { author, github_user, x_handle, avatar_url } = inferAuthor(g);
    const { published_at, listed_at, first_seen, last_seen } =
      resolveSeenTimestamps(g);

    const madeRaw = String(g.made_with || '').toLowerCase().trim();
    const made_with = MADE_WITH_ALLOWED.has(madeRaw)
      ? madeRaw
      : g.made_with || null;

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
      made_with,
    };
    if (platforms) entry.platforms = platforms;
    if (author) entry.author = author;
    if (github_user) entry.github_user = github_user;
    if (x_handle) entry.x_handle = x_handle;
    if (avatar_url) entry.avatar_url = avatar_url;
    if (typeof g.iframe === 'boolean') entry.iframe = g.iframe;
    passRemoteLikes(g, entry);
    passComments(g, entry);
    feed.push(entry);
  }

  return {
    updated_at: data?.updated_at ?? null,
    catalog_count: catalogCount,
    count: feed.length,
    games: feed,
    source: 'raw-github',
  };
}

/**
 * Fetch the SubmitGame catalog directly, then retry the same catalog through
 * the Vite dev proxy if direct CORS access fails.
 * Uses cache: 'no-cache' so hourly Overheard pushes show up promptly.
 */
export async function fetchCatalogFeed() {
  const errors = [];
  try {
    const res = await fetch(CATALOG_SOURCE.catalog, { cache: 'no-cache', mode: 'cors' });
    if (!res.ok) throw new Error(`HTTP ${res.status} from raw ${CATALOG_SOURCE.name}`);
    const data = await res.json();
    REPO_RAW_BASE = CATALOG_SOURCE.rawBase;
    return { feed: mapCatalogToFeed(data), via: `raw:${CATALOG_SOURCE.name}` };
  } catch (err) {
    errors.push(`raw ${CATALOG_SOURCE.name}: ${err?.message || err}`);
  }

  try {
    const res = await fetch(CATALOG_SOURCE.proxy, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status} from proxy ${CATALOG_SOURCE.name}`);
    const data = await res.json();
    REPO_RAW_BASE = CATALOG_SOURCE.rawBase;
    return { feed: mapCatalogToFeed(data), via: `proxy:${CATALOG_SOURCE.name}` };
  } catch (err) {
    errors.push(`proxy ${CATALOG_SOURCE.name}: ${err?.message || err}`);
  }

  throw new Error(`Catalog fetch failed (${errors.join('; ')})`);
}
