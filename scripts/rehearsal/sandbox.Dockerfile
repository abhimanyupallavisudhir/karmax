# syntax=docker/dockerfile:1.7
# The rehearsal's stand-in for an E2B sandbox: E2B's own sandbox daemon (the
# released envd binary, checksum-pinned) in an image with the tools of
# karmax's E2B template. scripts/rehearsal/fake-e2b.ts runs one per sandbox.
FROM node:25-bookworm-slim@sha256:81db02c4b671288a03915da9534dbd54f96d0e7c24d80ccc54f5b36b2e684370
RUN apt-get update \
    && apt-get install -y --no-install-recommends bash ca-certificates curl git jq openssh-client python3 ripgrep sudo \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --shell /bin/bash user \
    && echo 'user ALL=(ALL:ALL) NOPASSWD: ALL' > /etc/sudoers.d/user
ADD --checksum=sha256:c42a31d738718b5cf7654e258e5b111308646a905331b266294cdcbeb0a02355 --chmod=755 \
    https://storage.googleapis.com/e2b-artifact-binaries/envd/v0.9.0/envd /usr/bin/envd
EXPOSE 49983
ENTRYPOINT ["/usr/bin/envd", "-isnotfc", "-no-cgroups"]
