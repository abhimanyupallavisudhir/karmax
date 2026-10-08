#!/usr/bin/env bash
# Boots the system under test on its VM (run by benchmarks/load/run.sh over SSH):
# the turnkey stack exactly as tavya.io runs it (deploy/karmax up: hosted
# mode, PostgreSQL, Temporal, the app with its process-mode worker, Caddy,
# the same container memory caps), plus only what measuring it needs:
#
#  * Caddy holds a self-signed certificate for the made-up domain, as the
#    upgrade rehearsal does, so HTTPS through the edge works without ACME.
#  * The edge's per-client rate-limit keys add the X-Load-Client header to the
#    peer address. Every synthetic tenant arrives from the load generator's one
#    address; with this each tenant gets the budget a customer on their own
#    address gets, and the limiter still does all of its work.
#  * compose.override.yml points the app's E2B SDK at the stand-in on the world
#    VM, preloads probe.mjs into every Node process (heap, event-loop delay,
#    GC), and turns on the Temporal server's Prometheus endpoint.
#
#   sut-setup.sh SOURCE_TARBALL HARNESS_DIR DOMAIN WORLD_IP ADMIN_EMAIL ADMIN_PASSWORD
set -euo pipefail
SOURCE=$1 HARNESS=$2 DOMAIN=$3 WORLD_IP=$4 ADMIN_EMAIL=$5 ADMIN_PASSWORD=$6
ROOT=/opt/karmax
LOADTEST=/opt/loadtest
say() { printf '\n== %s %s\n' "$(date -u +%H:%M:%S)" "$*"; }

say 'Docker and Node'
"$HARNESS/install-tools.sh"

say 'Source'
sudo rm -rf "$ROOT" && sudo mkdir -p "$ROOT" "$LOADTEST/probe" && sudo chown "$(id -u):$(id -g)" "$ROOT" "$LOADTEST"
tar -xzf "$SOURCE" -C "$ROOT"
cp "$HARNESS/probe.mjs" "$HARNESS/collector.ts" "$LOADTEST/"
# The app runs as uid 10001 and writes its probe files here.
chmod 0777 "$LOADTEST/probe"
cd "$ROOT"
export COMPOSE_PROJECT_NAME=karmax

say 'Edge certificate and per-tenant rate-limit keys'
# As scripts/rehearse-upgrade.sh does: Caddy loads a certificate it finds in
# storage instead of asking an ACME CA for one.
volume=karmax_caddy_data
docker volume inspect "$volume" >/dev/null 2>&1 || docker volume create \
  --label com.docker.compose.project=karmax --label com.docker.compose.volume=caddy_data \
  --label com.docker.compose.version="$(docker compose version --short)" "$volume" >/dev/null
seed=$(mktemp -d)
dir=$seed/caddy/certificates/acme-v02.api.letsencrypt.org-directory/$DOMAIN
mkdir -p "$dir"
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 30 -subj "/CN=$DOMAIN" \
  -addext "subjectAltName=DNS:$DOMAIN" -keyout "$dir/$DOMAIN.key" -out "$dir/$DOMAIN.crt" 2>/dev/null
printf '{"sans":["%s"],"issuer_data":{"url":"https://acme-v02.api.letsencrypt.org/directory"}}' "$DOMAIN" > "$dir/$DOMAIN.json"
cp "$dir/$DOMAIN.crt" "$LOADTEST/edge.crt"
docker run --rm -v "$volume:/data" -v "$seed:/seed:ro" alpine:3.20 cp -r /seed/caddy /data/
rm -rf "$seed"
grep -c 'key {http.request.remote.host}$' deploy/Caddyfile >/dev/null \
  || { echo 'sut-setup: the Caddyfile no longer keys rate limits on {http.request.remote.host}; update the override' >&2; exit 1; }
sed -i 's/key {http.request.remote.host}$/key {http.request.remote.host}-{http.request.header.X-Load-Client}/' deploy/Caddyfile

say 'Turnkey stack (deploy/karmax up)'
./deploy/karmax up "$DOMAIN" "preview.$DOMAIN"

say 'Load-test override (E2B stand-in, probes, Temporal metrics)'
dc() { docker compose --project-directory deploy --env-file deploy/.turnkey.env -f deploy/compose.turnkey.yml "$@"; }
# Keep whatever NODE_OPTIONS the release sets (a heap limit, say) and add the probe.
base_options=$(dc config --format json | python3 -c 'import json,sys; print(json.load(sys.stdin)["services"]["app"].get("environment",{}).get("NODE_OPTIONS","") or "")')
cat > "$LOADTEST/compose.override.yml" <<EOF
services:
  app:
    environment:
      E2B_API_URL: http://$WORLD_IP:13000
      E2B_SANDBOX_URL: http://$WORLD_IP:13001
      NODE_OPTIONS: "${base_options:+$base_options }--import=/loadtest/probe.mjs"
      LOADTEST_PROBE_DIR: /loadtest/probe
    volumes:
      - $LOADTEST/probe.mjs:/loadtest/probe.mjs:ro
      - $LOADTEST/probe:/loadtest/probe
  temporal:
    environment:
      PROMETHEUS_ENDPOINT: 0.0.0.0:8000
    ports: ["127.0.0.1:8000:8000"]
EOF
dc -f "$LOADTEST/compose.override.yml" up -d --no-build app temporal
for attempt in $(seq 1 90); do
  curl -fsS -o /dev/null http://127.0.0.1:4505/api/health/ready && break
  [ "$attempt" -lt 90 ] || { docker logs --tail 80 karmax-app-1; exit 1; }
  sleep 2
done
ls "$LOADTEST/probe" | grep -q . || { echo 'sut-setup: the probe wrote nothing' >&2; exit 1; }

say 'First administrator'
status=$(curl -sS -o /tmp/setup.json -w '%{http_code}' http://127.0.0.1:4505/api/setup \
  -H "host: $DOMAIN" -H "origin: https://$DOMAIN" -H 'x-forwarded-proto: https' -H 'content-type: application/json' \
  --data "$(python3 -c 'import json,sys; print(json.dumps({"name":"Load Admin","email":sys.argv[1],"password":sys.argv[2]}))' "$ADMIN_EMAIL" "$ADMIN_PASSWORD")")
[ "$status" = 200 ] || [ "$status" = 201 ] || { echo "sut-setup: /api/setup → $status: $(cat /tmp/setup.json)" >&2; exit 1; }

say 'Collector'
sudo systemctl stop loadtest-collector 2>/dev/null || true
sudo systemd-run --unit loadtest-collector --uid "$(id -u)" --gid "$(id -g)" --working-directory "$LOADTEST" \
  /opt/node/bin/node --experimental-strip-types --no-warnings "$LOADTEST/collector.ts" --out "$LOADTEST/samples.jsonl" \
  --origin "https://$DOMAIN" --admin-email "$ADMIN_EMAIL" --admin-password "$ADMIN_PASSWORD" --every 5
sleep 15
grep -q '"kind":"postgres"' "$LOADTEST/samples.jsonl" || { echo 'sut-setup: the collector recorded no PostgreSQL sample' >&2; tail -5 "$LOADTEST/samples.jsonl" >&2; exit 1; }
grep '"kind":"collector-error"' "$LOADTEST/samples.jsonl" | tail -5 || true
say "System under test ready: $(git -C "$ROOT" rev-parse HEAD 2>/dev/null || cat "$ROOT/REVISION")"
