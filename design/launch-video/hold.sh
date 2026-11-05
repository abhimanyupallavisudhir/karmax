#!/usr/bin/env bash
# Keep imported unfinished tasks "running" for the reconciler: an execution of a type no
# worker serves, on a queue nobody polls, under each task's workflow id. Nothing runs.
# Usage: design/launch-video/hold.sh EXPORT_DIR/unfinished.txt
T=${TEMPORAL_CLI:-$HOME/.temporalio/bin/temporal}
while read -r id; do
  [ -n "$id" ] && "$T" workflow start --address 127.0.0.1:7233 --task-queue demo-hold --type demoHold --workflow-id "$id" >/dev/null 2>&1 && echo "held $id"
done < "$1"
