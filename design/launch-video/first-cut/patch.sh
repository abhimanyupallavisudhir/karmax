#!/bin/bash
# Changes the first cut without its screens, from the original render (63.1 s):
#   - the title card (0–3 s) is re-rendered whole (its tagline changed);
#   - the "VS Code was a fancy text editor…" scene (3.0–6.7 s) is cut out;
#   - for "Work that starts itself" (44.9–50.1 s in the original, 41.2–46.4 s now) only the
#     strip under its headline (y 108–205, where the subtitle was and the boxes are now) is
#     re-rendered, laid over the original frames;
#   - the score is regenerated for the new length, cuts and clicks.
# Everything else is the original's frames. Usage: patch.sh ORIGINAL.mp4 OUT.mp4
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd); orig=$(realpath "$1"); out=$(realpath -m "$2")
work=$(mktemp -d); mkdir -p "$work/assets/brand"
cp "$here/../../../web/brand/royal-gold-arrow/icon-512.png" "$work/assets/brand/icon-512.png"
ASSETS="$work/assets" node "$here/render.cjs" "$work/intro" --from 0 --to 3.0 --workers 2
ASSETS="$work/assets" node "$here/render.cjs" "$work/auto" --from 41.2 --to 46.4 --workers 3
ffmpeg -loglevel error -y -i "$orig" -i "$work/intro.video.mp4" -i "$work/auto.video.mp4" -filter_complex \
  "[0:v]split=3[o1][o2][o3];[1:v]setpts=PTS-STARTPTS[a];[o1]trim=start=6.7:end=44.9,setpts=PTS-STARTPTS[b];\
[o2]trim=start=44.9:end=50.1,setpts=PTS-STARTPTS[c0];[2:v]setpts=PTS-STARTPTS,crop=1920:97:0:108[band];[c0][band]overlay=0:108[c];\
[o3]trim=start=50.1,setpts=PTS-STARTPTS[d];[a][b][c][d]concat=n=4:v=1:a=0,format=yuv420p[v]" \
  -map "[v]" -c:v libx264 -preset slow -crf 14 -r 30 "$work/video.mp4"
read -r cuts clicks dur < <(python3 -c "import json,sys;d=json.load(open(sys.argv[1]));print(','.join(str(s[0]) for s in d['scenes']), ','.join(str(c) for c in d['clicks']), d['duration'])" "$work/intro.json")
python3 "$here/music.py" "$work/score.wav" "$cuts" "$clicks" "$dur"
ffmpeg -loglevel error -y -i "$work/video.mp4" -i "$work/score.wav" -c:v copy -c:a aac -b:a 192k -shortest -movflags +faststart "$out"
rm -rf "$work"
echo "wrote $out"
