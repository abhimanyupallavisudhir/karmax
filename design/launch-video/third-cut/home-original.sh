#!/bin/bash
# The first cut's home screen (its "Every project. One list." list), recovered from the
# first cut's render: at 7.5 s its window has fully entered, the camera is at 1× and the
# cursor is still hidden. The console's part of the window (1400×829 at 280,251 of the
# 1080p frame: scale 1400/1440 about the window's top centre, under a 40 px bar) is scaled
# back to 1440 wide; the 47 px below the frame, never on screen in this cut, are padded.
# Usage: home-original.sh FIRST_CUT.mp4 OUT_DIR   → OUT_DIR/home-original.png
set -euo pipefail
ffmpeg -loglevel error -y -i "$1" -vf "select=eq(n\,225),crop=1400:829:280:251,scale=1440:-1:flags=lanczos,pad=1440:900:0:0:color=0xf7f7f8" \
  -frames:v 1 "$2/home-original.png"
echo "wrote $2/home-original.png"
