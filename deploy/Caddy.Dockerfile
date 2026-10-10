# Caddy with rate limiting and Cloudflare DNS compiled in.
#
# `rate_limit` and `dns cloudflare` (the previews' wildcard certificate) are
# third-party modules: the stock `caddy` image ships neither, and Caddy refuses
# to start on a directive it does not recognise, so deploy/Caddyfile is only
# valid against this image. Pinned by digest, and the modules by version in
# build-caddy.sh: an unpinned edge proxy is a silent upgrade in front of every
# request. No credential is built in; the DNS token is a Compose secret.
FROM caddy:2.10-builder-alpine@sha256:4cff3ae272ea05842adb4546e35961e4947aeea65f80fa1eb62a35b960e84971 AS builder
COPY build-caddy.sh /usr/local/bin/build-caddy.sh
RUN sh /usr/local/bin/build-caddy.sh

FROM caddy:2.10-alpine@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
