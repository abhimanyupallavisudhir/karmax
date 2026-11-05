#!/bin/bash
# Re-renders only the end of the third cut and splices it onto an earlier render, for a
# change to the last scenes when the earlier scenes' screens are not at hand.
# Usage: splice.sh PREVIOUS.mp4 OUT.mp4 FROM_SECONDS   (FROM: a scene boundary; scenes before it unchanged)
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd); prev=$(realpath "$1"); out=$(realpath -m "$2"); from=$3
NEW=${NEW:-/tmp/demo/v3-assets}; MERGED=${MERGED:-/tmp/demo/v3-render-assets}; FIRST=${FIRST:-}
rm -rf "$MERGED" && mkdir -p "$MERGED"
[ -n "$FIRST" ] && for f in "$FIRST"/*; do ln -s "$f" "$MERGED/$(basename "$f")"; done
for f in "$NEW"/*; do n=$(basename "$f"); [ "$n" = shots.json ] && n=v3-shots.json; rm -f "$MERGED/$n"; ln -s "$f" "$MERGED/$n"; done
# tavya.io's logo, from the repository.
[ -e "$MERGED/brand" ] || { mkdir -p "$MERGED/brand" && cp "$here/../../../web/brand/royal-gold-arrow/icon-512.png" "$MERGED/brand/icon-512.png"; }
ASSETS="$MERGED" node "$here/render.cjs" "$out.tail" --from "$from" --workers "${WORKERS:-3}"
dur=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['duration'])" "$out.tail.json")
# The earlier render up to FROM, then the new tail; one encode, so the cut is frame-exact.
ffmpeg -loglevel error -y -i "$prev" -i "$out.tail.video.mp4" -filter_complex \
  "[0:v]trim=end=$from,setpts=PTS-STARTPTS[a];[1:v]setpts=PTS-STARTPTS[b];[a][b]concat=n=2:v=1:a=0,format=yuv420p[v]" \
  -map "[v]" -c:v libx264 -preset slow -crf 14 -r 30 "$out.video.mp4"
read -r cuts clicks < <(python3 -c "import json,sys;d=json.load(open(sys.argv[1]));print(','.join(str(s[0]) for s in d['scenes']), ','.join(str(c) for c in d['clicks']))" "$out.tail.json")
python3 "$here/../first-cut/music.py" "$out.wav" "$cuts" "$clicks" "$dur"  # the first cut's score
ffmpeg -loglevel error -y -i "$out.video.mp4" -i "$out.wav" -c:v copy -c:a aac -b:a 192k -shortest -movflags +faststart "$out"
rm -f "$out.tail.video.mp4" "$out.tail.json" "$out.video.mp4" "$out.wav"
echo "wrote $out ($dur s)"
