#!/bin/bash
# Re-renders this cut from a scene boundary to the end and splices it onto an earlier
# render (scenes before FROM unchanged), then lays the score under the whole film again.
# Usage: splice.sh PREVIOUS.mp4 OUT.mp4 FROM_SECONDS
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd); prev=$(realpath "$1"); out=$(realpath -m "$2"); from=$3
ASSETS=${ASSETS:-/tmp/demo/final-assets}; mkdir -p "$ASSETS"
[ -e "$ASSETS/brand/icon-512.png" ] || { mkdir -p "$ASSETS/brand" && cp "$here/../../../web/brand/royal-gold-arrow/icon-512.png" "$ASSETS/brand/icon-512.png"; }
ASSETS="$ASSETS" node "$here/render.cjs" "$out.tail" --from "$from" --workers "${WORKERS:-2}"
read -r cuts clicks dur < <(python3 -c "import json,sys;d=json.load(open(sys.argv[1]));print(','.join(str(s[0]) for s in d['scenes']), ','.join(str(c) for c in d['clicks']), d['duration'])" "$out.tail.json")
ffmpeg -loglevel error -y -i "$prev" -i "$out.tail.video.mp4" -filter_complex \
  "[0:v]trim=end=$from,setpts=PTS-STARTPTS[a];[1:v]setpts=PTS-STARTPTS[b];[a][b]concat=n=2:v=1:a=0,format=yuv420p[v]" \
  -map "[v]" -c:v libx264 -preset slow -crf 14 -r 30 "$out.video.mp4"
python3 "$here/../first-cut/music.py" "$out.wav" "$cuts" "$clicks" "$dur"
ffmpeg -loglevel error -y -i "$out.video.mp4" -i "$out.wav" -c:v copy -c:a aac -b:a 192k -shortest -movflags +faststart "$out"
rm -f "$out.tail.video.mp4" "$out.tail.json" "$out.video.mp4" "$out.wav"
echo "wrote $out ($dur s)"
