#!/bin/bash
# The landing's copy of a render: a small web encode (H.264 CRF 28, AAC 128k, +faststart)
# and a poster (the settled title card, 2.5 s in). Usage: web.sh FILM.mp4 web/media/NAME
#   → web/media/NAME.mp4 and web/media/NAME-poster.jpg
set -euo pipefail
film=$1; out=$2
ffmpeg -loglevel error -y -i "$film" -c:v libx264 -preset slow -crf "${CRF:-28}" -profile:v high -pix_fmt yuv420p -r 30 \
  -c:a aac -b:a 128k -movflags +faststart "$out.mp4"
ffmpeg -loglevel error -y -ss 2.5 -i "$film" -frames:v 1 -q:v 3 "$out-poster.jpg"
ls -la "$out.mp4" "$out-poster.jpg"
