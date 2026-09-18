# Caddy with rate limiting compiled in.
#
# `rate_limit` is a third-party module: the stock `caddy` image does not ship it
# and Caddy refuses to start on a directive it does not recognise, so the zones
# in deploy/Caddyfile are only valid against this image. Pinned deliberately —
# an unpinned edge proxy is a silent upgrade in front of every request.
FROM caddy:2.10-builder-alpine AS builder
COPY build-caddy.sh /usr/local/bin/build-caddy.sh
RUN sh /usr/local/bin/build-caddy.sh

FROM caddy:2.10-alpine
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
