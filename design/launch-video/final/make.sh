#!/bin/bash
# Renders the final cut: frames → H.264, the first cut's score timed to its cuts and clicks, muxed.
# Screens: capture.cjs's (and extras.sh's) in ASSETS. Usage: make.sh OUT.mp4 [render.cjs options]
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd); out=$(realpath -m "$1"); shift || true
ASSETS=${ASSETS:-/tmp/demo/final-assets}
[ -e "$ASSETS/brand/icon-512.png" ] || { mkdir -p "$ASSETS/brand" && cp "$here/../../../web/brand/royal-gold-arrow/icon-512.png" "$ASSETS/brand/icon-512.png"; }
ASSETS="$ASSETS" node "$here/render.cjs" "$out" "$@"
case " $* " in *" --stills "*) exit 0;; esac
read -r cuts clicks dur < <(python3 -c "import json,sys;d=json.load(open(sys.argv[1]));print(','.join(str(s[0]) for s in d['scenes']), ','.join(str(c) for c in d['clicks']), d['duration'])" "$out.json")
python3 "$here/../first-cut/music.py" "$out.wav" "$cuts" "$clicks" "$dur"
ffmpeg -loglevel error -y -i "$out.video.mp4" -i "$out.wav" -c:v copy -c:a aac -b:a 192k -shortest -movflags +faststart "$out"
rm -f "$out.video.mp4" "$out.json" "$out.wav"
echo "wrote $out"
