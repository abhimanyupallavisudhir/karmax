# Caddy with rate limiting compiled in.
#
# `rate_limit` is a third-party module: the stock `caddy` image does not ship it
# and Caddy refuses to start on a directive it does not recognise, so the zones
# in deploy/Caddyfile are only valid against this image. Pinned by digest —
# an unpinned edge proxy is a silent upgrade in front of every request.
FROM caddy:2.10-builder-alpine@sha256:4cff3ae272ea05842adb4546e35961e4947aeea65f80fa1eb62a35b960e84971 AS builder
COPY build-caddy.sh /usr/local/bin/build-caddy.sh
RUN sh /usr/local/bin/build-caddy.sh

FROM caddy:2.10-alpine@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
