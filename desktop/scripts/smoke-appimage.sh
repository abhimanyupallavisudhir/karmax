#!/usr/bin/env bash
# Starts a built AppImage the way a person would on this machine, and checks it
# stays up and that a second launch with a link hands it over and exits 0.
# desktop.yml runs it on GitHub's current Ubuntu, which (like Ubuntu 24.04+)
# restricts unprivileged user namespaces through AppArmor: there the AppImage's
# AppRun (electron-builder) must start Electron with --no-sandbox, or Chromium
# aborts with "The SUID sandbox helper binary was found, but is not configured
# correctly". Needs a display (xvfb-run) and FUSE 2.
#   scripts/smoke-appimage.sh dist/tavya-1.0.0-x86_64.AppImage
set -euo pipefail
appimage="$(readlink -f "$1")"
work="$(mktemp -d)"
# The app runs in its own process group, so stopping it stops Electron's children too.
trap 'kill -- -"$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; sleep 1; rm -rf "$work"' EXIT
export TAVYA_URL=http://127.0.0.1:9 TAVYA_DESKTOP_USER_DATA="$work/profile"
if unshare -Ur true 2>/dev/null; then echo "user namespaces: usable (the AppImage keeps Chromium's sandbox)"
else echo "user namespaces: restricted (the AppImage starts with --no-sandbox)"; fi
setsid "$appimage" >"$work/first.log" 2>&1 &
pid=$!
sleep 10
if ! kill -0 "$pid" 2>/dev/null; then
  echo "::error title=AppImage did not start::$(tail -c 1500 "$work/first.log" | tr '\n' ' ')"
  exit 1
fi
if ! timeout 30 "$appimage" 'io.tavya.app://open?path=/' >"$work/second.log" 2>&1; then
  echo "::error title=Second launch failed::$(tail -c 1500 "$work/second.log" | tr '\n' ' ')"
  exit 1
fi
kill -0 "$pid" && echo "the AppImage runs, and a second launch with a link handed over and quit"
