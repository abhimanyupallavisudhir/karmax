#!/bin/sh
# Renders Product Hunt's thumbnail (240×240 PNG) and gallery (1270×760 at 2×, JPEG) into product-hunt/out/.
# Needs a Chromium (CHROME=…, default: the one tavya's worlds ship) and ImageMagick.
set -e
cd "$(dirname "$0")"
CHROME=${CHROME:-$(ls /opt/karmax/browsers/chromium-*/chrome-linux64/chrome 2>/dev/null | head -1)}
mkdir -p out
convert ../../../web/brand/royal-gold-arrow/icon-512.png -resize 240x240 out/thumbnail.png
for n in 1 2 3 4 5 6 7 8; do
  "$CHROME" --headless=new --no-sandbox --hide-scrollbars --allow-file-access-from-files --force-device-scale-factor=2 \
    --window-size=1270,760 --virtual-time-budget=3000 --screenshot="$PWD/out/gallery-$n.png" "file://$PWD/gallery.html?n=$n" 2>/dev/null
  convert out/gallery-$n.png -quality 90 out/gallery-$n.jpg && rm out/gallery-$n.png
done
ls -la out
