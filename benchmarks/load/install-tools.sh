#!/usr/bin/env bash
# Docker Engine with Compose, and Node 22 at /opt/node, on a fresh Ubuntu VM.
# The VMs are disposable and single-purpose, so the Docker socket is opened to
# the login user instead of waiting for a new login to pick up the group.
set -euo pipefail
NODE_VERSION=22.16.0
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sudo sh >/dev/null
fi
sudo chmod 666 /var/run/docker.sock
docker compose version >/dev/null
if [ ! -x /opt/node/bin/node ]; then
  tarball=node-v$NODE_VERSION-linux-x64.tar.xz
  curl -fsSLO "https://nodejs.org/dist/v$NODE_VERSION/$tarball"
  curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt" | grep " $tarball\$" | sha256sum -c - >/dev/null
  sudo mkdir -p /opt/node && sudo tar -xJf "$tarball" -C /opt/node --strip-components=1 && rm -f "$tarball"
fi
/opt/node/bin/node --version
