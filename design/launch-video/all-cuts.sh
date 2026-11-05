#!/bin/bash
# Every cut, in about 35 minutes on 8 CPUs: take A (snappy) becomes the video the
# last task delivers; take B is the snappy film, take C (DEMO_HOLD, longer reading
# holds) the readable one. Each with and without a voiceover (OPENAI_API_KEY),
# each also as a 4:5 portrait cut for phones. Usage: all-cuts.sh [out-dir]
set -euo pipefail
T=$(cd "$(dirname "$0")" && pwd); D=/tmp/demo; O=${1:-$D/out}
cd "$T" && mkdir -p "$O" && rm -rf $D/takeA $D/takeB $D/takeC
bash record.sh $D/takeA
python3 edit.py $D/takeA $D/takeA.mp4 && cp $D/takeA.mp4 $D/assets/launch-v1.mp4 && rm -rf $D/takeA/frames
cut() {  # take, name, edit flags
  python3 edit.py "$1" "$O/$2.mp4" ${3:-}
  python3 voice.py "$O/$2.mp4" "$O/$2-voiceover.mp4"
  python3 mobile.py "$O/$2.mp4" "$O/$2-portrait.mp4"
  python3 mobile.py "$O/$2-voiceover.mp4" "$O/$2-voiceover-portrait.mp4"
  rm -rf "$1/frames"
}
bash record.sh $D/takeB && cut $D/takeB tavya-launch
DEMO_HOLD=1.8 bash record.sh $D/takeC && cut $D/takeC tavya-launch-readable --readable
ls -la "$O"
