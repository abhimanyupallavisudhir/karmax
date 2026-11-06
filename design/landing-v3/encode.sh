#!/bin/bash
# The landing's screenshots (shoot.cjs's PNGs) as WebP in web/media/landing/. Usage: encode.sh /tmp/landing-shots
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd); src=${1:-/tmp/landing-shots}; dst="$here/../../web/media/landing"
mkdir -p "$dst"
for f in "$src"/*-light.png "$src"/*-dark.png; do
  n=$(basename "$f" .png)
  if command -v cwebp >/dev/null; then cwebp -quiet -q 86 -m 6 "$f" -o "$dst/$n.webp"
  else ffmpeg -loglevel error -y -i "$f" -c:v libwebp -quality 86 -compression_level 6 "$dst/$n.webp"; fi
  echo "$n.webp $(python3 -c "import struct,sys;d=open(sys.argv[1],'rb').read(24);print('%dx%d'%struct.unpack('>II',d[16:24]))" "$f")"
done
