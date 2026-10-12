#!/bin/sh
# karmax VM session holder (src/world/vm/session.sh).
#
# A VM world reaches its machine over SSH, and an SSH channel dies with its
# connection. A process started on one would die with it too (SIGHUP), or keep
# running with nobody able to read it again. So every PTY and background
# process is started through this holder instead: detached in its own session,
# with its output appended to a log any later connection can follow from a
# byte offset, its input read from a FIFO that never reaches EOF, and its exit
# status written to a file. That is what makes "reattach by pid" work on a VM
# exactly as it does on E2B's envd, without a daemon of our own in the VM.
#
#   sh session.sh start <dir> <pty|pipe> <cols> <rows>   launch script on stdin
#   sh session.sh follow <dir> <offset>                  output from byte <offset>
#   sh session.sh input <dir>                            stdin -> the process
#   sh session.sh status <dir>                           "exit <code>" | "running" | "lost"
#   sh session.sh resize <dir> <cols> <rows>
#   sh session.sh kill <dir> [TERM|KILL]
#   sh session.sh remove <dir>
set -u
op=$1
dir=$2
shift 2

alive() { [ -s "$dir/holder" ] && kill -0 "$(cat "$dir/holder")" 2>/dev/null; }

case $op in
start)
  mode=$1 cols=$2 rows=$3
  umask 077
  mkdir -p "$dir" || exit 1
  # The launch script carries the command, its directory and its environment.
  # It removes itself as soon as it starts: it may hold secrets.
  cat > "$dir/launch" || exit 1
  mkfifo "$dir/in" || exit 1
  : > "$dir/out"
  # Not a process group leader (no job control here), so setsid runs `run`
  # in place and $! is the new session: kill -- -$! reaches all of it.
  setsid sh "$0" run "$dir" "$mode" "$cols" "$rows" < /dev/null > /dev/null 2>&1 &
  printf '%s' "$!" > "$dir/holder"
  echo "$!"
  ;;
run)
  mode=$1 cols=$2 rows=$3
  # Read-write keeps the FIFO open on both ends, so the command never sees EOF
  # when one client's input channel closes and the next has not opened yet.
  exec 3<> "$dir/in"
  if [ "$mode" = pty ]; then
    # script(1) gives the command a terminal of its own (it becomes that
    # session's leader); -e returns its status, -f flushes every write.
    SHELL=/bin/sh script -qfec "echo \$\$ > '$dir/child'; tty > '$dir/tty' 2>/dev/null; stty cols $cols rows $rows 2>/dev/null; exec sh '$dir/launch'" /dev/null <&3 >> "$dir/out" 2>&1
  else
    sh -c "echo \$\$ > '$dir/child'; exec sh '$dir/launch'" <&3 >> "$dir/out" 2>&1
  fi
  code=$?
  printf '%s' "$code" > "$dir/exit.tmp" && mv "$dir/exit.tmp" "$dir/exit"
  ;;
follow)
  offset=$1
  holder=$(cat "$dir/holder" 2>/dev/null) || exit 3
  # GNU tail follows the log until the holder exits, reading what is left first.
  exec tail -c "+$((offset + 1))" -s 0.2 -F --pid="$holder" "$dir/out" 2> /dev/null
  ;;
input)
  exec cat > "$dir/in"
  ;;
status)
  if [ -f "$dir/exit" ]; then printf 'exit %s\n' "$(cat "$dir/exit")"
  elif alive; then echo running
  else echo lost; fi
  ;;
resize)
  [ -s "$dir/tty" ] && stty -F "$(cat "$dir/tty")" cols "$1" rows "$2" 2> /dev/null
  exit 0
  ;;
kill)
  signal=${1:-TERM}
  for file in child holder; do
    # dash (sh on Debian) takes no "--": a negative pid after the signal names a group.
    [ -s "$dir/$file" ] && kill "-$signal" "-$(cat "$dir/$file")" 2> /dev/null
  done
  exit 0
  ;;
remove)
  rm -rf -- "$dir"
  ;;
*)
  echo "unknown operation $op" >&2
  exit 2
  ;;
esac
