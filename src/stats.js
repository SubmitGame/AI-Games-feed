import { SUPABASE_URL, ANON_KEY } from './supabase-config.js';
import { fetchCatalogFeed } from './feed-from-catalog.js';

const POLL_MS = 5000;
const $ = (id) => document.getElementById(id);
const titles = new Map();
let prev = {};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmt = (n) => {
  n = Number(n) || 0;
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1e4) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
  return n.toLocaleString();
};
const dur = (s) => {
  s = Math.round(Number(s) || 0);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
};
const gameLink = (id) =>
  `<a href="/?g=${encodeURIComponent(id)}" target="_blank" rel="noopener">${esc(titles.get(id) || id)}</a>`;

function list(el, rows, render) {
  $(el).innerHTML = rows && rows.length
    ? rows.map((r) => `<div class="row">${render(r)}</div>`).join('')
    : '<div class="empty">Nothing yet</div>';
}

function kpi(key, label, value, text) {
  const bump = prev[key] != null && value > prev[key];
  prev[key] = value;
  return `<div class="kpi"><b class="${bump ? 'bump' : ''}">${text ?? fmt(value)}</b><span>${label}</span></div>`;
}

function spark(plays, views) {
  const now = Date.now();
  const start = Math.floor(now / 60000) * 60000 - 59 * 60000;
  const p = new Map(plays.map((r) => [Date.parse(r.m), r.n]));
  const v = new Map(views.map((r) => [Date.parse(r.m), r.n]));
  let max = 1;
  for (let i = 0; i < 60; i++) max = Math.max(max, (p.get(start + i * 60000) || 0) + (v.get(start + i * 60000) || 0));
  let html = '';
  for (let i = 0; i < 60; i++) {
    const t = start + i * 60000;
    const pn = p.get(t) || 0;
    const vn = v.get(t) || 0;
    const label = new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    html += `<div class="col" title="${label}: ${vn} views, ${pn} plays"><div class="v" style="height:${(vn / max) * 100}%"></div><div class="p" style="height:${(pn / max) * 100}%"></div></div>`;
  }
  $('spark').innerHTML = html;
}

function render(d) {
  const t = d.totals_24h || {};
  const plays = (t.play || 0) + (t.play_tab || 0);
  $('kpis').innerHTML = [
    kpi('active', 'active now (5 min)', d.active_5m),
    kpi('v24', 'visitors 24h', d.visitors_24h),
    kpi('v7', 'visitors 7d', d.visitors_7d),
    kpi('views', 'views 24h', t.view || 0),
    kpi('plays', 'plays 24h', plays),
    kpi('watch', 'watch time 24h', d.watch_seconds_24h, dur(d.watch_seconds_24h)),
    kpi('likes', 'likes 24h', t.like || 0),
    kpi('shares', 'shares 24h', t.share || 0),
    kpi('dl', 'downloads 24h', t.download || 0),
    kpi('search', 'searches 24h', t.search || 0),
  ].join('');
  spark(d.plays_per_min || [], d.views_per_min || []);
  const top = (r) => `<span class="name">${gameLink(r.game_id)}</span><span class="num"><b>${fmt(r.plays)}</b> plays · ${dur(r.watch)} · ${fmt(r.views)} views</span>`;
  list('top24', d.top_24h, top);
  list('top7', d.top_7d, top);
  list('skips', d.quick_skips_24h, (r) => `<span class="name">${gameLink(r.game_id)}</span><span class="num"><b>${fmt(r.skips)}</b> / ${fmt(r.watches)} (${Math.round((r.skips / Math.max(1, r.watches)) * 100)}%)</span>`);
  list('zero', d.zero_searches_7d, (r) => `<span class="name">${esc(r.q)}</span><span class="num"><b>${fmt(r.n)}</b>×</span>`);
  list('searches', d.top_searches_7d, (r) => `<span class="name"><a href="/?search=${encodeURIComponent(r.q)}" target="_blank" rel="noopener">${esc(r.q)}</a></span><span class="num"><b>${fmt(r.n)}</b>× · ${fmt(r.results)} results</span>`);
  list('tags', d.top_tags_7d, (r) => `<span class="name"><a href="/?tag=${encodeURIComponent(r.tag)}" target="_blank" rel="noopener">${esc(r.tag)}</a></span><span class="num"><b>${fmt(r.n)}</b> taps</span>`);
  list('daily', (d.daily_30d || []).slice().reverse(), (r) => `<span class="name">${esc(new Date(r.d).toLocaleDateString([], { month: 'short', day: 'numeric' }))}</span><span class="num"><b>${fmt(r.views)}</b> views · <b>${fmt(r.plays)}</b> plays</span>`);
}

let busy = false;
async function poll() {
  if (busy || document.visibilityState === 'hidden') return;
  busy = true;
  const live = $('live');
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/feed_stats`, {
      method: 'POST',
      headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}`, 'Content-Type': 'application/json' },
      body: '{}',
      cache: 'no-store',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    render(await res.json());
    live.className = 'live ok';
    $('liveText').textContent = `live · ${new Date().toLocaleTimeString()}`;
  } catch (err) {
    live.className = 'live err';
    $('liveText').textContent = `offline (${err.message || err})`;
  } finally {
    busy = false;
  }
}

fetchCatalogFeed()
  .then(({ feed }) => {
    const arr = Array.isArray(feed) ? feed : feed?.games || [];
    arr.forEach((g) => g?.id && titles.set(g.id, g.title || g.id));
    poll();
  })
  .catch(() => {});
poll();
setInterval(poll, POLL_MS);
document.addEventListener('visibilitychange', poll);
