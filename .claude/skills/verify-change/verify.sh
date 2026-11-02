#!/usr/bin/env bash
# Runs doop's own gates, scoped to what the change touches. Usage: verify.sh [base-ref]
# base-ref defaults to origin/main. To check a merged commit: git switch --detach <sha>; verify.sh <sha>~1
set -uo pipefail
export PATH="$HOME/.bun/bin:$PATH"
cd "$(git rev-parse --show-toplevel)"
base="${1:-origin/main}"
mapfile -t changed < <(git diff --name-only --diff-filter=d "$base"...HEAD)
[ "${#changed[@]}" -gt 0 ] || { echo "no changed files vs $base"; exit 2; }
mapfile -t code < <(printf '%s\n' "${changed[@]}" | grep -E '^(src|server|shared|tests)/.*\.(ts|tsx)$' || true)
needs_build=$(printf '%s\n' "${changed[@]}" | grep -cE '^(src|shared|public|scripts|vite\.config|index\.html|package\.json)' || true)

fail=0
gate() { # gate <name> <cmd...>
  local name=$1; shift
  echo "::: $name: $*"
  if "$@"; then echo "::: $name PASS"; else echo "::: $name FAIL"; fail=1; fi
}

echo "base=$base head=$(git rev-parse --short HEAD) changed=${#changed[@]} code=${#code[@]}"
# Tests that drive real Chromium (they import puppeteer) time out on a loaded shared X99, and `related` reaches them
# through hub files like src/lib/api.ts. Leave them out here; run the ones for your area by hand (see SKILL.md).
mapfile -t chromium < <(grep -lE 'puppeteer' tests/*.ts tests/*.tsx 2>/dev/null)
skip=(); for t in "${chromium[@]}"; do skip+=(--exclude "$t"); done
if [ "${#code[@]}" -gt 0 ]; then
  echo "::: skipping ${#chromium[@]} puppeteer test files"
  gate related-tests bunx vitest related --run --maxWorkers="${VERIFY_WORKERS:-4}" "${skip[@]}" "${code[@]}"
else
  echo "::: related-tests SKIP (no ts/tsx changed)"
fi
gate typecheck bun run typecheck
gate lint bun run lint
gate format bunx prettier --check --ignore-unknown "${changed[@]}"
gate doc-lint bun run doc-lint
[ "$needs_build" -gt 0 ] && gate build bun run --bun build || echo "::: build SKIP (no src/shared/public/scripts change)"

[ "$fail" -eq 0 ] && echo "VERIFY PASS" || echo "VERIFY FAIL"
exit "$fail"
