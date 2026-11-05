#!/usr/bin/env bash
# Render the launch video: frames → H.264, score → AAC, muxed. Usage: make.sh OUT.mp4
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd); out=$(realpath -m "$1")
node "$here/render.cjs" "$out" --workers "${WORKERS:-3}"
read -r cuts clicks dur < <(python3 -c "import json,sys;d=json.load(open(sys.argv[1]));print(','.join(str(s[0]) for s in d['scenes']), ','.join(str(c) for c in d['clicks']), d['duration'])" "$out.json")
python3 "$here/music.py" "$out.wav" "$cuts" "$clicks" "$dur"
ffmpeg -loglevel error -y -i "$out.video.mp4" -i "$out.wav" -c:v copy -c:a aac -b:a 192k -shortest -movflags +faststart "$out"
rm -f "$out.video.mp4" "$out.json"
echo "wrote $out"
