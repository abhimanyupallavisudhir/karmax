#!/bin/bash
# Re-renders only the strip above the window (y 0–208: headline, subtitle or boxes) for some
# scenes and lays it over an earlier render of this cut, for a change to headlines when the
# screens are not at hand. Timing and audio stay the earlier render's.
# Usage: strips.sh BASE.mp4 OUT.mp4 FROM:TO [FROM:TO …]   (seconds, scene boundaries)
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd); base=$(realpath "$1"); out=$(realpath -m "$2"); shift 2
work=$(mktemp -d); mkdir -p "$work/assets/brand"
cp "$here/../../../web/brand/royal-gold-arrow/icon-512.png" "$work/assets/brand/icon-512.png"
inputs=(-i "$base"); chain="[0:v]null[v0]"; k=0
for range in "$@"; do
  from=${range%:*}; to=${range#*:}; k=$((k + 1))
  ASSETS="$work/assets" node "$here/render.cjs" "$work/s$k" --from "$from" --to "$to" --workers "${WORKERS:-2}"
  inputs+=(-i "$work/s$k.video.mp4")
  chain="$chain;[$k:v]setpts=PTS-STARTPTS+$from/TB,crop=1920:208:0:0[b$k];[v$((k - 1))][b$k]overlay=0:0:eof_action=pass:enable='between(t,$from,$to)'[v$k]"
done
ffmpeg -loglevel error -y "${inputs[@]}" -filter_complex "$chain;[v$k]format=yuv420p[v]" -map "[v]" -map 0:a \
  -c:v libx264 -preset slow -crf 14 -r 30 -c:a copy -movflags +faststart "$out"
rm -rf "$work"
echo "wrote $out"
