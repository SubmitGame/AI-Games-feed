import {
  fetchCatalogFeed,
  REPO_RAW_BASE,
} from './feed-from-catalog.js';

const feedEl = document.getElementById('feed');
const countEl = document.getElementById('count');
const hintEl = document.getElementById('hint');
const sortEl = document.getElementById('sort');
const mobileFilterEl = document.getElementById('mobileFilter');
const toastEl = document.getElementById('toast');
const commentsSheetEl = document.getElementById('commentsSheet');
const commentsListEl = document.getElementById('commentsList');
const commentsTitleEl = document.getElementById('commentsTitle');
const playOverlayEl = document.getElementById('playOverlay');
const playFrameEl = document.getElementById('playFrame');

const SORT_KEY = 'opus-feed-sort';
const MOBILE_KEY = 'opus-feed-mobile-only';
const LAST_ID_KEY = 'opus-feed-last-id';
const LIKES_KEY = 'opus-feed-likes';
const SEEN_KEY = 'opus-feed-seen';
const FIT_KEY = 'opus-feed-fit-mode';
const SORT_TOP = 'top';
const SORT_NEW = 'new';
/** Cover = old cropped full-bleed; letterbox = contain + blurred bg fill. */
const FIT_COVER = 'cover';
const FIT_LETTERBOX = 'letterbox';
const PUBLIC_SITE_ORIGIN = 'https://games.omgithub.com';

/** Max videos with src attached (current + ahead). */
const PRELOAD_WINDOW = 5;
/** Play destinations to warm for the active card and the next card. */
const PLAY_NAV_PRELOAD_WINDOW = 2;
/** Seconds of buffer before advancing the preload chain. */
const BUFFER_AHEAD_SEC = 2.5;
/**
 * Short clips (duration < this) loop until cumulative watch on the card
 * reaches this many seconds, then auto-advance. Longer clips advance on
 * first natural `ended`.
 */
const MIN_WATCH_BEFORE_ADVANCE = 10;

let allGames = [];
let catalogCount = 0;
let keyboardWired = false;
let scrollHintWired = false;
let hintHidden = false;
let activeIndex = 0;
let scrollRaf = 0;
/** Highest index currently allowed to hold a src (pipeline tip). */
let pipelineTip = -1;
const videoListeners = new WeakMap();
let toastTimer = 0;
/** Skip URL/position writes during programmatic restore scroll. */
let restoring = false;
/** Skip history pushes while applying a back/forward navigation. */
let historySilent = false;
/** True after the landing game replaces the current history entry. */
let feedHistorySeeded = false;
/** Ignore the fullscreen exit we started ourselves. */
let fullscreenExitFromUs = false;
/** Cumulative seconds watched on the current card (short-clip looping). */
let watchAccumSec = 0;
/** Game id that watchAccumSec belongs to. */
let accumGameId = null;
/** Suppress auto-advance once (e.g. after Play opens external). */
let autoAdvancePaused = false;
/** User's audio preference; first load defaults to muted like Instagram/TikTok. */
let mutedPreference = true;
/** Temporary mute used only when the browser rejects autoplay with sound. */
let autoplayFallbackMuted = false;
let userGestureUnlocked = false;
let gestureWired = false;
/** Comments bottom sheet open — pause auto-advance / feed scroll. */
let commentsOpen = false;
/** Fullscreen iframe Play overlay open — pause video / auto-advance. */
let playOverlayOpen = false;
let commentsSwipeStartY = null;
let commentsSwipeCurrentY = 0;
let commentsSwipeActive = false;
/** Play origins/URLs already given navigation hints during this page session. */
const warmedPlayOrigins = new Set();
const warmedPlayUrls = new Set();

function escapeHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function platformLabel(platforms) {
  if (!Array.isArray(platforms) || !platforms.length) return '';
  const set = new Set(platforms.map((p) => String(p).toLowerCase()));
  const mobile = set.has('mobile') || set.has('touch') || set.has('phone');
  const pc = set.has('pc') || set.has('desktop');
  if (mobile && pc) return 'Mobile · PC';
  if (mobile) return 'Mobile';
  if (pc) return 'PC';
  return '';
}

function scoreLabel(score) {
  if (score == null || Number.isNaN(Number(score))) return '—';
  return Number(score).toFixed(1);
}

function readSortMode() {
  try {
    const v = localStorage.getItem(SORT_KEY);
    if (v === SORT_NEW || v === SORT_TOP) return v;
  } catch (_) {}
  // Top is the default when nothing is saved.
  return SORT_TOP;
}

function writeSortMode(mode) {
  try {
    localStorage.setItem(SORT_KEY, mode);
  } catch (_) {}
}

function readMobileOnly() {
  try {
    return localStorage.getItem(MOBILE_KEY) === '1';
  } catch (_) {
    return false;
  }
}

function readFitMode() {
  try {
    const v = localStorage.getItem(FIT_KEY);
    if (v === FIT_COVER || v === FIT_LETTERBOX) return v;
  } catch (_) {}
  // Default: old cropped cover. Letterbox only after the user opts in.
  return FIT_COVER;
}

function writeFitMode(mode) {
  try {
    localStorage.setItem(FIT_KEY, mode);
  } catch (_) {}
}

function letterboxFitEnabled() {
  return readFitMode() === FIT_LETTERBOX;
}

function syncFitToggleTitle() {
  const logo = document.querySelector('.logo');
  if (!logo) return;
  const mode = readFitMode();
  logo.setAttribute(
    'aria-label',
    mode === FIT_LETTERBOX
      ? 'AI Games Feed — full frame mode. Tap for cropped cover.'
      : 'AI Games Feed — cropped cover mode. Tap for full frame.',
  );
}

/** Ignore duplicate toggles from the same gesture (stacked listeners / echo events). */
let lastFitToggleAt = 0;
const FIT_TOGGLE_COOLDOWN_MS = 500;

/** Toggle cover ↔ letterbox and re-apply active card letterbox state. */
function toggleFitMode() {
  const now = Date.now();
  if (now - lastFitToggleAt < FIT_TOGGLE_COOLDOWN_MS) {
    return readFitMode();
  }
  lastFitToggleAt = now;
  const next = letterboxFitEnabled() ? FIT_COVER : FIT_LETTERBOX;
  writeFitMode(next);
  syncFitToggleTitle();
  syncAllLetterbox();
  return next;
}

function effectiveMuted() {
  return mutedPreference || autoplayFallbackMuted;
}

function syncMuteControls() {
  const muted = effectiveMuted();
  cards().forEach((card) => {
    const button = card.querySelector('.mute-control');
    if (!button) return;
    button.setAttribute('aria-pressed', muted ? 'true' : 'false');
    button.setAttribute('aria-label', muted ? 'Unmute video' : 'Mute video');
    button.title = muted ? 'Unmute video' : 'Mute video';
  });
}

function applyMuteState() {
  const muted = effectiveMuted();
  cards().forEach((card) => {
    const video = videoOf(card);
    if (video) video.muted = muted;
  });
  syncMuteControls();
}

function setMutedPreference(muted) {
  mutedPreference = Boolean(muted);
  autoplayFallbackMuted = false;
  userGestureUnlocked = true;
  applyMuteState();
  if (!mutedPreference) {
    const video = videoOf(cards()[activeIndex]);
    if (video) tryPlay(video);
  }
}

function unlockAudioOnGesture() {
  if (userGestureUnlocked) return;
  userGestureUnlocked = true;
  if (autoplayFallbackMuted && !mutedPreference) {
    autoplayFallbackMuted = false;
    applyMuteState();
    const video = videoOf(cards()[activeIndex]);
    if (video) tryPlay(video);
  } else {
    syncMuteControls();
  }
  ['pointerdown', 'touchstart', 'wheel', 'keydown'].forEach((event) => {
    document.removeEventListener(event, unlockAudioOnGesture, true);
  });
}

function wireAudioGesture() {
  if (gestureWired) return;
  gestureWired = true;
  ['pointerdown', 'touchstart', 'wheel', 'keydown'].forEach((event) => {
    document.addEventListener(event, unlockAudioOnGesture, { capture: true, passive: true });
  });
}

function writeMobileOnly(on) {
  try {
    localStorage.setItem(MOBILE_KEY, on ? '1' : '0');
  } catch (_) {}
}

function readLastId() {
  try {
    return localStorage.getItem(LAST_ID_KEY) || '';
  } catch (_) {
    return '';
  }
}

function writeLastId(id) {
  if (!id) return;
  try {
    localStorage.setItem(LAST_ID_KEY, id);
  } catch (_) {}
}

function readLikes() {
  try {
    const raw = localStorage.getItem(LIKES_KEY);
    if (!raw) return {};
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' ? obj : {};
  } catch (_) {
    return {};
  }
}

function writeLikes(map) {
  try {
    localStorage.setItem(LIKES_KEY, JSON.stringify(map));
  } catch (_) {}
}

function isLiked(id) {
  return Boolean(readLikes()[id]);
}

function toggleLike(id) {
  const map = readLikes();
  if (map[id]) delete map[id];
  else map[id] = true;
  writeLikes(map);
  return Boolean(map[id]);
}

function likeCount() {
  return Object.keys(readLikes()).length;
}

function readSeen() {
  try {
    const raw = localStorage.getItem(SEEN_KEY);
    if (!raw) return {};
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' ? obj : {};
  } catch (_) {
    return {};
  }
}

function writeSeen(map) {
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify(map));
  } catch (_) {}
}

function markSeen(id) {
  if (!id) return;
  const map = readSeen();
  if (map[id]) return;
  map[id] = Date.now();
  writeSeen(map);
}

function resetWatchAccum(id) {
  watchAccumSec = 0;
  accumGameId = id || null;
  autoAdvancePaused = false;
}

/**
 * Pick one resume target from the current Top/New + Mobile list. A valid deep
 * link wins; otherwise refresh resumes from the saved last id. Keeping this
 * choice in one place makes ordering and landing use the same target.
 */
function resumeIdForGames(games) {
  const hasId = (id) => Boolean(id && games.some((game) => game.id === id));
  const linkedId = deepLinkIdFromUrl();
  if (hasId(linkedId)) return linkedId;
  const lastId = readLastId();
  return hasId(lastId) ? lastId : '';
}

/**
 * After Top/New + Mobile filter: keep the resume id in place, but pull any
 * unseen games that sorted above it to sit immediately after the current
 * card. Seen games above remain above, and an empty seen set follows the
 * same path without special handling.
 */
/**
 * Drop locally viewed games, but keep the card we are landing on so a resume
 * or a shared link does not vanish. Used by New only; Top still shows seen
 * games and only reorders them.
 */
function withoutSeenExcept(games, keepId) {
  const seen = readSeen();
  return games.filter((g) => g.id === keepId || !seen[g.id]);
}

/**
 * Seen games sit above the landing card, oldest first, so scrolling up walks
 * back through watch history (most recently seen is the card just above).
 * Unseen games keep their Top/New order below it.
 */
function orderSeenHistoryAbove(games, anchorId) {
  const seen = readSeen();
  const rest = games.filter((g) => g.id !== anchorId);
  const history = rest
    .filter((g) => seen[g.id])
    .sort((a, b) => (Number(seen[a.id]) || 0) - (Number(seen[b.id]) || 0));
  const upcoming = rest.filter((g) => !seen[g.id]);
  const anchor = games.find((g) => g.id === anchorId);
  if (!anchor) return [...history, ...upcoming];
  return [...history, anchor, ...upcoming];
}

function orderWithUnseenCatchUp(games, resumeId) {
  if (!resumeId || !games.length) return games;
  const idx = games.findIndex((g) => g.id === resumeId);
  if (idx < 0) return games;

  const before = games.slice(0, idx);
  const current = games[idx];
  const after = games.slice(idx + 1);
  const seen = readSeen();
  const unseenAbove = before.filter((g) => !seen[g.id]);
  const seenAbove = before.filter((g) => seen[g.id]);
  if (!unseenAbove.length) return games;
  return [...seenAbove, current, ...unseenAbove, ...after];
}

function parseTs(raw) {
  const t = Date.parse(raw || '');
  return Number.isFinite(t) ? t : 0;
}

/** last_seen, then listing/publication, then video mtime — for helpers. */
function seenTs(game) {
  return parseTs(
    game.last_seen || game.listed_at || game.first_seen || game.published_at || game.video_mtime,
  );
}

/**
 * Sort games.
 * Top: screenshot_score desc.
 * New: last_seen desc → listed_at/first_seen desc → published_at desc →
 * id asc → video_mtime desc → remote_likes desc. Never falls back to score
 * (so New stays distinct when many games share a batch day).
 */
function sortGames(games, mode) {
  const list = games.slice();
  if (mode === SORT_NEW) {
    list.sort((a, b) => {
      const dLast = parseTs(b.last_seen) - parseTs(a.last_seen);
      if (dLast !== 0) return dLast;
      const dListed =
        parseTs(b.listed_at || b.first_seen) -
        parseTs(a.listed_at || a.first_seen);
      if (dListed !== 0) return dListed;
      const dPublished = parseTs(b.published_at) - parseTs(a.published_at);
      if (dPublished !== 0) return dPublished;
      const idCmp = String(a.id || '').localeCompare(String(b.id || ''));
      if (idCmp !== 0) return idCmp;
      const dVm = parseTs(b.video_mtime) - parseTs(a.video_mtime);
      if (dVm !== 0) return dVm;
      return (Number(b.remote_likes) || 0) - (Number(a.remote_likes) || 0);
    });
  } else {
    list.sort((a, b) => (b.screenshot_score ?? -1) - (a.screenshot_score ?? -1));
  }
  return list;
}

/** Strict mobile filter: platforms must include "mobile"; untagged → out. */
function filterGames(games, mobileOnly) {
  if (!mobileOnly) return games;
  return games.filter(
    (g) => Array.isArray(g.platforms) && g.platforms.includes('mobile'),
  );
}

function visibleGames(mode, mobileOnly) {
  return sortGames(filterGames(allGames, mobileOnly), mode);
}

function deepLinkIdFromUrl() {
  try {
    const params = new URLSearchParams(window.location.search);
    return params.get('g') || params.get('game') || '';
  } catch (_) {
    return '';
  }
}

function publicUrlFor(id = '') {
  const current = new URL(window.location.href);
  const u = new URL(PUBLIC_SITE_ORIGIN);
  u.pathname = current.pathname;
  if (id) u.searchParams.set('g', id);
  return u;
}

function shareUrlFor(id) {
  return publicUrlFor(id).toString();
}

function syncCanonicalUrl(id = '') {
  const canonical = document.querySelector('link[rel="canonical"]');
  const ogUrl = document.querySelector('meta[property="og:url"]');
  const url = publicUrlFor(id).toString();
  if (canonical) canonical.href = url;
  if (ogUrl) ogUrl.content = url;
}

function currentGameId() {
  return cards()[activeIndex]?.dataset.id || '';
}

function syncUrlForGame(id) {
  if (!id || restoring || historySilent) return;
  const next = shareUrlFor(id);
  try {
    // Landing card replaces the entry so the first back still leaves the site.
    // Later cards push, so back returns to the previous game.
    if (!feedHistorySeeded) {
      history.replaceState({ g: id }, '', next);
      feedHistorySeeded = true;
    } else if (next !== window.location.href) {
      history.pushState({ g: id }, '', next);
    }
  } catch (_) {
    // Cross-origin history changes are not allowed; sharing still uses next.
  }
  syncCanonicalUrl(id);
}

function pushOverlayHistory(kind) {
  if (historySilent) return;
  const id = currentGameId();
  try {
    history.pushState({ opus: kind, g: id }, '', window.location.href);
  } catch (_) {}
}

function requestGameFullscreen() {
  const el = playFrameEl || playOverlayEl;
  if (!el) return;
  const req = el.requestFullscreen || el.webkitRequestFullscreen;
  if (!req) return;
  try {
    const result = req.call(el);
    if (result && typeof result.catch === 'function') result.catch(() => {});
  } catch (_) {}
}

function exitGameFullscreen() {
  const active = document.fullscreenElement || document.webkitFullscreenElement;
  if (!active) return;
  fullscreenExitFromUs = true;
  const exit = document.exitFullscreen || document.webkitExitFullscreen;
  if (!exit) {
    fullscreenExitFromUs = false;
    return;
  }
  try {
    const result = exit.call(document);
    const clear = () => {
      fullscreenExitFromUs = false;
    };
    if (result && typeof result.then === 'function') result.then(clear, clear);
    else requestAnimationFrame(clear);
  } catch (_) {
    fullscreenExitFromUs = false;
  }
}

function goToGameFromHistory(id) {
  if (!id) return;
  const list = cards();
  let index = -1;
  list.forEach((card, i) => {
    if (index < 0 && card.dataset.id === id) index = i;
  });
  if (index < 0 || index === activeIndex) return;
  historySilent = true;
  try {
    scrollToIndex(index, { smooth: false });
  } finally {
    historySilent = false;
  }
}

/** Back closes the top layer: play, then comments, then the previous game. */
function onHistoryPop() {
  const state = history.state || {};
  if (playOverlayOpen && state.opus !== 'play') closePlayOverlay();
  if (commentsOpen && state.opus !== 'comments' && state.opus !== 'play') {
    closeCommentsSheet();
  }
  if (state.opus) return;
  goToGameFromHistory(state.g || deepLinkIdFromUrl());
}

function dismissPlayOverlay() {
  if (history.state && history.state.opus === 'play') {
    history.back();
    return;
  }
  closePlayOverlay();
}

function dismissCommentsSheet() {
  if (history.state && history.state.opus === 'comments') {
    history.back();
    return;
  }
  closeCommentsSheet();
}

function wireHistoryNavigation() {
  window.addEventListener('popstate', onHistoryPop);
  const onFullscreenEnd = () => {
    const active = document.fullscreenElement || document.webkitFullscreenElement;
    if (active) return;
    if (fullscreenExitFromUs) return;
    if (!playOverlayOpen) return;
    // Leave fullscreen straight to the feed. history.back() alone is often
    // ignored inside this event, which left the in-page iframe on screen.
    const dropPlay = history.state && history.state.opus === 'play';
    closePlayOverlay({ immediate: true });
    if (dropPlay) history.back();
  };
  document.addEventListener('fullscreenchange', onFullscreenEnd);
  document.addEventListener('webkitfullscreenchange', onFullscreenEnd);
}

function cards() {
  return feedEl.querySelectorAll('.card');
}

function endCardEl() {
  return feedEl.querySelector('.end-card');
}

/** The end card is a manual-scroll destination, not a game in the feed. */
function endCardIsActive() {
  const end = endCardEl();
  if (!end || !feedEl.clientHeight) return false;
  return Math.abs(feedEl.scrollTop - end.offsetTop) < feedEl.clientHeight * 0.2;
}

function syncEndCardPlayback() {
  const list = cards();
  const lastVideo = videoOf(list[list.length - 1]);
  if (!lastVideo || activeIndex !== list.length - 1) return;

  if (endCardIsActive()) {
    lastVideo.pause();
    return;
  }

  if (lastVideo.ended) {
    try {
      lastVideo.currentTime = 0;
    } catch (_) {}
  }
  if (canStartPlayback(lastVideo)) tryPlay(lastVideo);
}

function videoOf(card) {
  return card?.querySelector('video.clip');
}

function posterOf(card) {
  return card?.querySelector('.poster');
}

function clipBgOf(card) {
  return card?.querySelector('video.clip-bg');
}

/** Block Chrome's native video long-press menu on feed clips only. */
function suppressVideoContextMenu(el) {
  if (!el || el.__ctxMenuSuppressed) return;
  el.__ctxMenuSuppressed = true;
  el.addEventListener(
    'contextmenu',
    (e) => {
      e.preventDefault();
      e.stopPropagation();
    },
    { capture: true },
  );
}

/** True when contain would not letterbox (portrait clip on phone, landscape in wide window). */
function clipFillsCard(video, card) {
  const vw = video?.videoWidth || 0;
  const vh = video?.videoHeight || 0;
  if (!vw || !vh) return true;
  const cw = card?.clientWidth || 0;
  const ch = card?.clientHeight || 0;
  if (!cw || !ch) return true;
  // Wider than the card → contain leaves bars; use letterbox + blur fill.
  return vw / vh <= cw / ch + 0.02;
}

function ensureClipBg(card) {
  let bg = clipBgOf(card);
  if (bg) {
    suppressVideoContextMenu(bg);
    return bg;
  }
  const video = videoOf(card);
  if (!video) return null;
  bg = document.createElement('video');
  bg.className = 'clip-bg';
  bg.muted = true;
  bg.defaultMuted = true;
  bg.playsInline = true;
  bg.setAttribute('playsinline', '');
  bg.setAttribute('webkit-playsinline', '');
  bg.setAttribute('muted', '');
  bg.preload = 'auto';
  bg.disablePictureInPicture = true;
  bg.setAttribute('aria-hidden', 'true');
  bg.tabIndex = -1;
  card.insertBefore(bg, card.firstChild);
  suppressVideoContextMenu(bg);
  return bg;
}

function teardownClipBg(card) {
  if (!card) return;
  const bg = clipBgOf(card);
  card.classList.remove('bg-ready');
  if (!bg) return;
  try {
    bg.pause();
  } catch (_) {}
  bg.removeAttribute('src');
  try {
    bg.load();
  } catch (_) {}
  bg.remove();
}

function syncBgPlayback(card) {
  const video = videoOf(card);
  const bg = clipBgOf(card);
  if (!video || !bg || !card.classList.contains('letterbox')) return;
  bg.muted = true;
  try {
    const vt = video.currentTime || 0;
    if (Math.abs((bg.currentTime || 0) - vt) > 0.3) bg.currentTime = vt;
  } catch (_) {}
  if (!video.paused && !video.ended) {
    const p = bg.play();
    if (p?.catch) p.catch(() => {});
  } else {
    try {
      bg.pause();
    } catch (_) {}
  }
}

function markBgReady(card) {
  const bg = clipBgOf(card);
  if (!bg || !card.classList.contains('letterbox')) return;
  if (bg.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
  card.classList.add('bg-ready');
  const poster = posterOf(card);
  if (poster && card.classList.contains('video-ready')) {
    poster.classList.add('hidden');
  }
  syncBgPlayback(card);
}

/**
 * Active card only: if the clip is wider than the card, contain the foreground
 * and play one blurred cover copy behind it. Inactive cards stay cover-only.
 */
function syncLetterbox(card, isActive) {
  if (!card) return;
  const video = videoOf(card);
  // Old portrait cover mode: never letterbox / blur fill.
  if (!letterboxFitEnabled() || !isActive || !video) {
    card.classList.remove('letterbox');
    teardownClipBg(card);
    return;
  }
  if (!video.videoWidth || !video.videoHeight) {
    // Metadata not ready yet — keep current mode until loadedmetadata.
    return;
  }
  if (clipFillsCard(video, card)) {
    card.classList.remove('letterbox');
    teardownClipBg(card);
    return;
  }

  card.classList.add('letterbox');
  const bg = ensureClipBg(card);
  if (!bg) return;
  const url = video.getAttribute('src') || video.dataset.src || '';
  if (url && bg.getAttribute('src') !== url) {
    bg.src = url;
    try {
      bg.load();
    } catch (_) {}
  }
  const onReady = () => markBgReady(card);
  bg.addEventListener('loadeddata', onReady);
  bg.addEventListener('canplay', onReady);
  markBgReady(card);
  syncBgPlayback(card);
}

function syncAllLetterbox() {
  const list = cards();
  list.forEach((card, i) => {
    syncLetterbox(card, i === activeIndex);
  });
}

function bufferedAhead(video) {
  if (!video || !video.buffered || video.buffered.length === 0) return 0;
  try {
    const t = video.currentTime || 0;
    for (let i = 0; i < video.buffered.length; i++) {
      const start = video.buffered.start(i);
      const end = video.buffered.end(i);
      if (t >= start - 0.05 && t <= end + 0.05) return Math.max(0, end - t);
      if (start > t) return 0;
    }
    const last = video.buffered.end(video.buffered.length - 1);
    return Math.max(0, last - t);
  } catch (_) {
    return 0;
  }
}

function hasEnoughBuffer(video) {
  if (!video) return false;
  if (video.readyState >= HTMLMediaElement.HAVE_ENOUGH_DATA) return true;
  if (video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA && bufferedAhead(video) >= BUFFER_AHEAD_SEC) {
    return true;
  }
  return bufferedAhead(video) >= BUFFER_AHEAD_SEC;
}

function canStartPlayback(video) {
  return video && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA;
}

function isPlaying(video) {
  return Boolean(video && !video.paused && !video.ended && video.readyState > 2);
}

function setPosterVisible(card, visible) {
  if (!card) return;
  card.classList.toggle('video-ready', !visible);
  const poster = posterOf(card);
  if (!poster) return;
  // Letterbox: keep poster as blurred cover fill until the bg clip is ready.
  const keepAsFill =
    !visible &&
    card.classList.contains('letterbox') &&
    !card.classList.contains('bg-ready');
  poster.classList.toggle('hidden', !visible && !keepAsFill);
}

function attachSrc(video) {
  if (!video) return;
  video.muted = effectiveMuted();
  const url = video.dataset.src;
  if (!url) return;
  if (video.getAttribute('src') === url) return;
  video.preload = 'auto';
  video.src = url;
  try {
    video.load();
  } catch (_) {}
}

function detachSrc(video) {
  if (!video) return;
  if (!video.getAttribute('src') && !video.src) return;
  video.pause();
  video.removeAttribute('src');
  video.preload = 'none';
  try {
    video.load();
  } catch (_) {}
  const card = video.closest('.card');
  if (card) {
    card.classList.remove('letterbox');
    teardownClipBg(card);
  }
  setPosterVisible(card, true);
}

function tryPlay(video) {
  if (!video) return;
  video.muted = effectiveMuted();
  const p = video.play();
  if (p?.catch) {
    p.catch(() => {
      // Prefer sound, but retry muted when autoplay policy blocks it. Do not
      // persist this temporary fallback: the first gesture restores audio.
      const card = video.closest('.card');
      const isActive = Number(card?.dataset.index) === activeIndex;
      if (!isActive || mutedPreference || userGestureUnlocked || autoplayFallbackMuted) return;
      autoplayFallbackMuted = true;
      applyMuteState();
      const retry = video.play();
      if (retry?.catch) retry.catch(() => {});
    });
  }
}

function onVideoPlaying(video) {
  const card = video.closest('.card');
  const isActive = Number(card?.dataset.index) === activeIndex;
  syncLetterbox(card, isActive);
  setPosterVisible(card, false);
  if (isActive) syncBgPlayback(card);
  maybeAdvancePipeline();
}

function onVideoCanPlay(video) {
  const card = video.closest('.card');
  const idx = Number(card?.dataset.index);
  if (idx === activeIndex) tryPlay(video);
  maybeAdvancePipeline();
}

function onVideoProgress(video) {
  maybeAdvancePipeline();
}

function onVideoEnded(video) {
  const card = video.closest('.card');
  const idx = Number(card?.dataset.index);
  if (idx !== activeIndex) return;
  if (document.visibilityState === 'hidden') return;
  if (commentsOpen || playOverlayOpen || autoAdvancePaused) return;
  if (video.paused && !video.ended) return;

  const dur = Number(video.duration);
  const finite = Number.isFinite(dur) && dur > 0;

  // Long enough (or unknown): advance on first natural end.
  if (!finite || dur >= MIN_WATCH_BEFORE_ADVANCE) {
    advanceToNext();
    return;
  }

  // Short clip: loop until cumulative watch ≥ threshold.
  const id = card?.dataset.id || accumGameId;
  if (accumGameId !== id) {
    resetWatchAccum(id);
  }
  watchAccumSec += dur;
  if (watchAccumSec >= MIN_WATCH_BEFORE_ADVANCE) {
    advanceToNext();
    return;
  }
  try {
    video.currentTime = 0;
  } catch (_) {}
  tryPlay(video);
}

function advanceToNext() {
  if (document.visibilityState === 'hidden') return;
  if (commentsOpen || playOverlayOpen || autoAdvancePaused) return;
  const list = cards();
  const next = activeIndex + 1;
  if (next >= list.length) {
    // Stop on the last game. The end card is intentionally manual-scroll only.
    return;
  }
  scrollToIndex(next, { smooth: true });
}

function wireVideo(video) {
  if (!video || videoListeners.has(video)) return;
  video.muted = effectiveMuted();
  const onPlaying = () => onVideoPlaying(video);
  const onCanPlay = () => onVideoCanPlay(video);
  const onProgress = () => onVideoProgress(video);
  const onEnded = () => onVideoEnded(video);
  const onMeta = () => {
    const card = video.closest('.card');
    if (!card) return;
    syncLetterbox(card, Number(card.dataset.index) === activeIndex);
  };
  const onTimeUpdate = () => {
    const card = video.closest('.card');
    if (card && Number(card.dataset.index) === activeIndex) syncBgPlayback(card);
  };
  const onWaiting = () => {
    const card = video.closest('.card');
    if (card && Number(card.dataset.index) === activeIndex && video.readyState < 2) {
      setPosterVisible(card, true);
    }
  };
  video.addEventListener('playing', onPlaying);
  video.addEventListener('canplay', onCanPlay);
  video.addEventListener('canplaythrough', onCanPlay);
  video.addEventListener('progress', onProgress);
  video.addEventListener('ended', onEnded);
  video.addEventListener('loadedmetadata', onMeta);
  video.addEventListener('timeupdate', onTimeUpdate);
  video.addEventListener('waiting', onWaiting);
  videoListeners.set(video, {
    onPlaying,
    onCanPlay,
    onProgress,
    onEnded,
    onMeta,
    onTimeUpdate,
    onWaiting,
  });
}

function windowEnd() {
  return Math.min(activeIndex + PRELOAD_WINDOW - 1, cards().length - 1);
}

/**
 * Sliding window + chained preload:
 * - Only indices [activeIndex .. activeIndex+4] may have src.
 * - Attach current immediately; advance tip only when prior card is playing
 *   or has ~2–3s buffered / canplaythrough.
 */
function maybeAdvancePipeline() {
  const list = cards();
  if (!list.length) return;

  const maxTip = windowEnd();

  // Ensure current always has src and tries to play.
  const curVideo = videoOf(list[activeIndex]);
  if (curVideo) {
    attachSrc(curVideo);
    if (canStartPlayback(curVideo)) tryPlay(curVideo);
    if (isPlaying(curVideo) || curVideo.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
      pipelineTip = Math.max(pipelineTip, activeIndex);
    }
  }

  // Grow tip forward while prior is ready enough.
  while (pipelineTip < maxTip) {
    const tip = Math.max(pipelineTip, activeIndex);
    const tipVideo = videoOf(list[tip]);
    const ready =
      tip === activeIndex
        ? isPlaying(tipVideo) || canStartPlayback(tipVideo)
        : hasEnoughBuffer(tipVideo) || isPlaying(tipVideo);

    if (!ready && tip > activeIndex) break;
    if (tip === activeIndex && !isPlaying(tipVideo) && !canStartPlayback(tipVideo)) {
      // Still waiting on current — don't open further slots yet,
      // but current already has src above.
      break;
    }

    const next = tip + 1;
    if (next > maxTip) break;
    const nextVideo = videoOf(list[next]);
    if (nextVideo) attachSrc(nextVideo);
    pipelineTip = next;

    // Only open one new slot per readiness gate; loop continues if that
    // slot is already buffered (e.g. after scroll back).
    if (!hasEnoughBuffer(nextVideo) && !isPlaying(nextVideo)) break;
  }

  // Detach anything outside the sliding window.
  list.forEach((card, i) => {
    const video = videoOf(card);
    if (!video) return;
    if (i < activeIndex || i > maxTip) {
      detachSrc(video);
    } else if (i <= pipelineTip) {
      attachSrc(video);
    }
  });
}

function syncActivePlayback() {
  const list = cards();
  list.forEach((card, i) => {
    const video = videoOf(card);
    if (!video) return;
    if (i === activeIndex) {
      syncLetterbox(card, true);
      if (video.getAttribute('src') || video.src) {
        if (canStartPlayback(video)) tryPlay(video);
        if (isPlaying(video)) setPosterVisible(card, false);
      }
      syncBgPlayback(card);
    } else {
      syncLetterbox(card, false);
      video.pause();
      try {
        if (video.getAttribute('src')) video.currentTime = 0;
      } catch (_) {}
      if (!isPlaying(video)) setPosterVisible(card, true);
    }
  });
}

function rememberActiveGame() {
  const list = cards();
  const card = list[activeIndex];
  const id = card?.dataset.id;
  if (!id) return;
  writeLastId(id);
  syncUrlForGame(id);
}

function setActiveIndex(next) {
  const list = cards();
  if (!list.length) return;
  const clamped = Math.max(0, Math.min(next, list.length - 1));
  const changed = clamped !== activeIndex;
  activeIndex = clamped;
  const card = list[activeIndex];
  const id = card?.dataset.id || '';
  if (changed) {
    // Reset tip to current so the chain rebuilds from the new card.
    pipelineTip = activeIndex - 1;
    // Fresh accum for the newly active card; leaving cancels the prior one.
    resetWatchAccum(id);
  } else if (accumGameId !== id) {
    resetWatchAccum(id);
  }
  if (id) markSeen(id);
  const warmEnd = Math.min(activeIndex + PLAY_NAV_PRELOAD_WINDOW - 1, list.length - 1);
  for (let i = activeIndex; i <= warmEnd; i++) {
    warmPlayNavigation(list[i]?.dataset.url);
  }
  syncActivePlayback();
  maybeAdvancePipeline();
  if (changed) rememberActiveGame();
}

function currentIndexFromScroll() {
  const list = cards();
  if (!list.length) return 0;
  const top = feedEl.scrollTop;
  let best = 0;
  let bestDist = Infinity;
  list.forEach((c, i) => {
    const d = Math.abs(c.offsetTop - top);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  });
  return best;
}

function initialsFrom(name) {
  const s = String(name || '').trim();
  if (!s) return '?';
  const parts = s.replace(/^@/, '').split(/[\s._-]+/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return s.slice(0, 2).toUpperCase();
}

function hueFrom(name) {
  let h = 0;
  const s = String(name || 'x');
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 360;
}


function formatCompact(n) {
  const x = Math.max(0, Math.floor(Number(n) || 0));
  if (x < 1000) return String(x);
  if (x < 10_000) {
    const s = (x / 1000).toFixed(1);
    return `${s.replace(/\.0$/, '')}k`;
  }
  if (x < 1_000_000) return `${Math.round(x / 1000)}k`;
  const s = (x / 1_000_000).toFixed(1);
  return `${s.replace(/\.0$/, '')}M`;
}

function remoteLikesOf(game) {
  const n = Number(game?.remote_likes);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}


/** Display count = remote_likes + 1 if locally liked (responsive before Overheard fills data). */
function displayLikeCount(game) {
  return remoteLikesOf(game) + (isLiked(game?.id) ? 1 : 0);
}

/** Normalize Overheard comments array (objects with text/author/likes/…). */
function commentsOf(game) {
  if (!Array.isArray(game?.comments)) return [];
  return game.comments.filter((c) => c && typeof c === 'object');
}

function commentCount(game) {
  return commentsOf(game).length;
}

/** Prefer local /avatars path from Overheard; else initials (no remote hotlink). */
function resolveCommentAvatarUrl(comment) {
  const raw = typeof comment?.avatar_url === 'string' ? comment.avatar_url.trim() : '';
  if (raw && isLocalAvatarPath(raw)) return raw;
  return null;
}

function sortedComments(game) {
  return commentsOf(game)
    .slice()
    .sort((a, b) => (Number(b.likes) || 0) - (Number(a.likes) || 0));
}

function commentRowHtml(comment) {
  const author = String(comment.author || 'anon').replace(/^@/, '').trim() || 'anon';
  const display = `@${author}`;
  const text = String(comment.text || '').trim();
  const likes = Math.max(0, Math.floor(Number(comment.likes) || 0));
  const initials = initialsFrom(author);
  const hue = hueFrom(author);
  const avatarUrl = resolveCommentAvatarUrl(comment);
  const avatar = avatarUrl
    ? `<img class="cmt-avatar-img" src="${escapeHtml(avatarUrl)}" alt="" width="36" height="36" loading="lazy" decoding="async" referrerpolicy="no-referrer" data-fallback="${escapeHtml(initials)}" data-hue="${hue}" />`
    : `<span class="cmt-avatar-fallback" style="--hue:${hue}" aria-hidden="true">${escapeHtml(initials)}</span>`;
  const url = typeof comment.url === 'string' ? comment.url.trim() : '';
  const safeUrl = url && httpUrl(url) ? url : '';
  const openAttrs = safeUrl
    ? ` role="link" tabindex="0" data-url="${escapeHtml(safeUrl)}"`
    : '';
  return `
    <div class="cmt-row${safeUrl ? ' cmt-row-link' : ''}"${openAttrs}>
      <span class="cmt-avatar">${avatar}</span>
      <div class="cmt-body">
        <div class="cmt-meta">
          <span class="cmt-author">${escapeHtml(display)}</span>
          <span class="cmt-likes" aria-label="${likes} likes">♥ ${escapeHtml(formatCompact(likes))}</span>
        </div>
        <p class="cmt-text">${escapeHtml(text) || '<span class="cmt-empty-text">…</span>'}</p>
      </div>
    </div>
  `;
}

function renderCommentsList(game) {
  if (!commentsListEl) return;
  const list = sortedComments(game);
  if (!list.length) {
    commentsListEl.innerHTML = `
      <div class="cmt-empty">
        <p>No comments yet</p>
        <p class="cmt-empty-sub">Pulls in from X finds on the next Overheard scan.</p>
      </div>`;
    return;
  }
  commentsListEl.innerHTML = list.map(commentRowHtml).join('');
  commentsListEl.querySelectorAll('.cmt-avatar-img').forEach((img) => {
    img.addEventListener('error', () => {
      const fallback = document.createElement('span');
      fallback.className = 'cmt-avatar-fallback';
      fallback.style.setProperty('--hue', img.dataset.hue || '260');
      fallback.setAttribute('aria-hidden', 'true');
      fallback.textContent = img.dataset.fallback || '?';
      img.replaceWith(fallback);
    });
  });
  commentsListEl.querySelectorAll('.cmt-row-link').forEach((row) => {
    const open = () => {
      const u = row.dataset.url;
      if (u) window.open(u, '_blank', 'noopener,noreferrer');
    };
    row.addEventListener('click', (e) => {
      e.stopPropagation();
      open();
    });
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        open();
      }
    });
  });
}

function setCommentsSheetOffset(py) {
  if (!commentsSheetEl) return;
  const panel = commentsSheetEl.querySelector('.comments-panel');
  if (!panel) return;
  const y = Math.max(0, py);
  panel.style.transform = y ? `translateY(${y}px)` : '';
  panel.style.transition = y ? 'none' : '';
}

function openCommentsSheet(game) {
  if (!commentsSheetEl || !commentsListEl) return;
  commentsOpen = true;
  autoAdvancePaused = true;
  const n = commentCount(game);
  if (commentsTitleEl) {
    commentsTitleEl.textContent = n ? `Comments · ${formatCompact(n)}` : 'Comments';
  }
  renderCommentsList(game);
  commentsSheetEl.hidden = false;
  commentsSheetEl.setAttribute('aria-hidden', 'false');
  document.body.classList.add('comments-open');
  setCommentsSheetOffset(0);
  // Next frame for enter animation
  requestAnimationFrame(() => {
    commentsSheetEl.classList.add('open');
  });
  pushOverlayHistory('comments');
}

function closeCommentsSheet() {
  if (!commentsSheetEl || !commentsOpen) return;
  commentsOpen = false;
  commentsSheetEl.classList.remove('open');
  document.body.classList.remove('comments-open');
  setCommentsSheetOffset(0);
  commentsSheetEl.setAttribute('aria-hidden', 'true');
  const panel = commentsSheetEl.querySelector('.comments-panel');
  const done = () => {
    if (commentsOpen) return;
    commentsSheetEl.hidden = true;
    if (commentsListEl) commentsListEl.innerHTML = '';
    // Resume auto-advance eligibility for the active card.
    autoAdvancePaused = false;
  };
  if (panel) {
    panel.addEventListener('transitionend', done, { once: true });
    setTimeout(done, 320);
  } else {
    done();
  }
}

function wireCommentsSheet() {
  if (!commentsSheetEl) return;
  commentsSheetEl.querySelectorAll('[data-close-comments]').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      dismissCommentsSheet();
    });
  });

  const panel = commentsSheetEl.querySelector('.comments-panel');
  const grab = commentsSheetEl.querySelector('.comments-grab') || panel;
  if (!panel || !grab) return;

  const onStart = (clientY) => {
    commentsSwipeActive = true;
    commentsSwipeStartY = clientY;
    commentsSwipeCurrentY = 0;
  };
  const onMove = (clientY) => {
    if (!commentsSwipeActive || commentsSwipeStartY == null) return;
    const dy = clientY - commentsSwipeStartY;
    commentsSwipeCurrentY = dy;
    if (dy > 0) setCommentsSheetOffset(dy);
  };
  const onEnd = () => {
    if (!commentsSwipeActive) return;
    commentsSwipeActive = false;
    const dy = commentsSwipeCurrentY;
    commentsSwipeStartY = null;
    commentsSwipeCurrentY = 0;
    if (panel) panel.style.transition = '';
    if (dy > 90) {
      dismissCommentsSheet();
    } else {
      setCommentsSheetOffset(0);
    }
  };

  grab.addEventListener(
    'pointerdown',
    (e) => {
      if (e.button != null && e.button !== 0) return;
      onStart(e.clientY);
      try {
        grab.setPointerCapture(e.pointerId);
      } catch (_) {}
    },
    { passive: true },
  );
  grab.addEventListener(
    'pointermove',
    (e) => {
      if (!commentsSwipeActive) return;
      onMove(e.clientY);
    },
    { passive: true },
  );
  grab.addEventListener('pointerup', onEnd);
  grab.addEventListener('pointercancel', onEnd);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && commentsOpen && !playOverlayOpen) {
      e.preventDefault();
      closeCommentsSheet();
    }
  });
}

/**
 * Prefer same-origin / relative avatar_url (e.g. /avatars/...), else GitHub png, else null → initials.
 */
function isLocalAvatarPath(url) {
  if (!url || typeof url !== 'string') return false;
  const u = url.trim();
  if (!u) return false;
  if (u.startsWith('/') && !u.startsWith('//')) return true;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(u)) return true;
  try {
    const parsed = new URL(u, window.location.origin);
    return parsed.origin === window.location.origin;
  } catch (_) {
    return false;
  }
}

function resolveAvatarUrl(game) {
  const raw = typeof game?.avatar_url === 'string' ? game.avatar_url.trim() : '';
  if (raw && isLocalAvatarPath(raw)) return raw;
  const gh = String(game?.github_user || '')
    .replace(/^@/, '')
    .trim();
  if (/^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/.test(gh)) {
    return `https://github.com/${gh}.png?size=80`;
  }
  return null;
}


const SOURCE_URL_FIELDS = [
  'source_url',
  'sourceUrl',
  'listing_url',
  'listingUrl',
  'found_url',
  'foundUrl',
  'x_url',
  'twitter_url',
  'url',
];

const X_RESERVED_HANDLES = new Set([
  'i', 'intent', 'share', 'home', 'explore', 'search', 'settings',
  'messages', 'notifications', 'compose', 'login', 'signup',
]);

function sourceUrlsFor(game) {
  return SOURCE_URL_FIELDS
    .map((field) => game?.[field])
    .filter((value) => typeof value === 'string' && value.trim())
    .map((value) => value.trim());
}

function httpUrl(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch (_) {
    return null;
  }
}

/**
 * Warm an external game's Play destination without embedding or navigating to
 * it. Link hints are intentionally kept for the life of the page so scroll,
 * filter, and sort changes cannot spam the same origin or URL.
 */
function warmPlayNavigation(value) {
  const url = httpUrl(value);
  if (!url) return;

  const origin = url.origin;
  if (!warmedPlayOrigins.has(origin)) {
    warmedPlayOrigins.add(origin);

    const dns = document.createElement('link');
    dns.rel = 'dns-prefetch';
    dns.href = origin;
    document.head.appendChild(dns);

    const preconnect = document.createElement('link');
    preconnect.rel = 'preconnect';
    preconnect.href = origin;
    document.head.appendChild(preconnect);
  }

  // Fragments do not change the HTML request, so normalize them out for
  // deduplication while preserving query parameters used by the game.
  url.hash = '';
  const href = url.href;
  if (warmedPlayUrls.has(href)) return;
  warmedPlayUrls.add(href);

  const prefetch = document.createElement('link');
  prefetch.rel = 'prefetch';
  prefetch.href = href;
  prefetch.setAttribute('fetchpriority', 'low');
  document.head.appendChild(prefetch);
}

function socialHandleFromUrl(value, hosts) {
  const url = httpUrl(value);
  if (!url || !hosts.has(url.hostname.toLowerCase())) return '';
  const handle = url.pathname.split('/').filter(Boolean)[0] || '';
  return /^[A-Za-z0-9_]{1,15}$/.test(handle) && !X_RESERVED_HANDLES.has(handle.toLowerCase())
    ? handle
    : '';
}

/** Pick the place this game was found, keeping X ahead of GitHub. */
function authorUrlFor(game) {
  const sourceUrls = sourceUrlsFor(game);
  const xHosts = new Set(['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com']);
  const explicitX = String(game?.x_handle || '').replace(/^@/, '').trim();
  const xHandle = /^[A-Za-z0-9_]{1,15}$/.test(explicitX) && !X_RESERVED_HANDLES.has(explicitX.toLowerCase())
    ? explicitX
    : sourceUrls.map((url) => socialHandleFromUrl(url, xHosts)).find(Boolean) || '';
  if (xHandle) return `https://x.com/${encodeURIComponent(xHandle)}`;

  const githubUser = String(game?.github_user || '').replace(/^@/, '').trim();
  if (/^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/.test(githubUser)) {
    return `https://github.com/${encodeURIComponent(githubUser)}`;
  }

  const githubUrl = sourceUrls.find((value) => {
    const url = httpUrl(value);
    return url && /^(www\.)?github\.com$/i.test(url.hostname);
  });
  if (githubUrl) return githubUrl;

  return sourceUrls.map((value) => httpUrl(value)?.toString() || '').find(Boolean) || '';
}

function authorRowHtml(game) {
  const name = game.author || game.github_user || game.x_handle || '';
  if (!name) return '';
  const display = game.github_user
    ? `@${game.github_user}`
    : game.x_handle
      ? `@${game.x_handle}`
      : name;
  const initials = initialsFrom(name);
  const hue = hueFrom(name);
  const avatarUrl = resolveAvatarUrl(game);
  const avatar = avatarUrl
    ? `<img class="avatar-img" src="${escapeHtml(avatarUrl)}" alt="" width="36" height="36" loading="lazy" decoding="async" referrerpolicy="no-referrer" data-fallback="${escapeHtml(initials)}" data-hue="${hue}" />`
    : `<span class="avatar-fallback" style="--hue:${hue}" aria-hidden="true">${escapeHtml(initials)}</span>`;
  const authorUrl = authorUrlFor(game);
  const tag = authorUrl ? 'a' : 'div';
  const linkAttrs = authorUrl
    ? ` href="${escapeHtml(authorUrl)}" target="_blank" rel="noopener" aria-label="Open ${escapeHtml(display)}"`
    : '';
  return `
    <${tag} class="author${authorUrl ? ' author-link' : ''}"${linkAttrs}>
      <span class="avatar">${avatar}</span>
      <span class="author-name">${escapeHtml(display)}</span>
    </${tag}>
  `;
}

function showToast(msg) {
  if (!toastEl) return;
  toastEl.textContent = msg;
  toastEl.hidden = false;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.classList.remove('show');
    toastEl.hidden = true;
  }, 1800);
}

async function shareGame(game) {
  const url = shareUrlFor(game.id);
  const title = game.title || 'AI Games Feed';
  const text = `Play ${title} on AI Games Feed`;
  if (navigator.share) {
    try {
      await navigator.share({ title, text, url });
      return;
    } catch (err) {
      // User cancel → quiet exit; other errors fall through to clipboard.
      if (err && err.name === 'AbortError') return;
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    showToast('Link copied');
  } catch (_) {
    // Last resort: prompt-less fallback via temp input
    try {
      const ta = document.createElement('textarea');
      ta.value = url;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      showToast('Link copied');
    } catch (_) {
      showToast('Could not copy link');
    }
  }
}

function buildEndCard() {
  const card = document.createElement('section');
  card.className = 'end-card';
  card.setAttribute('aria-labelledby', 'endCardTitle');
  card.innerHTML = `
    <div class="end-card-content">
      <p class="end-card-eyebrow">You’re all caught up</p>
      <h2 id="endCardTitle">You're up to date</h2>
      <p class="end-card-copy">That’s everything for today. Come back soon for more games.</p>
      <a class="discover-more" href="https://omgithub.com/" target="_blank" rel="noopener noreferrer">
        Discover more games
      </a>
    </div>
  `;
  return card;
}

function buildCard(game, index) {
  const card = document.createElement('article');
  card.className = 'card';
  card.dataset.index = String(index);
  card.dataset.id = game.id;
  card.dataset.url = game.play_url;
  if (game.iframe === true) card.dataset.iframe = 'true';

  const screenshot = game.screenshot
    ? `<img class="poster ken-burns" src="${escapeHtml(game.screenshot)}" alt="" decoding="async" draggable="false" />`
    : `<div class="poster poster-fallback ken-burns" aria-hidden="true"></div>`;

  const desc = game.description
    ? `<p class="desc">${escapeHtml(game.description)}</p>`
    : '';

  const plat = platformLabel(game.platforms);
  const platHtml = plat
    ? `<span class="platform">${escapeHtml(plat)}</span>`
    : '';

  const madeLabel =
    game.made_with === 'opus-5.5'
      ? 'Opus 5.5'
      : game.made_with === 'sonnet-5.5'
        ? 'Sonnet 5.5'
        : game.made_with === 'astra'
          ? 'Astra'
          : '';
  const madeHtml = madeLabel
    ? `<span class="made-with">${escapeHtml(madeLabel)}</span>`
    : '';

  const engineHtml = game.engine
    ? `<span class="engine" title="Made in ${escapeHtml(game.engine)}">${escapeHtml(game.engine)}</span>`
    : '';

  const liked = isLiked(game.id);
  const likeN = displayLikeCount(game);
  const cmtN = commentCount(game);
  // Always show a compact number so empty feeds aren't confusing (0 is fine).
  const likeCountHtml = `<span class="like-count">${escapeHtml(formatCompact(likeN))}</span>`;

  card.innerHTML = `
    ${screenshot}
    <video
      class="clip"
      data-src="${escapeHtml(game.video)}"
      playsinline
      preload="none"
      disablepictureinpicture
    ></video>
    <button type="button" class="mute-control" aria-pressed="${effectiveMuted() ? 'true' : 'false'}" aria-label="${effectiveMuted() ? 'Unmute video' : 'Mute video'}" title="${effectiveMuted() ? 'Unmute video' : 'Mute video'}">
      <svg class="icon-muted" viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <path d="M4 9v6h4l5 4V5L8 9H4Z"/>
        <path d="M16.5 10.5a3 3 0 0 1 0 3"/>
      </svg>
      <svg class="icon-unmuted" viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <path d="M4 9v6h4l5 4V5L8 9H4Z"/>
        <path d="M17 8.5a5 5 0 0 1 0 7M19.5 6a8.5 8.5 0 0 1 0 12"/>
      </svg>
    </button>
    <div class="card-body">
      <div class="badges">
        <span class="score">${escapeHtml(scoreLabel(game.screenshot_score))}</span>
        ${platHtml}
        ${madeHtml}
        ${engineHtml}
      </div>
      ${authorRowHtml(game)}
      <h2 class="title">${escapeHtml(game.title)}</h2>
      ${desc}
      <button type="button" class="play" aria-label="${escapeHtml(playButtonLabel(game))} ${escapeHtml(game.title)}">${escapeHtml(playButtonLabel(game))}</button>
    </div>
    <div class="rail" aria-label="Actions">
      <button type="button" class="rail-btn like ${liked ? 'liked' : ''}" aria-pressed="${liked ? 'true' : 'false'}" aria-label="${liked ? 'Unlike' : 'Like'}">
        <span class="rail-icon" aria-hidden="true">
          <svg class="icon-heart" viewBox="0 0 24 24" width="28" height="28">
            <path class="heart-outline" d="M12 21s-6.7-4.35-9.33-8.1C.8 10.35 1.2 6.9 3.9 5.25 6.1 3.9 8.7 4.35 12 7.2c3.3-2.85 5.9-3.3 8.1-1.95 2.7 1.65 3.1 5.1 1.23 7.65C18.7 16.65 12 21 12 21z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
            <path class="heart-fill" d="M12 21s-6.7-4.35-9.33-8.1C.8 10.35 1.2 6.9 3.9 5.25 6.1 3.9 8.7 4.35 12 7.2c3.3-2.85 5.9-3.3 8.1-1.95 2.7 1.65 3.1 5.1 1.23 7.65C18.7 16.65 12 21 12 21z" fill="currentColor"/>
          </svg>
        </span>
        ${likeCountHtml}
      </button>
      <button type="button" class="rail-btn comments" aria-label="Comments">
        <span class="rail-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M5 6.5A2.5 2.5 0 0 1 7.5 4h9A2.5 2.5 0 0 1 19 6.5v6a2.5 2.5 0 0 1-2.5 2.5H12l-4.2 3.2c-.55.42-1.3.02-1.3-.66V15H7.5A2.5 2.5 0 0 1 5 12.5v-6Z"/>
          </svg>
        </span>
        <span class="comment-count">${escapeHtml(formatCompact(cmtN))}</span>
      </button>
      <button type="button" class="rail-btn share" aria-label="Share">
        <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="18" cy="5" r="2.5"/>
          <circle cx="6" cy="12" r="2.5"/>
          <circle cx="18" cy="19" r="2.5"/>
          <path d="M8.4 13.2l7.2 4.2M15.6 6.6l-7.2 4.2"/>
        </svg>
      </button>
    </div>
  `;

  const muteBtn = card.querySelector('.mute-control');
  muteBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    setMutedPreference(!effectiveMuted());
  });

  card.querySelector('.play').addEventListener('click', (e) => {
    e.stopPropagation();
    playGame(game);
  });

  wireActiveVideoTap(card, game);

  const likeBtn = card.querySelector('.like');
  likeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const on = toggleLike(game.id);
    likeBtn.classList.toggle('liked', on);
    likeBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    likeBtn.setAttribute('aria-label', on ? 'Unlike' : 'Like');
    const countSpan = likeBtn.querySelector('.like-count');
    if (countSpan) {
      const n = remoteLikesOf(game) + (on ? 1 : 0);
      countSpan.textContent = formatCompact(n);
      countSpan.hidden = false;
    }
  });

  card.querySelector('.comments').addEventListener('click', (e) => {
    e.stopPropagation();
    openCommentsSheet(game);
  });

  card.querySelector('.share').addEventListener('click', (e) => {
    e.stopPropagation();
    shareGame(game);
  });

  const img = card.querySelector('.avatar-img');
  if (img) {
    img.addEventListener('error', () => {
      const fallback = document.createElement('span');
      fallback.className = 'avatar-fallback';
      fallback.style.setProperty('--hue', img.dataset.hue || '260');
      fallback.setAttribute('aria-hidden', 'true');
      fallback.textContent = img.dataset.fallback || '?';
      img.replaceWith(fallback);
    });
  }

  wireVideo(videoOf(card));
  return card;
}

function isIframeGame(gameOrFlag) {
  if (typeof gameOrFlag === 'boolean') return gameOrFlag;
  if (gameOrFlag && typeof gameOrFlag === 'object') return gameOrFlag.iframe === true;
  return gameOrFlag === true || gameOrFlag === 'true';
}

function playButtonLabel(game) {
  return isIframeGame(game) ? 'Play ▸' : 'Play ↗';
}

function openGame(url) {
  window.open(url, '_blank', 'noopener,noreferrer');
}

function openPlayOverlay(url, title = 'Play game') {
  if (!playOverlayEl || !playFrameEl || !url) return;
  playOverlayOpen = true;
  autoAdvancePaused = true;
  watchAccumSec = 0;
  const list = cards();
  const video = videoOf(list[activeIndex]);
  if (video) video.pause();

  playFrameEl.title = title || 'Play game';
  playFrameEl.src = url;
  const openLink = playOverlayEl.querySelector('[data-open-play]');
  if (openLink) openLink.href = url;

  playOverlayEl.hidden = false;
  playOverlayEl.setAttribute('aria-hidden', 'false');
  document.body.classList.add('play-overlay-open');
  requestAnimationFrame(() => {
    playOverlayEl.classList.add('open');
  });
  // Same tap as Play: browser fullscreen hides Chrome's bars. Back exits it.
  requestGameFullscreen();
  pushOverlayHistory('play');
}

function closePlayOverlay({ immediate = false } = {}) {
  if (!playOverlayEl || !playOverlayOpen) return;
  playOverlayOpen = false;
  exitGameFullscreen();
  playOverlayEl.classList.remove('open');
  document.body.classList.remove('play-overlay-open');
  playOverlayEl.setAttribute('aria-hidden', 'true');
  // Stop game scripts/audio immediately.
  if (playFrameEl) {
    playFrameEl.src = 'about:blank';
    playFrameEl.removeAttribute('srcdoc');
  }
  const openLink = playOverlayEl.querySelector('[data-open-play]');
  if (openLink) openLink.href = '#';

  const finish = () => {
    if (playOverlayOpen) return;
    playOverlayEl.hidden = true;
    // Resume feed video + auto-advance after Exit.
    autoAdvancePaused = false;
    watchAccumSec = 0;
    const list = cards();
    const video = videoOf(list[activeIndex]);
    if (video) tryPlay(video);
  };
  if (immediate) finish();
  else setTimeout(finish, 180);
}

/**
 * Short tap on the active card's video opens Play. Long-press toggles fit mode.
 * Chrome often fires pointercancel on video long-press (context-menu gesture) —
 * that must NOT cancel the hold timer, or a hold after scrolling looks like a no-op.
 */
function wireActiveVideoTap(card, game) {
  const video = videoOf(card);
  if (!video) return;
  suppressVideoContextMenu(video);
  const LONG_PRESS_MS = 450;
  let tapArmed = false; // short-tap → Play
  let holdAlive = false; // long-press timer still eligible
  let longPressFired = false;
  let holdTimer = 0;
  let startX = 0;
  let startY = 0;
  let startScroll = 0;
  let startTime = 0;

  const clearHold = () => {
    if (holdTimer) {
      clearTimeout(holdTimer);
      holdTimer = 0;
    }
  };

  const cardIsCurrent = () => {
    const idx = Number(card.dataset.index);
    if (idx === activeIndex) return true;
    // After scroll, activeIndex can lag one frame behind scroll-snap.
    return idx === currentIndexFromScroll();
  };

  const fireLongPress = () => {
    if (longPressFired || !holdAlive) return;
    if (commentsOpen || playOverlayOpen) return;
    if (!cardIsCurrent()) return;
    // Real scroll-away during the hold (not snap settle).
    if (Math.abs(feedEl.scrollTop - startScroll) > 48) return;
    longPressFired = true;
    holdAlive = false;
    tapArmed = false;
    clearHold();
    toggleFitMode(); // cooldown inside → exactly once
  };

  video.addEventListener(
    'pointerdown',
    (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      tapArmed = true;
      holdAlive = true;
      longPressFired = false;
      startX = e.clientX;
      startY = e.clientY;
      startScroll = feedEl.scrollTop;
      startTime = Date.now();
      clearHold();
      holdTimer = window.setTimeout(() => {
        holdTimer = 0;
        fireLongPress();
      }, LONG_PRESS_MS);
    },
    { passive: true },
  );

  video.addEventListener(
    'pointermove',
    (e) => {
      if (longPressFired) return;
      if (Math.abs(e.clientX - startX) > 14 || Math.abs(e.clientY - startY) > 14) {
        // Finger dragged — treat as scroll/gesture, not hold or tap.
        holdAlive = false;
        tapArmed = false;
        clearHold();
      }
    },
    { passive: true },
  );

  // Do NOT clear the hold timer on pointercancel: mobile Chrome cancels the
  // pointer when recognizing a video long-press / context menu. The timer
  // (or pointerup fallback) still completes the fit toggle.
  video.addEventListener('pointercancel', () => {
    tapArmed = false; // cancel short-tap Play; keep holdAlive for the timer
  });

  video.addEventListener('pointerup', (e) => {
    if (longPressFired) {
      tapArmed = false;
      holdAlive = false;
      clearHold();
      return;
    }
    const heldMs = Date.now() - startTime;
    // If Chrome cancelled the timer path oddly, honor a completed hold on up.
    if (holdAlive && heldMs >= LONG_PRESS_MS) {
      fireLongPress();
      return;
    }
    clearHold();
    holdAlive = false;
    if (Math.abs(e.clientX - startX) > 14 || Math.abs(e.clientY - startY) > 14) {
      tapArmed = false;
    }
  });

  video.addEventListener('click', (e) => {
    // Long-press already toggled fit mode — never open Play on that gesture.
    if (longPressFired) {
      longPressFired = false;
      tapArmed = false;
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (!tapArmed) return;
    tapArmed = false;
    if (commentsOpen || playOverlayOpen) return;
    if (!cardIsCurrent()) return;
    if (Math.abs(feedEl.scrollTop - startScroll) > 8) return;
    if (Math.abs(e.clientX - startX) > 14 || Math.abs(e.clientY - startY) > 14) return;
    e.stopPropagation();
    playGame(game);
  });
}

function playGame(gameOrUrl, maybeTitle) {
  const url =
    typeof gameOrUrl === 'string'
      ? gameOrUrl
      : gameOrUrl?.play_url || gameOrUrl?.dataset?.url;
  if (!url) return;
  const iframe =
    typeof gameOrUrl === 'string'
      ? false
      : isIframeGame(gameOrUrl);
  const title =
    maybeTitle ||
    (typeof gameOrUrl === 'object' && gameOrUrl?.title) ||
    'Play game';
  if (iframe) openPlayOverlay(url, title);
  else {
    autoAdvancePaused = true;
    watchAccumSec = 0;
    const list = cards();
    const video = videoOf(list[activeIndex]);
    if (video) video.pause();
    openGame(url);
  }
}

function pointInEl(x, y, el) {
  if (!el) return false;
  const r = el.getBoundingClientRect();
  return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
}

function wirePlayOverlay() {
  if (!playOverlayEl) return;

  // Cross-origin OOPIF games (e.g. halo.omgithub.com with COOP/COEP) can
  // retarget the synthesized `click` to <html> even when pointerdown/up hit
  // the Exit/Open controls. :active still animates, but click handlers never
  // run. Prefer pointerup on the controls; fall back to click + hit-tested
  // document click for keyboard / odd mouse paths.
  let openGuardUntil = 0;

  const activateClose = (e) => {
    if (!playOverlayOpen) return;
    e.preventDefault();
    e.stopPropagation();
    dismissPlayOverlay();
  };

  const activateOpen = (e) => {
    if (!playOverlayOpen) return;
    e.preventDefault();
    e.stopPropagation();
    const openLink = playOverlayEl.querySelector('[data-open-play]');
    const href = openLink?.getAttribute('href');
    if (!href || href === '#') return;
    const now = Date.now();
    if (now < openGuardUntil) return;
    openGuardUntil = now + 600;
    window.open(href, '_blank', 'noopener,noreferrer');
  };

  const bindActivate = (el, activate) => {
    if (!el) return;
    el.addEventListener('pointerup', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      activate(e);
    });
    el.addEventListener('click', activate);
  };

  playOverlayEl.querySelectorAll('[data-close-play]').forEach((el) => {
    bindActivate(el, activateClose);
  });
  bindActivate(playOverlayEl.querySelector('[data-open-play]'), activateOpen);

  // When click is retargeted to <html>, still honor taps that land on controls.
  document.addEventListener(
    'click',
    (e) => {
      if (!playOverlayOpen) return;
      const x = e.clientX;
      const y = e.clientY;
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      const exitBtn = playOverlayEl.querySelector('[data-close-play]');
      const openLink = playOverlayEl.querySelector('[data-open-play]');
      if (pointInEl(x, y, exitBtn)) activateClose(e);
      else if (pointInEl(x, y, openLink)) activateOpen(e);
    },
    true,
  );

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && playOverlayOpen) {
      e.preventDefault();
      dismissPlayOverlay();
    }
  });
}

function scrollToIndex(i, { smooth = true } = {}) {
  const list = cards();
  if (!list.length) return;
  const clamped = Math.max(0, Math.min(i, list.length - 1));
  // 'instant' (not 'auto'): CSS scroll-behavior:smooth would still animate 'auto'.
  list[clamped].scrollIntoView({
    behavior: smooth ? 'smooth' : 'instant',
    block: 'start',
  });
  setActiveIndex(clamped);
}

function scrollToEndCard({ smooth = true } = {}) {
  const end = endCardEl();
  if (!end) return false;
  end.scrollIntoView({
    behavior: smooth ? 'smooth' : 'instant',
    block: 'start',
  });
  return true;
}

function indexOfGameId(id) {
  if (!id) return -1;
  const list = cards();
  for (let i = 0; i < list.length; i++) {
    if (list[i].dataset.id === id) return i;
  }
  return -1;
}

function resolveStartIndex(resumeId = '') {
  return indexOfGameId(resumeId);
}

function wireKeyboard() {
  if (keyboardWired) return;
  keyboardWired = true;
  window.addEventListener('keydown', (e) => {
    if (commentsOpen || playOverlayOpen) return;
    if (e.key === 'ArrowDown' || e.key === 'PageDown' || e.key === 'j') {
      e.preventDefault();
      const current = currentIndexFromScroll();
      if (current >= cards().length - 1) scrollToEndCard();
      else scrollToIndex(current + 1);
      hideHint();
    } else if (e.key === 'ArrowUp' || e.key === 'PageUp' || e.key === 'k') {
      e.preventDefault();
      scrollToIndex(currentIndexFromScroll() - 1);
      hideHint();
    } else if (e.key === 'Enter') {
      const card = cards()[currentIndexFromScroll()];
      if (card?.dataset.url) {
        playGame({
          play_url: card.dataset.url,
          iframe: card.dataset.iframe === 'true',
          title: card.querySelector('.title')?.textContent || 'Play game',
        });
      }
    }
  });
}

function tearDownVideos() {
  cards().forEach((card) => {
    const video = videoOf(card);
    if (!video) return;
    video.pause();
    detachSrc(video);
  });
  pipelineTip = -1;
  activeIndex = 0;
}

function onFeedScroll() {
  if (scrollRaf) return;
  scrollRaf = requestAnimationFrame(() => {
    scrollRaf = 0;
    setActiveIndex(currentIndexFromScroll());
    syncEndCardPlayback();
    hideHint();
  });
}

function hideHint() {
  if (hintHidden) return;
  hintHidden = true;
  hintEl?.classList.add('hide');
}

function syncSortUI(mode) {
  if (!sortEl) return;
  sortEl.querySelectorAll('[data-sort]').forEach((btn) => {
    const on = btn.dataset.sort === mode;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
}

function syncMobileUI(on) {
  if (!mobileFilterEl) return;
  mobileFilterEl.classList.toggle('active', on);
  mobileFilterEl.setAttribute('aria-pressed', on ? 'true' : 'false');
}

function renderFeed(mode, mobileOnly, { restore = true, landId = '' } = {}) {
  const sorted = visibleGames(mode, mobileOnly);
  let games = sorted;
  const resumeId = restore ? resumeIdForGames(games) : '';
  const anchorId = restore ? resumeId : landId;
  // Scroll up: already seen, oldest at the top. Scroll down: not yet seen.
  games = orderSeenHistoryAbove(games, anchorId);
  const likes = likeCount();
  const videoCount = allGames.length;
  const videoLabel = `${videoCount} ${videoCount === 1 ? 'video' : 'videos'}`;
  countEl.textContent =
    likes > 0 ? `${catalogCount} games · ${likes}♥` : `${catalogCount} games`;
  countEl.title = videoLabel;
  countEl.dataset.tooltip = videoLabel;

  tearDownVideos();
  feedEl.innerHTML = '';
  resetWatchAccum(null);

  if (!games.length) {
    if (mode === SORT_NEW && sorted.length) {
      feedEl.innerHTML = '';
      feedEl.appendChild(buildEndCard());
      return;
    }
    const msg = mobileOnly
      ? 'No mobile games tagged yet'
      : 'No gameplay videos found.';
    feedEl.innerHTML = `<div class="empty">${escapeHtml(msg)}</div>`;
    return;
  }

  const frag = document.createDocumentFragment();
  games.forEach((g, i) => frag.appendChild(buildCard(g, i)));
  frag.appendChild(buildEndCard());
  feedEl.appendChild(frag);

  restoring = true;
  // Force instant land: assignment to scrollTop also honors CSS scroll-behavior.
  const prevScrollBehavior = feedEl.style.scrollBehavior;
  feedEl.style.scrollBehavior = 'auto';
  feedEl.scrollTop = 0;
  activeIndex = 0;
  pipelineTip = -1;

  // Land on the saved or linked game. With no target, start at the first
  // unseen card so history stays above the fold.
  const targetId = restore ? resumeId : landId;
  const start = targetId
    ? resolveStartIndex(targetId)
    : games.findIndex((g) => !readSeen()[g.id]);
  const startIndex = start > 0 ? start : 0;
  if (startIndex > 0) {
    // Land cleanly without animating through every card (?g= / last-seen / sort keep).
    scrollToIndex(startIndex, { smooth: false });
  } else {
    setActiveIndex(0);
    rememberActiveGame();
  }
  feedEl.style.scrollBehavior = prevScrollBehavior;
  // Allow layout to settle before re-enabling URL writes from scroll.
  requestAnimationFrame(() => {
    restoring = false;
    rememberActiveGame();
  });
}

function wireSortToggle() {
  if (!sortEl) return;
  sortEl.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-sort]');
    if (!btn) return;
    const mode = btn.dataset.sort === SORT_NEW ? SORT_NEW : SORT_TOP;
    // Capture before DOM wipe; land on same game in the new order (no catch-up).
    const keepId = cards()[activeIndex]?.dataset.id || readLastId();
    writeSortMode(mode);
    syncSortUI(mode);
    renderFeed(mode, readMobileOnly(), { restore: false, landId: keepId });
    hideHint();
  });
}

function wireMobileFilter() {
  if (!mobileFilterEl) return;
  mobileFilterEl.addEventListener('click', () => {
    const next = !readMobileOnly();
    writeMobileOnly(next);
    syncMobileUI(next);
    renderFeed(readSortMode(), next, { restore: false });
    hideHint();
  });
}

async function init() {
  syncCanonicalUrl(deepLinkIdFromUrl());
  let data;
  try {
    // Architecture A: live catalog from raw GitHub (public/games.json is not SoT).
    const { feed, via } = await fetchCatalogFeed();
    data = feed;
    if (via.startsWith('proxy:')) {
      console.info('[ai-games-feed] catalog loaded via Vite /catalog-proxy retry');
    }
  } catch (err) {
    feedEl.innerHTML = `<div class="empty">Failed to load catalog from GitHub<br/><small>${escapeHtml(err.message)}</small></div>`;
    if (countEl) countEl.textContent = 'offline';
    return;
  }

  // Warm CDN origin used for clips + posters (media tags don't need CORS).
  try {
    const origin = new URL(REPO_RAW_BASE).origin;
    if (!document.querySelector(`link[rel="preconnect"][href="${origin}"]`)) {
      const link = document.createElement('link');
      link.rel = 'preconnect';
      link.href = origin;
      link.crossOrigin = 'anonymous';
      document.head.appendChild(link);
    }
  } catch (_) {}

  const sourceCatalogCount = Number(
    data.catalog_count ?? data.total_games ?? data.totals?.games,
  );
  catalogCount = Number.isFinite(sourceCatalogCount)
    ? Math.max(0, Math.floor(sourceCatalogCount))
    : 0;

  allGames = (Array.isArray(data.games) ? data.games : []).filter(
    (g) => g?.video && g?.play_url && g?.id,
  );

  wireAudioGesture();
  wireCommentsSheet();
  wirePlayOverlay();
  wireHistoryNavigation();

  const mode = readSortMode();
  const mobileOnly = readMobileOnly();
  syncSortUI(mode);
  syncMobileUI(mobileOnly);
  wireSortToggle();
  wireMobileFilter();
  renderFeed(mode, mobileOnly, { restore: true });

  wireKeyboard();
  wireVisibility();
  wireLetterboxResize();
  wireFitToggle();
  if (!scrollHintWired) {
    scrollHintWired = true;
    feedEl.addEventListener('scroll', onFeedScroll, { passive: true });
    setTimeout(hideHint, 4000);
  }
}

let letterboxResizeWired = false;
function wireLetterboxResize() {
  if (letterboxResizeWired) return;
  letterboxResizeWired = true;
  let raf = 0;
  const schedule = () => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      syncAllLetterbox();
    });
  };
  window.addEventListener('resize', schedule, { passive: true });
  window.visualViewport?.addEventListener('resize', schedule, { passive: true });
}

let fitToggleWired = false;
function wireFitToggle() {
  const logo = document.querySelector('.logo');
  if (!logo || fitToggleWired) return;
  fitToggleWired = true;
  logo.setAttribute('role', 'button');
  logo.setAttribute('tabindex', '0');
  logo.title = 'Tap to toggle crop / full frame';
  syncFitToggleTitle();
  const toggle = (e) => {
    e.preventDefault();
    e.stopPropagation();
    toggleFitMode();
  };
  logo.addEventListener('click', toggle);
  logo.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggle(e);
    }
  });
}

let visibilityWired = false;
function wireVisibility() {
  if (visibilityWired) return;
  visibilityWired = true;
  document.addEventListener('visibilitychange', () => {
    const list = cards();
    const video = videoOf(list[activeIndex]);
    if (!video) return;
    if (document.visibilityState === 'hidden') {
      // Pause playback + auto-advance while backgrounded.
      video.pause();
    } else {
      // Stay paused while comments or iframe Play overlay is open.
      if (commentsOpen || playOverlayOpen) return;
      // Back from background / external Play: start accum fresh if Play
      // cancelled this card, then resume playback.
      if (autoAdvancePaused) {
        watchAccumSec = 0;
        autoAdvancePaused = false;
      }
      tryPlay(video);
    }
  });
}

init();
