#!/bin/bash
# The demo agent's photo sort: albums from /tmp/demo/photo-albums.json, duplicates removed, a contact sheet.
set -e
root=$(dirname "$(find . -maxdepth 4 -type d -name photos -not -path '*/.git/*' | head -1)")
cd "$root"
python3 - <<'PY'
import json, os, shutil
m = json.load(open('/tmp/demo/photo-albums.json'))
for f in os.listdir('photos'):
    p = os.path.join('photos', f)
    if os.path.isdir(p): continue
    if ' (1)' in f or ' copy' in f: os.remove(p); continue
    album = m.get(f)
    if album:
        os.makedirs(os.path.join('photos', album), exist_ok=True)
        shutil.move(p, os.path.join('photos', album, f))
PY
mkdir -p review && rm -f /tmp/demo/sheet-*.png
F=/usr/share/fonts/opentype/inter/Inter-SemiBold.otf
i=0
for d in photos/*/; do
  a=$(basename "$d"); n=$(ls "$d" | wc -l)
  convert -background '#ffffff' -fill '#16161d' -font $F -pointsize 30 label:"$a" -gravity west -extent 1480x64 /tmp/demo/sheet-$i-a.png
  montage "$d"*.jpg -tile 8x -geometry 172x115+5+5 -background '#ffffff' /tmp/demo/sheet-$i-b.png
  convert /tmp/demo/sheet-$i-a.png /tmp/demo/sheet-$i-b.png -background '#ffffff' -append -gravity west -extent 1480x /tmp/demo/sheet-$i.png
  i=$((i+1))
done
convert $(ls /tmp/demo/sheet-?.png | sort) -background '#ffffff' -append -bordercolor '#ffffff' -border 40 review/albums.png
find photos -type f | wc -l
