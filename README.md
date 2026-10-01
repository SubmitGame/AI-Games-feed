# AI Games Feed

TikTok-style vertical feed of **AI-made browser games** — Claude, ChatGPT/Astra, and more. Swipe through gameplay clips; open play links and sources from the card rail.

Live site: **[games.omgithub.com](https://games.omgithub.com/)**. The former **lolgames.net** URL 301-redirects here.

Live catalog source of truth: **[SubmitGame/Claude-vs-ChatGPT](https://github.com/SubmitGame/Claude-vs-ChatGPT)** (`data/grokgames.json`). This app does **not** ship the catalog; it fetches raw GitHub at runtime.

## Preview

```bash
npm install
npm run serve
# → http://127.0.0.1:5173
```

## Sort & filters

Phone-friendly **Top | New** toggle in the top bar:

- **Top** — `screenshot_score` descending (default)
- **New** — newest first via `last_seen`, then `listed_at` / `first_seen`,
  `published_at`, `id`, `video_mtime`, and `remote_likes`

**Mobile** filter keeps games tagged for mobile/touch. Selection is stored in
`localStorage` (`opus-feed-sort`, `opus-feed-mobile-only`).

## Audio

Videos start muted on every page load (Instagram/TikTok-style). Unmuting lasts
only for the current session and resets on refresh.

## Catalog source (Architecture A)

Runtime feed loads games from GitHub raw — **no `npm run build:feed` copy step**.

**Catalog:**

```
https://raw.githubusercontent.com/SubmitGame/Claude-vs-ChatGPT/main/data/grokgames.json
```

Relative media (`video_path`, `videos[].path`, screenshots) resolve to:

```
https://raw.githubusercontent.com/SubmitGame/Claude-vs-ChatGPT/main/videos/<file>.mp4
https://raw.githubusercontent.com/SubmitGame/Claude-vs-ChatGPT/main/screenshots/<file>.jpg
```

Client mapping lives in `src/feed-from-catalog.js` (platforms, authors, likes,
comments, timestamps, `made_with` badges). Fetch uses `cache: 'no-cache'` so
hourly Overheard pushes show within ~minutes (GitHub raw CDN is ~`max-age=300`).

CORS: `raw.githubusercontent.com` returns `Access-Control-Allow-Origin: *`.
If the direct JSON fetch ever fails CORS, Vite dev retries the same
SubmitGame catalog through `/catalog-proxy/...` (see `vite.config.js`).

`public/games.json` is **not** the source of truth. Optional offline rebuild:
`npm run build:feed` / `npm run build:feed:offline` (air-gapped demos only).
Large twin video dirs (`public/videos/`, `public/videos-orig/`) are gitignored;
play clips from the catalog repo instead.

## Production build

```bash
npm run build
npm run preview
```

Static output is in `dist/`.

## Resume, seen, auto-advance

- **Last position** — `localStorage` key `opus-feed-last-id` (also `?g=`).
- **Seen set** — `opus-feed-seen`. Active card is marked seen.
- **Unseen catch-up** — on load/resume, unseen games that sort *above* the
  restored id are inserted immediately after the current card.
- **Sort toggle (Top/New)** — keeps the currently visible game id in the new
  order (instant land, no unseen catch-up). Mobile filter still jumps to top.
- **Auto-advance** — on video `ended`. Clips shorter than 10s loop until
  cumulative watch ≥ 10s, then advance; longer clips advance on first end.
- **End card** — “You're up to date” with a link to [omgithub.com](https://omgithub.com/).

## Likes, avatars & comments

- **Remote social proof** — `remote_likes` + `likes_source` (`x` | `github` | `reddit`).
- **Heart UI** — `remote_likes + (localLiked ? 1 : 0)`; local likes in `opus-feed-likes`.
- **Avatars** — prefer same-origin `/avatars/<user>.png`, else GitHub png, else initials.
- **Comments** — Overheard can attach a `comments` array; tap opens a bottom sheet.

## Related repos

| Repo | Role |
|------|------|
| [SubmitGame/Claude-vs-ChatGPT](https://github.com/SubmitGame/Claude-vs-ChatGPT) | Catalog + videos/screenshots (SoT) |
| [SubmitGame/AI-Games-feed](https://github.com/SubmitGame/AI-Games-feed) | This feed UI |

## License / contributions

Feed UI PRs welcome. New games belong in the **Claude-vs-ChatGPT** catalog via PR
(see that repo’s `CONTRIBUTING.md`).
