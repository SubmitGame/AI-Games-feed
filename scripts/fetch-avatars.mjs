#!/usr/bin/env node
/**
 * Download author avatars into public/avatars/ for feed games.
 * Prefer unavatar.io/x/<handle> for X; github.com/<user>.png for GitHub-only.
 * Does not overwrite existing non-empty files unless --force.
 *
 * Usage: node scripts/fetch-avatars.mjs [--force]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const AVATARS = path.join(root, 'public', 'avatars');
const GAMES = path.join(root, 'public', 'games.json');
const force = process.argv.includes('--force');

fs.mkdirSync(AVATARS, { recursive: true });

const data = JSON.parse(fs.readFileSync(GAMES, 'utf8'));
const games = Array.isArray(data.games) ? data.games : [];

const X_RESERVED = new Set([
  'i', 'intent', 'share', 'home', 'explore', 'search', 'settings',
  'messages', 'notifications', 'compose', 'login', 'signup',
]);

function existingFor(base) {
  const exts = ['png', 'jpg', 'jpeg', 'webp'];
  const variants = [base, base.toLowerCase()];
  for (const v of variants) {
    for (const ext of exts) {
      const p = path.join(AVATARS, `${v}.${ext}`);
      if (fs.existsSync(p) && fs.statSync(p).size > 100) return p;
    }
  }
  // case-insensitive scan
  const lower = base.toLowerCase();
  for (const name of fs.readdirSync(AVATARS)) {
    const m = name.match(/^(.+)\.(png|jpe?g|webp)$/i);
    if (m && m[1].toLowerCase() === lower && fs.statSync(path.join(AVATARS, name)).size > 100) {
      return path.join(AVATARS, name);
    }
  }
  return null;
}

function isJpeg(buf) {
  return buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
}
function isPng(buf) {
  return (
    buf.length > 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47
  );
}
function isWebp(buf) {
  return (
    buf.length > 12 &&
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  );
}

async function download(url, timeoutMs = 20000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'opus-feed-avatar-fetch/1.0',
        Accept: 'image/*,*/*',
      },
      redirect: 'follow',
    });
    if (!res.ok) return { ok: false, status: res.status };
    const ab = await res.arrayBuffer();
    const buf = Buffer.from(ab);
    return { ok: true, buf, status: res.status, type: res.headers.get('content-type') || '' };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  } finally {
    clearTimeout(t);
  }
}

function pickExt(buf, contentType) {
  if (isJpeg(buf) || /jpeg|jpg/i.test(contentType)) return 'jpg';
  if (isPng(buf) || /png/i.test(contentType)) return 'png';
  if (isWebp(buf) || /webp/i.test(contentType)) return 'webp';
  return null;
}

const xHandles = new Set();
const ghUsers = new Set();
for (const g of games) {
  const xh = String(g.x_handle || '').replace(/^@/, '').trim();
  if (/^[A-Za-z0-9_]{1,15}$/.test(xh) && !X_RESERVED.has(xh.toLowerCase())) {
    xHandles.add(xh);
  }
  // also parse source_url
  const src = String(g.source_url || '');
  const xm = src.match(/(?:x\.com|twitter\.com)\/([A-Za-z0-9_]{1,15})(?:\/|$|\?|#)/i);
  if (xm && !X_RESERVED.has(xm[1].toLowerCase())) xHandles.add(xm[1]);

  const gh = String(g.github_user || '').replace(/^@/, '').trim();
  if (/^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/.test(gh)) {
    ghUsers.add(gh);
  }
}

let ok = 0;
let skip = 0;
let fail = 0;
const results = [];

async function saveAs(base, buf, contentType) {
  const ext = pickExt(buf, contentType);
  if (!ext || buf.length < 200) return { saved: false, reason: 'bad-image' };
  const dest = path.join(AVATARS, `${base}.${ext}`);
  fs.writeFileSync(dest, buf);
  return { saved: true, path: dest, bytes: buf.length };
}

// X handles via unavatar
for (const handle of [...xHandles].sort((a, b) => a.localeCompare(b))) {
  const existing = existingFor(handle);
  if (existing && !force) {
    skip++;
    results.push({ handle, kind: 'x', status: 'skip', file: path.basename(existing) });
    continue;
  }
  const urls = [
    `https://unavatar.io/x/${encodeURIComponent(handle)}`,
    `https://unavatar.io/twitter/${encodeURIComponent(handle)}`,
  ];
  let saved = false;
  let lastErr = '';
  for (const url of urls) {
    const r = await download(url);
    if (!r.ok) {
      lastErr = r.error || `HTTP ${r.status}`;
      continue;
    }
    const out = await saveAs(handle, r.buf, r.type);
    if (out.saved) {
      ok++;
      saved = true;
      results.push({ handle, kind: 'x', status: 'ok', file: path.basename(out.path), bytes: out.bytes, via: url });
      break;
    }
    lastErr = out.reason || 'bad-image';
  }
  if (!saved) {
    fail++;
    results.push({ handle, kind: 'x', status: 'fail', error: lastErr });
  }
  // gentle pacing
  await new Promise((r) => setTimeout(r, 120));
}

// GitHub-only (or also cache github users under their gh name if missing)
for (const user of [...ghUsers].sort((a, b) => a.localeCompare(b))) {
  const existing = existingFor(user);
  if (existing && !force) {
    // already counted as skip if also an x handle; only note if purely gh
    if (![...xHandles].some((h) => h.toLowerCase() === user.toLowerCase())) {
      skip++;
      results.push({ handle: user, kind: 'gh', status: 'skip', file: path.basename(existing) });
    }
    continue;
  }
  // Skip if we already just saved under an x handle that matches? still save under gh name for findLocalAvatarFile(github_user)
  const url = `https://github.com/${encodeURIComponent(user)}.png?size=80`;
  const r = await download(url);
  if (!r.ok) {
    fail++;
    results.push({ handle: user, kind: 'gh', status: 'fail', error: r.error || `HTTP ${r.status}` });
    continue;
  }
  const out = await saveAs(user, r.buf, r.type);
  if (out.saved) {
    ok++;
    results.push({ handle: user, kind: 'gh', status: 'ok', file: path.basename(out.path), bytes: out.bytes });
  } else {
    fail++;
    results.push({ handle: user, kind: 'gh', status: 'fail', error: out.reason });
  }
  await new Promise((r) => setTimeout(r, 80));
}

const files = fs
  .readdirSync(AVATARS)
  .filter((n) => /\.(png|jpe?g|webp)$/i.test(n) && fs.statSync(path.join(AVATARS, n)).size > 100);

console.log(JSON.stringify({ downloaded: ok, skipped: skip, failed: fail, cached_files: files.length }, null, 2));
for (const row of results) {
  if (row.status === 'fail') console.log('FAIL', row.handle, row.kind, row.error);
  else if (row.status === 'ok') console.log('OK  ', row.handle, row.kind, row.file, row.bytes);
}
const lex = files.find((f) => f.toLowerCase().startsWith('lexnlin.'));
console.log('LexnLin file:', lex || 'MISSING');
