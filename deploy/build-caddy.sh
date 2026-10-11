#!/bin/sh
set -eu

# Module proxies and the Go checksum service occasionally reset connections.
# Keep successful downloads in Go's cache between attempts, and never disable
# checksum verification or let a failed final build pass.
attempt=1
while :; do
  if xcaddy build --with github.com/mholt/caddy-ratelimit@v0.1.0 \
      --with github.com/caddy-dns/cloudflare@v0.2.4; then
    exit 0
  else
    status=$?
  fi
  if [ "$attempt" -ge 3 ]; then
    exit "$status"
  fi
  delay=$((attempt * 5))
  echo "Caddy build attempt $attempt failed (exit $status); retrying in ${delay}s" >&2
  sleep "$delay"
  attempt=$((attempt + 1))
done
