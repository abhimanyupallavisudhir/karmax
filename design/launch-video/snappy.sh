#!/bin/bash
# The snappy film, in two takes: take A becomes the video the last task delivers
# (so the film loops into its own first frame), take B is the film. Usage: snappy.sh [out.mp4]
set -euo pipefail
T=$(cd "$(dirname "$0")" && pwd); D=${DEMO_DIR:-/tmp/demo}; OUT=${1:-$D/out/tavya-launch.mp4}
cd "$T" && mkdir -p "$(dirname "$OUT")" && rm -rf $D/takeA $D/takeB
# Take A's last task needs a video to deliver before there is one: a placeholder (take B delivers take A).
[ -f $D/assets/launch-v1.mp4 ] || ffmpeg -loglevel error -y -f lavfi -i color=c=white:s=1920x1080:d=2:r=30 -c:v libx264 -pix_fmt yuv420p $D/assets/launch-v1.mp4
bash record.sh $D/takeA
python3 edit.py $D/takeA $D/takeA.mp4 && cp $D/takeA.mp4 $D/assets/launch-v1.mp4 && rm -rf $D/takeA/frames
bash record.sh $D/takeB
python3 edit.py $D/takeB "$OUT" && rm -rf $D/takeB/frames
echo "→ $OUT"
