#!/bin/bash
# The "Not just code" examples, beside capture.cjs's screens: a paper's title page and a
# page with its figures, a website, an AI-generated image, a film still, and a chore.
# Usage: PAPER=paper.pdf IMAGE=image.png FILM=film.mp4 WEBSITE=landing.png extras.sh ASSETS
set -euo pipefail
out=$1; mkdir -p "$out"
pdftoppm -png -r 150 -f 1 -l 1 -singlefile "$PAPER" "$out/ex-paper-1"
pdftoppm -png -r 150 -f "${PAPER_FIGURE_PAGE:-4}" -l "${PAPER_FIGURE_PAGE:-4}" -singlefile "$PAPER" "$out/ex-paper-4"
ffmpeg -loglevel error -y -i "$IMAGE" -vf scale=1240:-2 -q:v 3 "$out/ex-image.jpg"
ffmpeg -loglevel error -y -ss "${FILM_AT:-21}" -i "$FILM" -frames:v 1 -vf scale=1120:-2 -q:v 3 "$out/ex-film.jpg"
ffmpeg -loglevel error -y -i "$WEBSITE" -vf "crop=iw:iw*0.62:0:0,scale=1120:-2" "$out/ex-website.png"
# The booked flight: the agent's message, cropped from capture.cjs's still (2×).
read -r x y w h < <(python3 -c "import json,sys;b=json.load(open(sys.argv[1]))['flight']['boxes']['msg'];print(b['x']*2-48,b['y']*2-40,b['w']*2+96,b['h']*2+80)" "$out/shots.json")
ffmpeg -loglevel error -y -i "$out/flight.png" -vf "crop=$w:$h:$x:$y,scale=1120:-2" "$out/ex-chore.png"
ls "$out"/ex-*
