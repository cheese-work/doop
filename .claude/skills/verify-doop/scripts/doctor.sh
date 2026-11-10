#!/usr/bin/env bash
# Read-only: is the run launched by launch.sh usable? Usage: doctor.sh <run-dir>. Exit 0 = go drive.
set -uo pipefail
run=${1:-}; [ -d "$run" ] || { echo "usage: doctor.sh <run-dir from launch.sh>" >&2; exit 2; }
fail=0; ok() { echo "ok   $*"; }; bad() { echo "FAIL $*"; fail=1; }
pid=$(cat "$run/pid" 2>/dev/null); port=$(cat "$run/port" 2>/dev/null)
[ -n "$pid" ] && [ "$(readlink -f "/proc/$pid/cwd" 2>/dev/null)" = "$(readlink -f "$run")" ] && ok "server pid $pid owns $run" || bad "server pid not alive in $run"
curl -fsS "http://127.0.0.1:${port:-0}/healthz" 2>/dev/null | grep -q '"ok":true' && ok "/healthz on :$port" || bad "/healthz not ok"
[ -f "$run/dist/index.html" ] && ok "dist served" || bad "dist missing"
chrome=${CHROME_PATH:-/usr/bin/google-chrome}; [ -x "$chrome" ] && ok "browser $chrome" || bad "no browser at $chrome (set CHROME_PATH)"
ls "$run/data/pg" >/dev/null 2>&1 && ok "database is the run's own" || bad "no $run/data/pg - server is not using the isolated database"
exit $fail
