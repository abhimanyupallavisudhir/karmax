#!/bin/bash
# Builds a cut whose scenes changed length when only some scenes' screens are at hand:
# each piece is either re-rendered from this timeline (new:FROM:TO, in its seconds) or
# taken from an earlier render (old:FROM:TO, in that render's seconds), joined in order,
# and the score is regenerated for the whole new timeline.
# Usage: restitch.sh BASE.mp4 OUT.mp4 new:0:8.2 old:21.6:48.8 …
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd); base=$(realpath "$1"); out=$(realpath -m "$2"); shift 2
ASSETS=${ASSETS:-/tmp/demo/final-assets}
[ -e "$ASSETS/brand/icon-512.png" ] || { mkdir -p "$ASSETS/brand" && cp "$here/../../../web/brand/royal-gold-arrow/icon-512.png" "$ASSETS/brand/icon-512.png"; }
work=$(mktemp -d); list="$work/list.txt"; k=0
for piece in "$@"; do
  IFS=: read -r kind from to <<< "$piece"; k=$((k + 1))
  if [ "$kind" = new ]; then
    ASSETS="$ASSETS" node "$here/render.cjs" "$work/p$k" --from "$from" --to "$to" --workers "${WORKERS:-3}"
    mv "$work/p$k.video.mp4" "$work/p$k.mp4"; json="$work/p$k.json"
  else
    ffmpeg -loglevel error -y -ss "$from" -to "$to" -i "$base" -an -c:v libx264 -preset slow -crf 14 -r 30 -pix_fmt yuv420p "$work/p$k.mp4"
  fi
  echo "file '$work/p$k.mp4'" >> "$list"
done
ffmpeg -loglevel error -y -f concat -safe 0 -i "$list" -c copy "$work/video.mp4"
[ -n "${json:-}" ] || { echo "restitch.sh: give at least one new: piece" >&2; exit 1; }
read -r cuts clicks dur < <(python3 -c "import json,sys;d=json.load(open(sys.argv[1]));print(','.join(str(s[0]) for s in d['scenes']), ','.join(str(c) for c in d['clicks']), d['duration'])" "$json")
python3 "$here/../first-cut/music.py" "$work/score.wav" "$cuts" "$clicks" "$dur"
ffmpeg -loglevel error -y -i "$work/video.mp4" -i "$work/score.wav" -c:v copy -c:a aac -b:a 192k -shortest -movflags +faststart "$out"
rm -rf "$work"
echo "wrote $out ($dur s)"
