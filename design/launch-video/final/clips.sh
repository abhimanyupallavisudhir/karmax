#!/bin/sh
# One short clip per feature scene of the final film, for posting natively on X, LinkedIn and the like.
#   ./clips.sh <film.mp4> <out-dir>      e.g. ./clips.sh launch-video-final/tavya-launch-portrait.mp4 launch-video-final/clips/portrait
# Scene times are the timeline's (timeline.js: next(…) durations from 0); change them together.
set -e
FILM=$1; OUT=$2
FFMPEG=${FFMPEG:-$(command -v ffmpeg || python3 -c "import imageio_ffmpeg as f; print(f.get_ffmpeg_exe())")}
mkdir -p "$OUT"
# name start end (seconds)
while read -r name start end; do
  [ -z "$name" ] && continue
  dur=$(python3 -c "print(round($end - $start, 2))"); fade=$(python3 -c "print(round($end - $start - 0.4, 2))")
  "$FFMPEG" -nostdin -hide_banner -loglevel error -y -ss "$start" -i "$FILM" -t "$dur" \
    -vf "fade=t=in:st=0:d=0.25,fade=t=out:st=$fade:d=0.4" -af "afade=t=in:st=0:d=0.25,afade=t=out:st=$fade:d=0.4" \
    -c:v libx264 -preset slow -crf 20 -pix_fmt yuv420p -c:a aac -b:a 160k -movflags +faststart "$OUT/$name.mp4"
  echo "$OUT/$name.mp4"
done <<SCENES
01-one-list 3.0 8.2
02-say-what-needs-doing 8.2 13.6
03-their-own-computers 13.6 17.8
04-big-jobs-fan-out 17.8 22.4
05-accounts-keys-and-a-card 22.4 26.4
06-review-and-approve 26.4 32.8
07-the-autonomous-company 32.8 46.0
08-any-model-your-subscription 46.0 49.6
09-not-just-code 49.6 54.0
SCENES
