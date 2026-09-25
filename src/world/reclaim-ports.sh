#!/bin/sh
# Stop whatever is listening on the given TCP ports, so a review server can bind.
#
# An agent that verifies its own dev server usually leaves it running in the
# sandbox. The reviewer's "Live preview" then fails with EADDRINUSE and the
# preview never opens (task 364, 2026-09-25). The review action owns the ports
# it declares, so the stale listener is stopped: SIGTERM, then SIGKILL if the
# port is still bound after five seconds.
#
# Runs only inside an isolated task world (never on a host someone else uses).
# Needs nothing but /proc, awk and ls, which every sandbox image has. Prints one
# line per stopped process: "<port> <pid> <command line>".
#
#   sh reclaim-ports.sh 4173 [5173 ...]
set -u
PROC=${KARMAX_RECLAIM_PROC:-/proc}

# Socket inodes of listening TCP sockets (state 0A) on the port. The local
# address column is "<hex address>:<hex port>" for IPv4 and IPv6 alike.
listening_inodes() {
  awk -v port="$(printf '%04X' "$1")" \
    'FNR > 1 && $4 == "0A" { n = split($2, a, ":"); if (toupper(a[n]) == port) print $10 }' \
    "$PROC/net/tcp" "$PROC/net/tcp6" 2>/dev/null
}

# PIDs holding any of the inodes. One `ls` over every fd directory is far
# cheaper than a readlink per descriptor in a busy sandbox.
holders() {
  # shellcheck disable=SC2086
  ls -l "$PROC"/[0-9]*/fd 2>/dev/null | awk -v inodes=" $* " -v me="$$" '
    /\/fd:$/ { pid = $0; sub(/\/fd:$/, "", pid); sub(/^.*\//, "", pid); next }
    {
      target = $NF
      if (target !~ /^socket:\[[0-9]+\]$/) next
      gsub(/[^0-9]/, "", target)
      if (index(inodes, " " target " ") && pid != me && pid != 1 && !(pid in seen)) { seen[pid] = 1; print pid }
    }'
}

for port in "$@"; do
  case $port in ''|*[!0-9]*) continue ;; esac
  inodes=$(listening_inodes "$port")
  [ -n "$inodes" ] || continue
  # shellcheck disable=SC2086
  pids=$(holders $inodes)
  [ -n "$pids" ] || continue
  for pid in $pids; do
    printf '%s %s %s\n' "$port" "$pid" "$(tr '\0\n\t' '   ' < "$PROC/$pid/cmdline" 2>/dev/null | cut -c1-200 | sed 's/  */ /g; s/ *$//')"
  done
  # shellcheck disable=SC2086
  kill -TERM $pids 2>/dev/null
  tries=0
  while [ -n "$(listening_inodes "$port")" ] && [ "$tries" -lt 50 ]; do
    sleep 0.1
    tries=$((tries + 1))
  done
  # shellcheck disable=SC2086
  [ -z "$(listening_inodes "$port")" ] || kill -KILL $pids 2>/dev/null
done
exit 0
