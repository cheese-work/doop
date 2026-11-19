#!/usr/bin/env bash
# usage: run-probe.sh <font|sem|riv>   serves probes/<kind>/lib on :19462 (tailnet only), runs probe.mjs, stops the server it started
set -u
k=$1; here=$(cd "$(dirname "$0")" && pwd); H=congvc-x99.taila6fa8a.ts.net
PUB='name: probe\nenvironment:\n  sdk: ^3.14.0\ndependencies:\n  flutter:\n    sdk: flutter\n  web: ^1.1.2\n'
[ "$k" = riv ] && PUB="${PUB}  rive: 0.14.11\n"
q=$(printf "$PUB" | node -e 'process.stdout.write(encodeURIComponent(require("fs").readFileSync(0,"utf8")))')
SRC_DIR=$here/probes/$k/lib setsid bun $here/serve.ts 19462 >/mnt/ssd2/scratch/che-7478/run/probe-$k.log 2>&1 </dev/null &
pid=$!; sleep 2
WAIT=${WAIT:-240000} node $here/probe.mjs "https://$H:19462/?pubspec=$q" $k ${2:-}
rc=$?; kill $pid; exit $rc
