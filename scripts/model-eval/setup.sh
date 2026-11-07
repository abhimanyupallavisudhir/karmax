#!/bin/bash
# One-time machine setup for run.py (needs sudo; Linux x64). It creates the
# `agent` user every run works as, and gives it, outside any home directory:
# Node, the OpenCode release tavya pins, and a read-only copy of karmax's
# node_modules for the karmax tasks. It makes your home directory private, so
# agents cannot read the graders, the hidden tests or the fixes in git history.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(git -C "$HERE" rev-parse --show-toplevel)
OPT=/opt/model-eval
OPENCODE=$(sed -n "s/^export const OPENCODE_VERSION = '\(.*\)';$/\1/p" "$REPO/src/agent/acp-packages.ts")
NODE=$(node --version)

id agent >/dev/null 2>&1 || sudo useradd -m -s /bin/bash agent
sudo mkdir -p "$OPT" /srv/model-eval
sudo chown "$(id -u):$(id -g)" /srv/model-eval && sudo chmod 711 /srv/model-eval

if [ "$("$OPT/node/bin/node" --version 2>/dev/null)" != "$NODE" ]; then
  curl -fsSL "https://nodejs.org/dist/$NODE/node-$NODE-linux-x64.tar.xz" | sudo tar -xJ -C "$OPT"
  sudo rm -rf "$OPT/node" && sudo mv "$OPT/node-$NODE-linux-x64" "$OPT/node"
fi
sudo env PATH="$OPT/node/bin:$PATH" npm install --silent --no-audit --no-fund --prefix "$OPT/opencode" "opencode-ai@$OPENCODE"

# karmax's dependencies, linked rather than copied; vitest writes its caches here.
sudo rm -rf "$OPT/deps" && sudo mkdir -p "$OPT/deps"
sudo cp -al "$REPO/node_modules" "$OPT/deps/node_modules" 2>/dev/null || sudo cp -a "$REPO/node_modules" "$OPT/deps/node_modules"
for cache in .vite-temp .vite .vitest .cache; do sudo mkdir -p "$OPT/deps/node_modules/$cache" && sudo chmod 1777 "$OPT/deps/node_modules/$cache"; done
sudo mkdir -p "$OPT/cache" && sudo chown agent:agent "$OPT/cache"

chmod 700 "$HOME"
echo "ready: Node $NODE, OpenCode $OPENCODE. Your home directory is now private (chmod 700 \"$HOME\")."
