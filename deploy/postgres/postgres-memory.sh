#!/bin/sh
# Starts PostgreSQL with its memory sized to its own container's cap
# (KARMAX_POSTGRES_MEM_LIMIT in .turnkey.env; deploy/README.md, "Memory caps"),
# the way the app sizes its heaps to its own (src/runtime/memory-budget.ts).
# Stock PostgreSQL assumes 128 MB of shared buffers and a 4 GB cache whatever
# the cap is. The compose file runs it as the entrypoint with the server's
# usual command (`postgres -c …`); `--print` only prints the settings.
#
#   shared_buffers        1/4 of the cap (PostgreSQL's own advice for a
#                         dedicated server), never under its 128 MB default.
#   effective_cache_size  3/4 of the cap: the container's page cache is charged
#                         to the same cap, so this is all the cache there is.
#                         A planner estimate; nothing is allocated.
#   work_mem              per sort or hash, so the rest of the cap split over
#                         every allowed connection running three at once;
#                         4 MB (the default) to 64 MB.
#   maintenance_work_mem  1/16 of the cap, 64 MB (the default) to 1 GB; each of
#                         the three autovacuum workers may take this much.
#
# They are command-line settings, which beat ALTER SYSTEM: change the cap, or
# max_connections (KARMAX_POSTGRES_MAX_CONNECTIONS, default 100), instead.
set -eu

cgroup=${KARMAX_CGROUP_ROOT:-/sys/fs/cgroup}
meminfo=${KARMAX_MEMINFO:-/proc/meminfo}

# The cgroup memory limit in MiB (v2, then v1), else the host's memory; "max"
# and v1's near-2^63 sentinel both mean unlimited.
host_mb=$(awk '/^MemTotal:/ { printf "%d", $2 / 1024 }' "$meminfo")
limit_mb=$host_mb
for file in "$cgroup/memory.max" "$cgroup/memory/memory.limit_in_bytes"; do
  [ -r "$file" ] || continue
  value=$(cat "$file")
  case "$value" in max|*[!0-9]*|'') ;; *) limit_mb=$(awk -v b="$value" -v h="$host_mb" 'BEGIN { m = int(b / 1048576); printf "%d", m < h ? m : h }') ;; esac
  break
done

connections=${KARMAX_POSTGRES_MAX_CONNECTIONS:-100}
case "$connections" in ''|*[!0-9]*) echo "KARMAX_POSTGRES_MAX_CONNECTIONS must be a whole number, not $connections" >&2; exit 2 ;; esac
[ "$connections" -ge 10 ] || { echo 'KARMAX_POSTGRES_MAX_CONNECTIONS must be at least 10' >&2; exit 2; }

clamp() { if [ "$1" -lt "$2" ]; then echo "$2"; elif [ "$1" -gt "$3" ]; then echo "$3"; else echo "$1"; fi; }
shared=$((limit_mb / 4)); [ "$shared" -ge 128 ] || shared=128
cache=$((limit_mb * 3 / 4)); [ "$cache" -ge "$shared" ] || cache=$shared
work=$(clamp $(((limit_mb - shared) / (connections * 3))) 4 64)
maintenance=$(clamp $((limit_mb / 16)) 64 1024)
settings="max_connections=$connections shared_buffers=${shared}MB effective_cache_size=${cache}MB work_mem=${work}MB maintenance_work_mem=${maintenance}MB"

case "${1:-}" in
  --print) echo "$settings"; exit 0 ;;
  # Ahead of the command's own settings: a later -c wins.
  postgres)
    shift
    for setting in $settings; do set -- -c "$setting" "$@"; done
    exec docker-entrypoint.sh postgres "$@" ;;
  *) exec docker-entrypoint.sh "$@" ;;
esac
