#!/bin/sh
# Karmax sandbox memory guard: kill the hungriest command before RAM runs out.
#
# Remote sandboxes have no swap, and karmax sets vm.overcommit_memory=1 so
# Chrome can start, so allocations never fail. When a command such as
# `tsc --max-old-space-size=1700` outgrows a 2 GB sandbox, Linux does not
# OOM-kill it promptly: it evicts program text and thrashes, freezing E2B's
# envd for up to 19 minutes (tasks 348/349, 2026-09-24). That froze every
# karmax call into the sandbox and killed the agent's turn.
#
# Like earlyoom, this polls MemAvailable (or, in a container such as a
# Daytona sandbox, the cgroup's own limit) and, below 5% of RAM (64–256 MB), sends
# SIGKILL to the process with the highest kernel oom_score. Unlike earlyoom it
# needs no package or root, and it never kills the agent (claude/codex) or any
# of its ancestors. The victim's stderr gets a one-line explanation first, so
# the agent sees why its command died.
#
#   sh memory-guard.sh start   start one detached guard per sandbox (idempotent)
#   sh memory-guard.sh pick    print the PID it would kill now (diagnostics/tests)
set -u
PROC=${KARMAX_GUARD_PROC:-/proc}
CGROUP=${KARMAX_GUARD_CGROUP:-/sys/fs/cgroup}
INTERVAL=${KARMAX_GUARD_INTERVAL:-0.5}
DIR=$(cd "$(dirname "$0")" && pwd)
PIDFILE=$DIR/memory-guard.pid
LOG=$DIR/memory-guard.log
ME=$(id -u)

read_meminfo() {
  total_kb=0 avail_kb=0
  while read -r key value _; do
    case $key in MemTotal:) total_kb=$value ;; MemAvailable:) avail_kb=$value ;; esac
  done < "$PROC/meminfo"
  read_cgroup
  limit_kb=$((total_kb / 20))
  [ "$limit_kb" -lt 65536 ] && limit_kb=65536
  [ "$limit_kb" -gt 262144 ] && limit_kb=262144
}

# A container (Daytona) sees the host's memory in meminfo; its own limit is
# the cgroup's. Use it when it is the tighter one: usage minus reclaimable
# page cache (inactive_file) is what the kernel cannot give back.
read_cgroup() {
  [ -r "$CGROUP/memory.max" ] && [ -r "$CGROUP/memory.current" ] || return 0
  read -r max_b < "$CGROUP/memory.max" || return 0
  case $max_b in ''|*[!0-9]*) return 0 ;; esac
  read -r current_b < "$CGROUP/memory.current" || return 0
  case $current_b in ''|*[!0-9]*) return 0 ;; esac
  max_kb=$((max_b / 1024))
  [ "$total_kb" -gt 0 ] && [ "$max_kb" -ge "$total_kb" ] && return 0
  inactive_kb=0
  if [ -r "$CGROUP/memory.stat" ]; then
    while read -r key value; do
      [ "$key" = inactive_file ] && inactive_kb=$((value / 1024))
    done < "$CGROUP/memory.stat"
  fi
  total_kb=$max_kb
  avail_kb=$((max_kb - current_b / 1024 + inactive_kb))
  [ "$avail_kb" -lt 1 ] && avail_kb=1
  return 0
}

low_memory() { read_meminfo; [ "$avail_kb" -gt 0 ] && [ "$avail_kb" -lt "$limit_kb" ]; }

# Sets $ppid, $owner and $rss_kb for process $1.
read_status() {
  ppid='' owner='' rss_kb=0
  while read -r key value _; do
    case $key in PPid:) ppid=$value ;; Uid:) owner=$value ;; VmRSS:) rss_kb=$value ;; esac
  done < "$PROC/$1/status"
}

# The agent and every ancestor of it (its Node relay, npm, the PTY shell).
protected_pids() {
  protected=" $$ 1 "
  for dir in "$PROC"/[0-9]*; do
    read -r comm < "$dir/comm" 2>/dev/null || continue
    case $comm in claude|codex) ;; *) continue ;; esac
    pid=${dir##*/}
    while [ -n "$pid" ] && [ "$pid" -gt 1 ] 2>/dev/null; do
      protected="$protected$pid "
      read_status "$pid" 2>/dev/null || break
      pid=$ppid
    done
  done
}

# Sets $victim to the killable process with the highest oom_score, or ''.
choose_victim() {
  protected_pids
  victim='' best=0
  for dir in "$PROC"/[0-9]*; do
    pid=${dir##*/}
    case $protected in *" $pid "*) continue ;; esac
    read -r score < "$dir/oom_score" 2>/dev/null || continue
    [ "$score" -gt "$best" ] || continue
    read_status "$pid" 2>/dev/null || continue
    [ "$owner" = "$ME" ] || continue
    victim=$pid best=$score
  done
}

kill_victim() {
  read_status "$victim" 2>/dev/null || return 0
  command=$(tr '\0' ' ' < "$PROC/$victim/cmdline" 2>/dev/null | cut -c1-160)
  command=${command% }
  message="karmax memory guard: killed PID $victim ($command) using $((rss_kb / 1024)) MB: the sandbox had $((avail_kb / 1024)) MB of $((total_kb / 1024)) MB memory left. Use less memory (e.g. a smaller --max-old-space-size or fewer test workers)."
  # Best effort, bounded: a full pipe must never stall the guard.
  if command -v timeout >/dev/null 2>&1; then
    timeout 1 sh -c 'printf "\n%s\n" "$1" >> "$2"' guard "$message" "$PROC/$victim/fd/2" 2>/dev/null
  fi
  kill -9 "$victim" 2>/dev/null || return 0
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$message" >> "$LOG"
}

run() {
  trap '' HUP
  running && exit 0
  echo $$ > "$PIDFILE"
  while :; do
    # Stop once replaced or the injection directory is gone.
    read -r owner_pid < "$PIDFILE" 2>/dev/null || exit 0
    [ "$owner_pid" = "$$" ] || exit 0
    if low_memory; then
      choose_victim
      if [ -n "$victim" ]; then kill_victim; sleep 2; continue; fi
    fi
    sleep "$INTERVAL"
  done
}

running() {
  [ -s "$PIDFILE" ] || return 1
  read -r old < "$PIDFILE"
  case $(tr '\0' ' ' < "/proc/$old/cmdline" 2>/dev/null) in *memory-guard.sh\ run*) return 0 ;; esac
  return 1
}

case ${1:-} in
  start)
    running && exit 0
    if command -v setsid >/dev/null 2>&1; then setsid sh "$0" run </dev/null >/dev/null 2>&1 &
    else sh "$0" run </dev/null >/dev/null 2>&1 &
    fi
    # Wait (≤2 s) for its pidfile so an immediate second start sees it.
    tries=0
    while ! running && [ "$tries" -lt 20 ]; do sleep 0.1; tries=$((tries + 1)); done ;;
  run) run ;;
  pick) if low_memory; then choose_victim; [ -n "$victim" ] && echo "$victim"; fi; exit 0 ;;
  *) echo "usage: $0 start|pick" >&2; exit 2 ;;
esac
