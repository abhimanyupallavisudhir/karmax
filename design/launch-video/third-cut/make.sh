#!/bin/bash
# Renders the third cut: the first cut's compositor and style, #820's soundtrack.
# Screens: the first cut's assets (FIRST, from first-cut/capture.cjs) overlaid with this
# cut's captures (NEW, from capture.cjs). Usage: make.sh OUT.mp4 [render.cjs options]
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd); out=$(realpath -m "$1"); shift || true
FIRST=${FIRST:-/home/user/demo/assets}; NEW=${NEW:-/tmp/demo/v3-assets}; MERGED=${MERGED:-/tmp/demo/v3-render-assets}
rm -rf "$MERGED" && mkdir -p "$MERGED"
for f in "$FIRST"/*; do ln -s "$f" "$MERGED/$(basename "$f")"; done
for f in "$NEW"/*; do n=$(basename "$f"); [ "$n" = shots.json ] && n=v3-shots.json; rm -f "$MERGED/$n"; ln -s "$f" "$MERGED/$n"; done
# tavya.io's logo, from the repository.
[ -e "$MERGED/brand" ] || { mkdir -p "$MERGED/brand" && cp "$here/../../../web/brand/royal-gold-arrow/icon-512.png" "$MERGED/brand/icon-512.png"; }
ASSETS="$MERGED" node "$here/render.cjs" "$out" "$@"
case " $* " in *" --stills "*) exit 0;; esac
dur=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['duration'])" "$out.json")
python3 "$here/../music.py" "$out.wav" "$dur"
ffmpeg -loglevel error -y -i "$out.video.mp4" -i "$out.wav" -c:v copy -c:a aac -b:a 192k -shortest -movflags +faststart "$out"
rm -f "$out.video.mp4" "$out.json" "$out.wav"
echo "wrote $out"
