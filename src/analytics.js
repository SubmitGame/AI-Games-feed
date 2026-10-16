/**
 * Lightweight feed analytics → self-hosted Supabase (supabase.omgithub.com).
 * Insert-only with the publishable anon key; the table is unreadable to anon.
 * Every entry point is wrapped so analytics can never throw or block the feed.
 */
import { SUPABASE_URL, ANON_KEY } from './supabase-config.js';

const ENDPOINT = `${SUPABASE_URL}/rest/v1/feed_events`;
const FLUSH_MS = 5000;
const MAX_QUEUE = 200;
const COLS = ['visitor', 'session', 'game_id', 'event', 'value', 'device', 'tag', 'search', 'sort'];

let enabled = false;
let visitor = '';
let session = '';
let device = '';
let sortMode = '';
let queue = [];
let timer = 0;

function rid() {
  try {
    if (crypto.randomUUID) return crypto.randomUUID();
  } catch (_) {}
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function clip(s, n) {
  if (s == null || s === '') return null;
  return String(s).slice(0, n);
}

function init() {
  try {
    const host = location.hostname;
    const debug = new URLSearchParams(location.search).has('debug');
    const local = host === 'localhost' || host === '127.0.0.1' || host === '' || host.endsWith('.local');
    enabled = debug || !local;
    if (!enabled) return;
    try {
      visitor = localStorage.getItem('feed.visitor') || '';
      if (!visitor) {
        visitor = rid();
        localStorage.setItem('feed.visitor', visitor);
      }
    } catch (_) {
      visitor = visitor || rid();
    }
    try {
      session = sessionStorage.getItem('feed.session') || '';
      if (!session) {
        session = rid();
        sessionStorage.setItem('feed.session', session);
      }
    } catch (_) {
      session = session || rid();
    }
    const ua = navigator.userAgent || '';
    device = /iPad|Tablet/i.test(ua)
      ? 'tablet'
      : /Mobi|Android|iPhone|iPod/i.test(ua)
        ? 'mobile'
        : 'desktop';
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        pauseWatch();
        flush();
      } else {
        resumeWatch();
      }
    });
    window.addEventListener('pagehide', () => {
      endWatch();
      flushSearch();
      flush();
    });
  } catch (_) {
    enabled = false;
  }
}

/** Queue an event. Never throws. */
export function track(event, fields = {}) {
  try {
    if (!enabled || !event) return;
    const v = Number(fields.value);
    queue.push({
      visitor: clip(visitor, 40),
      session: clip(session, 40),
      game_id: clip(fields.game_id, 120),
      event,
      value: Number.isFinite(v) ? Math.max(0, Math.min(86400, Math.round(v * 10) / 10)) : null,
      device,
      tag: clip(fields.tag, 60),
      search: clip(fields.search, 100),
      sort: clip(fields.sort ?? sortMode, 16),
    });
    if (queue.length > MAX_QUEUE) queue = queue.slice(-MAX_QUEUE);
    if (!timer) timer = setTimeout(flush, FLUSH_MS);
  } catch (_) {}
}

export function flush() {
  try {
    if (timer) clearTimeout(timer);
    timer = 0;
    if (!queue.length) return;
    // Same key set on every row (PostgREST bulk insert).
    const rows = queue.splice(0, 100).map((r) => {
      const o = {};
      COLS.forEach((c) => (o[c] = r[c] ?? null));
      return o;
    });
    if (queue.length) timer = setTimeout(flush, 1000);
    fetch(ENDPOINT, {
      method: 'POST',
      keepalive: true,
      headers: {
        apikey: ANON_KEY,
        Authorization: `Bearer ${ANON_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify(rows),
    }).catch(() => {});
  } catch (_) {}
}

export function setSort(mode) {
  sortMode = mode || '';
}

/* ---- Watch time per card (wall clock while visible, excluding play overlay) ---- */
let watchId = '';
let watchStart = 0; // 0 = paused
let watchAccum = 0;

export function cardEnter(id) {
  try {
    if (!enabled || !id || id === watchId) return;
    endWatch();
    watchId = id;
    watchAccum = 0;
    watchStart = document.visibilityState === 'hidden' ? 0 : performance.now();
    track('view', { game_id: id });
  } catch (_) {}
}

export function pauseWatch() {
  try {
    if (watchStart) watchAccum += (performance.now() - watchStart) / 1000;
    watchStart = 0;
  } catch (_) {}
}

export function resumeWatch() {
  try {
    if (watchId && !watchStart && document.visibilityState !== 'hidden') watchStart = performance.now();
  } catch (_) {}
}

export function endWatch() {
  try {
    if (!watchId) return;
    pauseWatch();
    track('watch', { game_id: watchId, value: Math.min(watchAccum, 3600) });
    watchId = '';
    watchAccum = 0;
  } catch (_) {}
}

/* ---- Play overlay session length ---- */
let playId = '';
let playStart = 0;

/** Play tap. `overlay` = opened in the in-feed iframe (timed until exit). */
export function playStarted(id, overlay = false) {
  try {
    track('play', { game_id: id });
    if (overlay) {
      playId = id || '';
      playStart = performance.now();
      pauseWatch();
    }
  } catch (_) {}
}

export function playExited() {
  try {
    if (!playStart) return;
    track('exit_play', { game_id: playId, value: (performance.now() - playStart) / 1000 });
    playStart = 0;
    playId = '';
    resumeWatch();
  } catch (_) {}
}

/* ---- Search: debounce live typing into one event ---- */
let searchTimer = 0;
let pendingSearch = null;

function flushSearch() {
  try {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = 0;
    if (pendingSearch && pendingSearch.q) {
      track('search', { search: pendingSearch.q, value: pendingSearch.n });
    }
    pendingSearch = null;
  } catch (_) {}
}

export function trackSearch(q, resultCount) {
  try {
    if (!enabled) return;
    pendingSearch = { q: String(q || '').trim().toLowerCase(), n: resultCount };
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(flushSearch, 1500);
  } catch (_) {}
}

init();
