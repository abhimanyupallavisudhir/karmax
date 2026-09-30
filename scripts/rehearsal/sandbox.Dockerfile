# syntax=docker/dockerfile:1.7
# The rehearsal's stand-in for an E2B sandbox: E2B's own sandbox daemon (the
# released envd binary, checksum-pinned) in an image with the tools of
# karmax's E2B template. scripts/rehearsal/fake-e2b.ts runs one per sandbox.
FROM node:22-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c
RUN apt-get update \
    && apt-get install -y --no-install-recommends bash ca-certificates curl git jq openssh-client python3 ripgrep sudo \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --shell /bin/bash user \
    && echo 'user ALL=(ALL:ALL) NOPASSWD: ALL' > /etc/sudoers.d/user
ADD --checksum=sha256:c42a31d738718b5cf7654e258e5b111308646a905331b266294cdcbeb0a02355 --chmod=755 \
    https://storage.googleapis.com/e2b-artifact-binaries/envd/v0.9.0/envd /usr/bin/envd
EXPOSE 49983
ENTRYPOINT ["/usr/bin/envd", "-isnotfc", "-no-cgroups"]
