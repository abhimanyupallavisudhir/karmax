#!/bin/sh
# Karmax disk guard: measure a world's disk and memory, and keep it able to start.
#
# A world whose disk is full cannot even start its agent: the harness needs to
# write its config, logs and session (pramana#3, 2026-10-07: two agents died
# with exit 127 on a 22 GB disk filled by a failed build). So every world keeps
# a ballast file of reserved space. Before an agent starts, karmax runs `check`:
# if free space is critically low the ballast is deleted (and the agent told);
# once there is room again it is made again. `largest` names what filled the
# disk, including deleted files a process still holds open.
#
# karmax runs this inline (`sh -c "<script>" disk-guard check ROOT`): a full
# disk may refuse even the upload of a file.
#
#   check ROOT     print one KARMAX_USAGE line; release or restore the ballast
#   largest ROOT   print "P <kb> <path>" and "H <kb> <pid> <command>\t<path>" lines
set -u
CMD=${1:-check}
ROOT=${2:-.}
PROC=${KARMAX_GUARD_PROC:-/proc}
CGROUP=${KARMAX_GUARD_CGROUP:-/sys/fs/cgroup}
BALLAST=$ROOT/.karmax-injection/ballast
BALLAST_KB=${KARMAX_BALLAST_KB:-524288}
# Below this much free space the ballast goes; with this much to spare beyond
# the ballast itself, it comes back.
CRITICAL_KB=${KARMAX_DISK_CRITICAL_KB:-262144}
RESTORE_KB=${KARMAX_DISK_RESTORE_KB:-2097152}
LARGEST_MIN_KB=${KARMAX_LARGEST_MIN_KB:-65536}

read_disk() {
  set -- $(df -Pk "$ROOT" 2>/dev/null | awk 'NR == 2 { print $2, $3, $4 }')
  total_kb=${1:-0} used_kb=${2:-0} avail_kb=${3:-0}
}

# MemAvailable, or a container's (Daytona's) cgroup v2 limit when tighter:
# usage minus reclaimable page cache is what the kernel cannot give back.
read_memory() {
  mem_total_kb=0 mem_avail_kb=0
  while read -r key value _; do
    case $key in MemTotal:) mem_total_kb=$value ;; MemAvailable:) mem_avail_kb=$value ;; esac
  done < "$PROC/meminfo" 2>/dev/null
  [ -r "$CGROUP/memory.max" ] && [ -r "$CGROUP/memory.current" ] || return 0
  read -r max_b < "$CGROUP/memory.max" || return 0
  read -r current_b < "$CGROUP/memory.current" || return 0
  case $max_b$current_b in ''|*[!0-9]*) return 0 ;; esac
  max_kb=$((max_b / 1024))
  [ "$mem_total_kb" -gt 0 ] && [ "$max_kb" -ge "$mem_total_kb" ] && return 0
  inactive_kb=0
  while read -r key value; do [ "$key" = inactive_file ] && inactive_kb=$((value / 1024)); done < "$CGROUP/memory.stat" 2>/dev/null
  mem_total_kb=$max_kb
  mem_avail_kb=$((max_kb - current_b / 1024 + inactive_kb))
  [ "$mem_avail_kb" -lt 0 ] && mem_avail_kb=0
  return 0
}

check() {
  read_disk
  before_kb=$avail_kb
  if [ -f "$BALLAST" ]; then
    state=present
    if [ "$avail_kb" -lt "$CRITICAL_KB" ]; then rm -f "$BALLAST"; state=released; read_disk; fi
  elif [ "$avail_kb" -gt $((BALLAST_KB + RESTORE_KB)) ]; then
    state=missing
    mkdir -p "$(dirname "$BALLAST")" 2>/dev/null
    # fallocate reserves the blocks at once; dd is the fallback that always works.
    if { fallocate -l "$((BALLAST_KB * 1024))" "$BALLAST.tmp" 2>/dev/null \
      || dd if=/dev/zero of="$BALLAST.tmp" bs=1024 count="$BALLAST_KB" 2>/dev/null; } && mv -f "$BALLAST.tmp" "$BALLAST"; then
      state=created
    else rm -f "$BALLAST.tmp"
    fi
    read_disk
  else state=missing
  fi
  read_memory
  echo "KARMAX_USAGE disk_total_kb=$total_kb disk_used_kb=$used_kb disk_avail_kb=$avail_kb disk_avail_before_kb=$before_kb mem_total_kb=$mem_total_kb mem_avail_kb=$mem_avail_kb ballast=$state ballast_kb=$BALLAST_KB"
}

largest() {
  places="${HOME:-/}"
  case $ROOT in "${HOME:-/}"/*) ;; *) places="$ROOT $places" ;; esac
  tmp=${KARMAX_GUARD_TMP:-/tmp}
  [ -d "$tmp" ] && case $tmp in "${HOME:-/}"/*) ;; *) places="$places $tmp" ;; esac
  run=''
  command -v timeout >/dev/null 2>&1 && run='timeout 20'
  # Files and directories down to four levels, big ones only; the reader keeps the most specific.
  $run du -xak -d 4 $places 2>/dev/null | awk -v min="$LARGEST_MIN_KB" '$1 >= min { size = $1; $1 = ""; sub(/^ /, ""); print "P " size " " $0 }'
  for fd in "$PROC"/[0-9]*/fd/*; do
    target=$(readlink "$fd" 2>/dev/null) || continue
    case $target in *' (deleted)') ;; *) continue ;; esac
    case $target in /dev/*|/memfd:*) continue ;; esac
    bytes=$(stat -L -c %s "$fd" 2>/dev/null) || continue
    [ "$((bytes / 1024))" -ge "$LARGEST_MIN_KB" ] || continue
    pid=${fd#"$PROC"/}; pid=${pid%%/*}
    command=$(tr '\0' ' ' < "$PROC/$pid/cmdline" 2>/dev/null | cut -c1-80)
    printf 'H %s %s %s\t%s\n' "$((bytes / 1024))" "$pid" "${command% }" "$target"
  done | sort -u
}

case $CMD in
  check) check ;;
  largest) largest ;;
  *) echo "usage: disk-guard.sh check|largest ROOT" >&2; exit 2 ;;
esac
