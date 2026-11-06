#!/usr/bin/env bash
# The landing page's film and stills, made from the launch video (the third
# cut, ≈1:40, "Your turn." ending; project resource "Launch videos (latest)",
# wiki ops/launch-video). Re-run after a new cut:
#   design/landing/film-assets.sh /path/to/tavya-launch-v3.mp4
# Writes web/landing/: film.mp4 (H.264 CRF 28, ≈14 MB, fast start: text stays
# sharp, it streams in ranges), poster.webp (a scene) and one still per
# scene (the console window with the film's dark margin, which blends into the
# page). Frames showing the old approval buttons are avoided on purpose.
set -euo pipefail
SRC=${1:?usage: film-assets.sh <launch video>}
OUT=$(cd "$(dirname "$0")/../../web" && pwd)/landing
mkdir -p "$OUT"

ffmpeg -nostdin -v error -y -i "$SRC" -c:v libx264 -preset slow -crf 28 -pix_fmt yuv420p -profile:v high \
  -movflags +faststart -c:a aac -b:a 128k "$OUT/film.mp4"

# The poster: a scene, not the title card (the page's headline already says
# the tagline, and a play button over the wordmark hides it): an agent buying
# a domain, under the film's gold caption.
ffmpeg -nostdin -v error -y -ss 24 -i "$SRC" -frames:v 1 -vf scale=1600:-1 -c:v libwebp -quality 82 "$OUT/poster.webp"

# name  time(s)  — the scene each still illustrates
while read -r name at; do
  [ -z "$name" ] && continue
  ffmpeg -nostdin -v error -y -ss "$at" -i "$SRC" -frames:v 1 -vf "crop=1520:890:200:190,scale=1216:-1" \
    -c:v libwebp -quality 80 "$OUT/$name.webp"
done <<'SCENES'
list 6
new-task 11.5
working 16.5
vault 21
website 25.5
google-play 31
groceries 35.6
fan-out 39
review 46
ai-review 50.5
agents-manage 55
starts-itself 58.5
not-just-code 64
photos 72
flight 78.5
any-model 83
your-turn 93
SCENES

# The phones are composited on the film's background: keep the whole frame.
ffmpeg -nostdin -v error -y -ss 85.5 -i "$SRC" -frames:v 1 -vf "crop=1520:890:200:150,scale=1216:-1" -c:v libwebp -quality 80 "$OUT/pocket.webp"
ls -la "$OUT"
