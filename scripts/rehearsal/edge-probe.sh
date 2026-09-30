#!/usr/bin/env bash
# Probes an installation's public edge (Caddy) from the host it runs on:
#
#   scripts/rehearsal/edge-probe.sh reach DOMAIN
#   scripts/rehearsal/edge-probe.sh addresses DOMAIN LABEL
#
# `reach`: HTTPS to DOMAIN crosses Caddy to the app (its readiness route), the
# response advertises HTTP/3, something listens on UDP 443, and Caddy's
# on-demand TLS permission check (`ask`) gets an answer from the app.
#
# `addresses`: whether the app sees each client's own address. Ten failed
# sign-ins lock one address (LOGIN_MAX_FAILURES in src/gateway/server.ts), so
# address A fails ten times, then B (another IPv6 /64) and C (this host's own
# IPv4 address, not loopback) try once each. If B is refused too, the edge
# presented both as one address: Docker's userland proxy does that to every
# IPv6 client (CI-8). Each attempt uses its own made-up email, so the
# per-account lockout never trips. Needs `sudo -n ip` to give the loopback
# interface two ULA addresses (removed again on exit); without it the check
# prints SKIP and exits 2.
#
# Exit 0: all good; 1: a check failed; 2: could not run. Output is one line per
# check, `ok`/`FAIL`/`SKIP`, for scripts/rehearse-upgrade.sh.
set -uo pipefail

mode=${1:-}; domain=${2:-}; label=${3:-probe}
[ -n "$mode" ] && [ -n "$domain" ] || { sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }
command -v curl >/dev/null || { echo 'SKIP curl is not installed'; exit 2; }

https() { curl -sk --max-time 10 --resolve "$domain:443:$1" "${@:2}"; }
# The installation's Caddy container (its Compose project's, when named).
caddy() { docker ps -q --filter label=com.docker.compose.service=caddy \
  ${COMPOSE_PROJECT_NAME:+--filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME"} | head -n 1; }

reach() {
  local failed=0 code headers ask
  code=$(https 127.0.0.1 -o /dev/null -w '%{http_code}' "https://$domain/api/health/ready") || code=000
  if [ "$code" = 200 ]; then echo "ok   HTTPS through Caddy reaches the app (200)"
  else echo "FAIL HTTPS through Caddy answered $code, not 200"; failed=1; fi
  headers=$(https 127.0.0.1 -o /dev/null -D - "https://$domain/api/health/ready" 2>/dev/null | tr -d '\r')
  if printf '%s\n' "$headers" | grep -qi '^alt-svc:.*h3'; then echo "ok   the response advertises HTTP/3"
  else echo "FAIL no HTTP/3 in Alt-Svc"; failed=1; fi
  if ss -Hlun 'sport = :443' 2>/dev/null | grep -q .; then echo "ok   something listens on UDP 443 (HTTP/3)"
  else echo "FAIL nothing listens on UDP 443"; failed=1; fi
  # Caddy asks the app before minting a preview certificate. A refusal (4xx) is
  # an answer; no answer means Caddy cannot reach the app to ask.
  ask=$(docker exec "$(caddy)" \
    wget -q -S -O /dev/null "$(ask_url)?domain=p-probe.preview.$domain" 2>&1 | awk '/HTTP\//{print $2}' | tail -n 1)
  case "$ask" in
    2??|4??) echo "ok   Caddy's on-demand TLS check reaches the app ($ask)" ;;
    *) echo "FAIL Caddy's on-demand TLS check got no answer from the app"; failed=1 ;;
  esac
  return "$failed"
}

# The `ask` URL the running Caddy was configured with.
ask_url() {
  docker exec "$(caddy)" \
    sed -n 's/^[[:space:]]*ask[[:space:]]\{1,\}\([^[:space:]]*\).*/\1/p' /etc/caddy/Caddyfile | head -n 1
}

A=fd00:7e57:a::1 B=fd00:7e57:b::1
added=()
cleanup() { for address in "${added[@]}"; do sudo -n ip -6 addr del "$address/128" dev lo 2>/dev/null || true; done; }
trap cleanup EXIT

sign_in() { # SOURCE CONNECT-TO EMAIL -> HTTP status
  https "$2" --interface "$1" -o /dev/null -w '%{http_code}' -H 'content-type: application/json' \
    --data "{\"email\":\"$3\",\"password\":\"wrong-$RANDOM\"}" "https://$domain/api/login" || echo 000
}

addresses() {
  local c status attempt b_status c_status failed=0
  for address in "$A" "$B"; do
    ip -6 addr show dev lo | grep -q "$address/" && continue
    sudo -n ip -6 addr add "$address/128" dev lo nodad 2>/dev/null || { echo 'SKIP cannot add IPv6 test addresses to lo (sudo -n ip)'; return 2; }
    added+=("$address")
  done
  c=$(ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p')
  for attempt in $(seq 1 10); do
    status=$(sign_in "$A" '::1' "edge-$label-a$attempt@example.invalid")
    case "$status" in 401|400|403) ;; *) echo "FAIL sign-in $attempt from $A answered $status, not a refusal"; return 1 ;; esac
  done
  status=$(sign_in "$A" '::1' "edge-$label-a11@example.invalid")
  if [ "$status" = 429 ]; then echo "ok   ten failures lock $A (429)"
  else echo "FAIL $A was not locked after ten failures ($status)"; return 1; fi
  b_status=$(sign_in "$B" '::1' "edge-$label-b@example.invalid")
  if [ "$b_status" = 429 ]; then echo "FAIL $B (another IPv6 client) is locked too: the edge shows them as one address"; failed=1
  else echo "ok   $B (another IPv6 client) is not locked ($b_status)"; fi
  if [ -n "$c" ]; then
    c_status=$(sign_in "$c" "$c" "edge-$label-c@example.invalid")
    if [ "$c_status" = 429 ]; then echo "FAIL $c (IPv4) is locked too: the edge shows it as the IPv6 clients' address"; failed=1
    else echo "ok   $c (IPv4) is not locked ($c_status)"; fi
  else echo "SKIP this host has no non-loopback IPv4 address"; fi
  return "$failed"
}

case "$mode" in
  reach) reach ;;
  addresses) addresses ;;
  *) echo "edge-probe: unknown mode $mode" >&2; exit 2 ;;
esac
