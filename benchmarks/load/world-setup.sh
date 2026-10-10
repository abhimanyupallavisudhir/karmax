#!/usr/bin/env bash
# Prepares the world VM (run by benchmarks/load/run.sh over SSH): everything
# outside tavya's host, so none of it takes CPU or memory from the system under
# test.
#
#  * The E2B stand-in (scripts/rehearsal/fake-e2b.ts) with E2B's real envd in
#    one container per sandbox; --pause-mode stop, so parked worlds free their
#    memory, as E2B's do.
#  * WORLD_RTT_MS of added delay on the stand-in's answers (tc netem on its two
#    ports only), standing in for the distance from tavya.io to E2B. Traffic
#    between the load generator and the edge is not delayed.
#  * The load generator's view of the edge: DOMAIN resolves to the system under
#    test and its self-signed certificate is trusted (NODE_EXTRA_CA_CERTS).
#
#   world-setup.sh HARNESS_DIR REHEARSAL_DIR SUT_IP DOMAIN EDGE_CERT WORLD_RTT_MS
set -euo pipefail
HARNESS=$1 REHEARSAL=$2 SUT_IP=$3 DOMAIN=$4 EDGE_CERT=$5 RTT_MS=$6
LOADTEST=/opt/loadtest
SANDBOX_IMAGE=karmax-rehearsal-sandbox
SANDBOX_NETWORK=karmax-rehearsal-sandboxes
FAKE_E2B=karmax-rehearsal-e2b
NODE_IMAGE=node:22-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c
say() { printf '\n== %s %s\n' "$(date -u +%H:%M:%S)" "$*"; }

say 'Docker and Node'
"$HARNESS/install-tools.sh"
sudo mkdir -p "$LOADTEST" && sudo chown "$(id -u):$(id -g)" "$LOADTEST"
cp "$HARNESS/driver.ts" "$LOADTEST/"
cp "$EDGE_CERT" "$LOADTEST/edge.crt"
grep -q " $DOMAIN\$" /etc/hosts || echo "$SUT_IP $DOMAIN" | sudo tee -a /etc/hosts >/dev/null

say 'E2B stand-in'
# Thousands of sandbox containers: room for their addresses and processes.
sudo sysctl -qw fs.inotify.max_user_instances=8192 kernel.pid_max=4194304 net.ipv4.neigh.default.gc_thresh3=16384
docker build -q -t "$SANDBOX_IMAGE" -f "$REHEARSAL/sandbox.Dockerfile" "$REHEARSAL"
docker rm -f "$FAKE_E2B" >/dev/null 2>&1 || true
docker network inspect "$SANDBOX_NETWORK" >/dev/null 2>&1 || docker network create --subnet 10.200.0.0/16 "$SANDBOX_NETWORK" >/dev/null
docker run -d --name "$FAKE_E2B" --restart unless-stopped --network "$SANDBOX_NETWORK" \
  -v /var/run/docker.sock:/var/run/docker.sock -v "$REHEARSAL:/rehearsal:ro" \
  -p 13000:13000 -p 13001:13001 "$NODE_IMAGE" \
  node --experimental-strip-types --no-warnings /rehearsal/fake-e2b.ts --host 0.0.0.0 \
  --api-port 13000 --envd-port 13001 --image "$SANDBOX_IMAGE" --network "$SANDBOX_NETWORK" --pause-mode stop >/dev/null
for attempt in $(seq 1 50); do
  docker logs "$FAKE_E2B" 2>&1 | grep -q 'listening on 0.0.0.0:13001' && break
  [ "$attempt" -lt 50 ] || { docker logs "$FAKE_E2B"; exit 1; }
  sleep 0.5
done
# A sandbox round trip before the delay is added: the stand-in really creates one.
curl -fsS -X POST localhost:13000/sandboxes -H 'content-type: application/json' -d '{"templateID":"probe","timeout":60}' > /tmp/probe.json
probe=$(python3 -c 'import json; print(json.load(open("/tmp/probe.json"))["sandboxID"])')
curl -fsS -X DELETE "localhost:13000/sandboxes/$probe"

say "Remote-world delay: ${RTT_MS} ms on the stand-in's answers"
iface=$(ip route show default | awk '{ print $5; exit }')
sudo tc qdisc del dev "$iface" root 2>/dev/null || true
if [ "$RTT_MS" -gt 0 ]; then
  sudo tc qdisc add dev "$iface" root handle 1: prio
  sudo tc qdisc add dev "$iface" parent 1:3 handle 30: netem delay "${RTT_MS}ms" limit 100000
  for port in 13000 13001; do
    sudo tc filter add dev "$iface" protocol ip parent 1:0 prio 3 u32 match ip sport "$port" 0xffff flowid 1:3
  done
fi

say 'Edge reachable from the load generator'
NODE_EXTRA_CA_CERTS=$LOADTEST/edge.crt /opt/node/bin/node -e "fetch('https://$DOMAIN/api/health/ready').then(async r => { console.log(r.status, await r.text()); process.exit(r.ok ? 0 : 1) }).catch(e => { console.error(e); process.exit(1) })"
say 'World VM ready'
