#!/usr/bin/env bash
# usage: run.sh <check.mjs|drift.mjs|...> [args]   serves s2/lib on :19463 (tailnet only) with the shell layers from
# $BLOB_DIR (make-shell.mjs output), runs the script against it, stops the server it started.
set -u
here=$(cd "$(dirname "$0")" && pwd); H=${HOST:-congvc-x99.taila6fa8a.ts.net}
BLOB=${BLOB_DIR:-/mnt/ssd2/scratch/che-7353/blob}
PUB='name: doop_s2\nenvironment:\n  sdk: ^3.14.0\ndependencies:\n  flutter:\n    sdk: flutter\n  web: ^1.1.2\n  rive: 0.14.11\n'
q=$(printf "$PUB" | node -e 'process.stdout.write(encodeURIComponent(require("fs").readFileSync(0,"utf8")))')
mkdir -p /mnt/ssd2/scratch/che-7353/run
SRC_DIR=$here/lib BLOB_DIR=$BLOB setsid bun $here/../s1b/serve.ts 19463 >/mnt/ssd2/scratch/che-7353/run/serve.log 2>&1 </dev/null &
pid=$!; sleep 2
S2_URL="https://$H:19463/?w=${W:-520}&h=${HH:-940}&pubspec=$q" node "$here/$1" "${@:2}"
rc=$?; kill $pid; exit $rc
