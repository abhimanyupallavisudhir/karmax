#!/bin/bash
set -e
REPO=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
W=$(realpath -m "$1"); mkdir -p "$W" && cd "$REPO" && git archive f8cc9f70^ | tar -x -C "$W"
cd "$W" && ln -s "${MODEL_EVAL_DEPS:-/opt/kdeps/node_modules}" node_modules && git init -q && git add -A && git -c user.email=dev@example.com -c user.name=dev commit -qm "karmax"
