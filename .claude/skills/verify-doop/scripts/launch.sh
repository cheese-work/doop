#!/usr/bin/env bash
# Start a throwaway production doop on a free port with an empty database. Prints the run dir on stdout.
# Needs a built dist/ (bun run build). Everything it makes lives in the run dir; cleanup.sh removes it.
set -euo pipefail
repo=$(cd "$(dirname "$0")/../../../.." && pwd)
[ -f "$repo/dist/index.html" ] || { echo "no dist/ - run: bun run build" >&2; exit 3; }
run=$(mktemp -d /tmp/verify-doop.XXXXXX)
# the server resolves dist/ and data/ from its cwd, so an empty cwd means an empty pglite database
ln -s "$repo/dist" "$run/dist"
port=$(node -e "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})")
echo "$port" >"$run/port"
cd "$run"
# placeholder secret, not a credential: the run dir and its database are deleted at cleanup
NODE_ENV=production PORT="$port" BETTER_AUTH_URL="http://localhost:$port" \
  BETTER_AUTH_SECRET=verify-doop-placeholder-not-a-secret-0123456789 \
  REQUIRE_EMAIL_VERIFICATION=false DATABASE_URL= POSTHOG_KEY= VITE_POSTHOG_KEY= \
  setsid node --import "file://$repo/node_modules/tsx/dist/esm/index.mjs" "$repo/server/index.ts" \
  >"$run/server.log" 2>&1 </dev/null &
echo $! >"$run/pid"
for _ in $(seq 1 90); do
  if curl -fsS "http://127.0.0.1:$port/healthz" 2>/dev/null | grep -q '"ok":true'; then echo "$run"; exit 0; fi
  kill -0 "$(cat "$run/pid")" 2>/dev/null || { echo "server exited early; see $run/server.log" >&2; exit 4; }
  sleep 1
done
echo "not ready after 90s; see $run/server.log" >&2
exit 4
