# Avatars

Local author avatar cache for Opus Feed.

- Prefer files here over remote GitHub / X CDN (same-origin, no CORS).
- Naming: `<x_handle>.jpg` or `<github_user>.png` (also `.jpeg` / `.webp`).
- Fetch: `node scripts/fetch-avatars.mjs` (unavatar.io/x/…; falls back to rate limits — use X API `profile_image_url` → pbs.twimg.com `_400x400` when needed).
- `scripts/build-feed.mjs` sets each game's `avatar_url` to `/avatars/<file>` when a matching file exists.
- UI (`resolveAvatarUrl`) uses local `avatar_url`, else `https://github.com/<user>.png`, else initials. `img` onerror → initials only after a real load failure.
