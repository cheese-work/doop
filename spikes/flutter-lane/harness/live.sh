#!/usr/bin/env bash
# The live edit loop for a human to watch: Flutter dev server (tailnet IP, TLS) + save watcher + form-2 player page.
# usage: live.sh start [auto-stop-hours=24] | stop | status      Tailnet-only: no public bind, no funnel.
# State (pids, logs) in $RUN. Stops everything it started; run `stop` when the verdict is in.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
RUN=${RUN:-/mnt/ssd2/scratch/che-7352/run}; PLAYER_PORT=18452; HTTPS_PORT=19451
DEV_PORT=${PORT:-18451}; HOST=$(tailscale status --self --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')
mkdir -p "$RUN"
alive() { [ -f "$1" ] && kill -0 "$(cat "$1")" 2>/dev/null; }
bg() { # name cmd... : detached, real pid (exec) in $RUN/<name>.pid, log in $RUN/<name>.log
  local n=$1; shift
  setsid bash -c 'echo $$ > "$0"; shift; exec "$@"' "$RUN/$n.pid" "$n" "$@" > "$RUN/$n.log" 2>&1 < /dev/null &
}
case ${1:?start|stop|status} in
  start)
    "$HERE/dev.sh" start
    alive "$RUN/watch.pid" || (cd "$HERE" && bg watch node watch.mjs ../app/lib "$RUN/flutter.pid")
    alive "$RUN/player.pid" || (cd "$HERE" && bg player bun serve.ts $PLAYER_PORT)
    sleep 2
    tailscale serve --bg --https=$HTTPS_PORT "http://127.0.0.1:$PLAYER_PORT" > /dev/null
    hours=${2:-24}
    systemd-run --user --quiet --on-active="${hours}h" --unit=che7352-live-stop "$HERE/live.sh" stop 2>/dev/null || echo "warning: auto-stop timer not set"
    echo "frame (form 2): https://$HOST:$HTTPS_PORT/player?form=kind&sandbox=allow-scripts%20allow-same-origin&src=https://$HOST:$DEV_PORT/"
    echo "auto-stop in ${hours}h; manual: $HERE/live.sh stop" ;;
  stop)
    tailscale serve --https=$HTTPS_PORT off > /dev/null 2>&1 || true
    for n in watch player; do alive "$RUN/$n.pid" && kill "$(cat "$RUN/$n.pid")"; rm -f "$RUN/$n.pid"; done
    "$HERE/dev.sh" stop
    systemctl --user stop che7352-live-stop.timer 2>/dev/null || true
    echo stopped ;;
  status)
    for n in watch player flutter; do if alive "$RUN/$n.pid"; then echo "$n up (pid $(cat "$RUN/$n.pid"))"; else echo "$n down"; fi; done
    ss -ltn | grep -E ":($DEV_PORT|$PLAYER_PORT|$HTTPS_PORT) " | awk '{print "listen", $4}' ;;
esac
