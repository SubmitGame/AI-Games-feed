#!/usr/bin/env node
/**
 * Best-effort backfill of remote_likes + likes_source into /workspace/grokgames.json.
 * Prefer X post like count (via fxtwitter / syndication); else GitHub stargazers_count.
 *
 * Usage: node scripts/backfill-likes.mjs [--force]
 *   --force  overwrite existing remote_likes
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = '/workspace/grokgames.json';
const force = process.argv.includes('--force');
const CONCURRENCY = 6;
const UA = 'Mozilla/5.0 (compatible; opus-feed-likes/1.0)';

const GH_RESERVED = new Set([
  'orgs', 'topics', 'features', 'about', 'pricing', 'login', 'signup',
  'settings', 'explore', 'sponsors', 'marketplace', 'pulls', 'issues',
  'notifications', 'new', 'codespaces', 'copilot', 'apps', 'enterprise',
]);

const data = JSON.parse(fs.readFileSync(SRC, 'utf8'));
const games = Array.isArray(data.games) ? data.games : [];

function tweetIdFromUrl(url) {
  if (!url) return null;
  const m = String(url).match(/(?:x\.com|twitter\.com)\/[^/?#]+\/status\/(\d+)/i);
  return m ? m[1] : null;
}

function githubRepoFromUrl(url) {
  if (!url) return null;
  const m = String(url).match(
    /github\.com\/([A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38})\/([A-Za-z0-9._-]+)/i,
  );
  if (!m) return null;
  const owner = m[1];
  let repo = m[2].replace(/\.git$/i, '');
  if (GH_RESERVED.has(owner.toLowerCase())) return null;
  if (/^(issues|pulls|actions|wiki|settings|tree|blob|releases|commit|commits|projects|security|pulse|graphs|network)$/i.test(repo)) {
    return null;
  }
  return `${owner}/${repo}`;
}

function githubRepoFromPlay(play) {
  if (!play) return null;
  const m = String(play).match(
    /https?:\/\/([A-Za-z0-9-]+)\.github\.io\/([^/?#]+)/i,
  );
  if (!m) return null;
  const owner = m[1];
  const repo = m[2];
  if (GH_RESERVED.has(owner.toLowerCase())) return null;
  return `${owner}/${repo}`;
}

async function fetchJson(url, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { Accept: 'application/json', 'User-Agent': UA },
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

async function fetchXLikes(tweetId) {
  // 1) fxtwitter (stable public mirror)
  try {
    const d = await fetchJson(`https://api.fxtwitter.com/status/${tweetId}`);
    const likes = d?.tweet?.likes ?? d?.tweet?.like_count ?? d?.likes;
    const n = Number(likes);
    if (Number.isFinite(n) && n >= 0) return Math.floor(n);
  } catch (_) {}

  // 2) syndication CDN
  try {
    const d = await fetchJson(
      `https://cdn.syndication.twimg.com/tweet-result?id=${tweetId}&lang=en&token=1`,
    );
    const n = Number(d?.favorite_count ?? d?.favoriteCount);
    if (Number.isFinite(n) && n >= 0) return Math.floor(n);
  } catch (_) {}

  return null;
}

const starCache = new Map();

function fetchGithubStars(repo) {
  if (starCache.has(repo)) return starCache.get(repo);
  const result = spawnSync(
    'gh',
    ['api', `repos/${repo}`, '--jq', '.stargazers_count'],
    { encoding: 'utf8', timeout: 20000 },
  );
  if (result.status !== 0) {
    starCache.set(repo, null);
    return null;
  }
  const n = Number(String(result.stdout || '').trim());
  const val = Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
  starCache.set(repo, val);
  return val;
}

async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return out;
}

const needs = [];
for (const g of games) {
  if (!force && g.remote_likes != null && g.remote_likes !== '') continue;
  const tid = tweetIdFromUrl(g.source_url);
  const repo =
    githubRepoFromUrl(g.source_url) ||
    githubRepoFromUrl(g.play_url) ||
    githubRepoFromPlay(g.play_url);
  if (tid || repo) needs.push({ g, tid, repo });
}

console.log(
  `Backfilling likes for ${needs.length}/${games.length} games (force=${force})…`,
);

let fromX = 0;
let fromGh = 0;
let nonzero = 0;
let failed = 0;
let skipped = 0;

await mapPool(needs, CONCURRENCY, async ({ g, tid, repo }) => {
  try {
    if (tid) {
      const likes = await fetchXLikes(tid);
      if (likes != null) {
        g.remote_likes = likes;
        g.likes_source = 'x';
        fromX++;
        if (likes > 0) nonzero++;
        return;
      }
    }
    if (repo) {
      const stars = fetchGithubStars(repo);
      if (stars != null) {
        g.remote_likes = stars;
        g.likes_source = 'github';
        fromGh++;
        if (stars > 0) nonzero++;
        return;
      }
    }
    failed++;
  } catch (err) {
    failed++;
    console.warn(`skip ${g.id}: ${err.message || err}`);
  }
});

// Games that already had likes (not force) still count toward totals for reporting
if (!force) {
  for (const g of games) {
    if (g.remote_likes == null || g.remote_likes === '') {
      skipped++;
      continue;
    }
  }
}

fs.writeFileSync(SRC, JSON.stringify(data, null, 2) + '\n');

const withLikes = games.filter((g) => g.remote_likes != null && g.remote_likes !== '').length;
const withNonZero = games.filter((g) => Number(g.remote_likes) > 0).length;

console.log(
  `Done. wrote ${SRC}\n` +
    `  fetched X: ${fromX}, GitHub: ${fromGh}, failed: ${failed}\n` +
    `  catalog with remote_likes: ${withLikes}, non-zero: ${withNonZero}`,
);

// Sample targets
for (const id of ['last-train-to-the-sea', 'silt-signal']) {
  const g = games.find((x) => x.id === id);
  if (g) {
    console.log(
      `  sample ${id}: remote_likes=${g.remote_likes} source=${g.likes_source} url=${g.source_url}`,
    );
  }
}
