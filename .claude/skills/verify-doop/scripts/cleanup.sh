#!/usr/bin/env bash
# Stop the server launch.sh started and delete its run dir. Usage: cleanup.sh <run-dir>.
# Kills only a pid whose cwd is the run dir; anything else exits 1 and leaves everything alone. Evidence lives elsewhere.
set -uo pipefail
run=${1:-}; [ -d "$run" ] || { echo "usage: cleanup.sh <run-dir from launch.sh>" >&2; exit 2; }
run=$(readlink -f "$run")
pid=$(cat "$run/pid" 2>/dev/null)
if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
  [ "$(readlink -f "/proc/$pid/cwd" 2>/dev/null)" = "$run" ] || { echo "pid $pid is not the server for $run; not killing" >&2; exit 1; }
  kill "$pid"; for _ in $(seq 1 20); do kill -0 "$pid" 2>/dev/null || break; sleep 0.5; done
  kill -0 "$pid" 2>/dev/null && kill -9 "$pid"
fi
case "$run" in /tmp/verify-doop.*) rm -rf -- "$run" ;; *) echo "refusing to delete $run: not a launch.sh dir" >&2; exit 1 ;; esac
echo "cleaned $run"
