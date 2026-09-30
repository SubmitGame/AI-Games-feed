#!/usr/bin/env bash
# Re-encode opus-feed gameplay clips for fast start / TikTok-style preload.
# Reads from public/videos-orig/, writes to public/videos/.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="${ROOT}/public/videos-orig"
DST="${ROOT}/public/videos"
TMP="${ROOT}/tmp-encode"
JOBS="${JOBS:-3}"
MAX_H=720
CRF=28
MAX_DUR=25
PRESET=veryfast

mkdir -p "$DST" "$TMP"

if [[ ! -d "$SRC" ]]; then
  echo "Missing $SRC — move originals there first." >&2
  exit 1
fi

encode_one() {
  local in="$1"
  local base name out tmp
  base="$(basename "$in")"
  name="${base%.*}"
  out="${DST}/${name}.mp4"
  tmp="${TMP}/${name}.mp4"

  # Skip if already optimized and newer than source
  if [[ -f "$out" && "$out" -nt "$in" ]]; then
    echo "SKIP $base (up to date)"
    return 0
  fi

  local dur
  dur="$(ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "$in" 2>/dev/null || echo 0)"
  local t_args=()
  # Cap long sources so loops stay snappy
  awk -v d="$dur" -v m="$MAX_DUR" 'BEGIN { exit !(d+0 > m+0) }' && t_args=(-t "$MAX_DUR")

  echo "ENC  $base (dur=${dur}s → max ${MAX_DUR}s)"
  ffmpeg -y -hide_banner -loglevel error -stats \
    -i "$in" \
    "${t_args[@]}" \
    -vf "scale=-2:'min(${MAX_H},ih)':flags=lanczos,format=yuv420p" \
    -c:v libx264 -preset "$PRESET" -crf "$CRF" -profile:v main -level 3.1 \
    -movflags +faststart \
    -an \
    "$tmp"

  # Sanity: file exists and is playable / has a video stream
  if ! ffprobe -v error -select_streams v:0 -show_entries stream=codec_name -of csv=p=0 "$tmp" | grep -q .; then
    echo "FAIL $base — no video stream in output" >&2
    rm -f "$tmp"
    return 1
  fi

  mv -f "$tmp" "$out"
  local before after
  before=$(stat -c%s "$in")
  after=$(stat -c%s "$out")
  awk -v b="$before" -v a="$after" -v n="$base" 'BEGIN {
    printf "OK   %s  %.1fMB → %.1fMB (%.0f%%)\n", n, b/1048576, a/1048576, (a/b)*100
  }'
}

export -f encode_one
export DST TMP MAX_H CRF MAX_DUR PRESET

mapfile -t FILES < <(find "$SRC" -maxdepth 1 -type f \( -iname '*.mp4' -o -iname '*.webm' -o -iname '*.mov' \) | sort)
echo "Found ${#FILES[@]} videos. Parallel jobs=$JOBS"

# Simple job pool without GNU parallel
running=0
pids=()
fails=0
for f in "${FILES[@]}"; do
  encode_one "$f" &
  pids+=($!)
  running=$((running + 1))
  if (( running >= JOBS )); then
    if ! wait "${pids[0]}"; then fails=$((fails + 1)); fi
    pids=("${pids[@]:1}")
    running=$((running - 1))
  fi
done
for pid in "${pids[@]:-}"; do
  if ! wait "$pid"; then fails=$((fails + 1)); fi
done

echo "----"
echo "Before: $(du -sh "$SRC" | cut -f1) ($SRC)"
echo "After:  $(du -sh "$DST" | cut -f1) ($DST)"
if (( fails > 0 )); then
  echo "$fails encode(s) failed" >&2
  exit 1
fi
