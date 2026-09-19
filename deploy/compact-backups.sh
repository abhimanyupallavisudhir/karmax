#!/bin/sh
# Completed backup payloads are immutable. Share identical object-store files
# between snapshots without removing any restore point or touching live data.
set -eu

backups=${1:-"$(dirname "$0")/backups"}
if ! command -v hardlink >/dev/null 2>&1; then
  echo 'Backup compaction skipped: install util-linux hardlink to share duplicate object files.' >&2
  exit 0
fi
[ -d "$backups" ] && [ ! -L "$backups" ] || exit 0

set --
for snapshot in "$backups"/*; do
  [ -d "$snapshot" ] && [ ! -L "$snapshot" ] || continue
  [ -s "$snapshot/control-plane/manifest.json" ] || continue
  [ -s "$snapshot/temporal.dump" ] && [ -s "$snapshot/temporal-visibility.dump" ] || continue
  # Never follow a substituted payload root into the live volume or elsewhere.
  [ ! -L "$snapshot/control-plane" ] && [ ! -L "$snapshot/control-plane/payload" ] || continue
  objects="$snapshot/control-plane/payload/objects"
  [ -d "$objects" ] && [ ! -L "$objects" ] || continue
  set -- "$@" "$objects"
done
[ "$#" -gt 1 ] || exit 0

# hardlink compares contents, owner and mode before replacing a duplicate with
# a link. Ignore timestamps only: backup manifests verify sizes and SHA-256,
# and the immutable object bytes are unchanged. Small files are not the disk
# pressure source; leave them alone to keep repeated deployment scans cheap.
nice -n 19 hardlink --ignore-time --respect-name --minimum-size 1M "$@"
