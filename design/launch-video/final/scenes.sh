#!/bin/bash
# Re-renders whole scenes and puts them in place of the same seconds of an earlier render,
# for a change inside some scenes when the others' screens are not at hand. The scenes keep
# their lengths, so the cut points, the clicks and the earlier render's audio all still fit.
# Usage: scenes.sh BASE.mp4 OUT.mp4 FROM:TO [FROM:TO …]   (seconds, scene boundaries)
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd); base=$(realpath "$1"); out=$(realpath -m "$2"); shift 2
ASSETS=${ASSETS:-/tmp/demo/final-assets}
[ -e "$ASSETS/brand/icon-512.png" ] || { mkdir -p "$ASSETS/brand" && cp "$here/../../../web/brand/royal-gold-arrow/icon-512.png" "$ASSETS/brand/icon-512.png"; }
work=$(mktemp -d); inputs=(-i "$base"); chain="[0:v]null[v0]"; k=0
for range in "$@"; do
  from=${range%:*}; to=${range#*:}; k=$((k + 1))
  ASSETS="$ASSETS" node "$here/render.cjs" "$work/s$k" --from "$from" --to "$to" --workers "${WORKERS:-3}"
  inputs+=(-i "$work/s$k.video.mp4")
  chain="$chain;[$k:v]setpts=PTS-STARTPTS+$from/TB[s$k];[v$((k - 1))][s$k]overlay=0:0:eof_action=pass:enable='between(t,$from,$to)'[v$k]"
done
ffmpeg -loglevel error -y "${inputs[@]}" -filter_complex "$chain;[v$k]format=yuv420p[v]" -map "[v]" -map 0:a \
  -c:v libx264 -preset slow -crf 14 -r 30 -c:a copy -movflags +faststart "$out"
rm -rf "$work"
echo "wrote $out"
