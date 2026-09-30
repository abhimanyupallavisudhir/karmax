# Caddy with rate limiting compiled in.
#
# `rate_limit` is a third-party module: the stock `caddy` image does not ship it
# and Caddy refuses to start on a directive it does not recognise, so the zones
# in deploy/Caddyfile are only valid against this image. Pinned by digest —
# an unpinned edge proxy is a silent upgrade in front of every request.
FROM caddy:2.11-builder-alpine@sha256:0aa610043dab5da82ad0a0268e46bb852785e6f5160f12f1c6fe3f42903d7e1b AS builder
COPY build-caddy.sh /usr/local/bin/build-caddy.sh
RUN sh /usr/local/bin/build-caddy.sh

FROM caddy:2.11-alpine@sha256:6aeddd44c3078b0f9a35206472a11420648a79c184603ef95957d0a20044cb2b
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
