#!/usr/bin/env bash
# start|stop the Flutter dev server. Binds the X99 tailnet address only (never 0.0.0.0). usage: dev.sh start|stop [extra flutter args]
# env: FLUTTER_BIN (dir), RUN (state dir), TLS_DIR (x99.crt/x99.key from `tailscale cert`, outside the repo), PORT
set -euo pipefail
RUN=${RUN:-/mnt/ssd2/scratch/che-7352/run}; PORT=${PORT:-18451}; TLS_DIR=${TLS_DIR:-/mnt/ssd2/scratch/che-7352/cert}
export PATH=${FLUTTER_BIN:-/mnt/ssd2/scratch/che-7352/flutter/bin}:$PATH PUB_CACHE=${PUB_CACHE:-/mnt/ssd2/scratch/che-7352/pub-cache}
APP=$(cd "$(dirname "$0")/../app" && pwd); IP=$(tailscale ip -4 | head -1); cmd=${1:?start|stop}; shift || true
case $cmd in
  start)
    rm -f "$RUN/flutter.pid"; cd "$APP"
    TLS=(); [ -f "$TLS_DIR/x99.crt" ] && TLS=(--web-tls-cert-path "$TLS_DIR/x99.crt" --web-tls-cert-key-path "$TLS_DIR/x99.key")
    # stdin must stay open or `flutter run` quits
    setsid bash -c 'echo $$ > "$0/wrapper.pid"; tail -f /dev/null | flutter run -d web-server --web-hostname "$1" --web-port "$2" --pid-file "$0/flutter.pid" --hot "${@:3}" > "$0/flutter.log" 2>&1' "$RUN" "$IP" "$PORT" "${TLS[@]}" "$@" >/dev/null 2>&1 &
    for _ in $(seq 1 120); do grep -q "is being served" "$RUN/flutter.log" 2>/dev/null && break; sleep 2; done
    tail -3 "$RUN/flutter.log"; echo "flutter pid $(cat "$RUN/flutter.pid")" ;;
  stop)
    [ -f "$RUN/flutter.pid" ] && kill "$(cat "$RUN/flutter.pid")" 2>/dev/null || true
    [ -f "$RUN/wrapper.pid" ] && pkill -P "$(cat "$RUN/wrapper.pid")" 2>/dev/null || true ;;
esac
