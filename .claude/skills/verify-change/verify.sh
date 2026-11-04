#!/usr/bin/env bash
# Runs doop's own gates, scoped to what the change touches. Usage: verify.sh [base-ref]
# base-ref defaults to origin/main. To check a merged commit: git switch --detach <sha>; verify.sh <sha>~1
# VERIFY_BROWSER=all  run every puppeteer (real Chromium) test file, serially
# VERIFY_PLAN=1       print what would run and stop (tests/verifyChange.test.ts uses this)
set -uo pipefail
export PATH="$HOME/.bun/bin:$PATH"
cd "$(git rev-parse --show-toplevel)"
base="${1:-origin/main}"
mapfile -t changed < <(git diff --name-only --diff-filter=d "$base"...HEAD)
mapfile -t deleted < <(git diff --name-only --diff-filter=D "$base"...HEAD)
[ "${#changed[@]}" -gt 0 ] || [ "${#deleted[@]}" -gt 0 ] || { echo "no changed files vs $base"; exit 2; }
is_code='^(src|server|shared|tests)/.*\.(ts|tsx)$'
mapfile -t code < <(printf '%s\n' "${changed[@]}" | grep -E "$is_code" || true)
is_build='^(src|shared|public|scripts|vite\.config|index\.html|package\.json)'
needs_build=$(printf '%s\n' "${changed[@]}" "${deleted[@]}" | grep -cE "$is_build" || true)
# browser tests exercise the app through src/, shared/ and server/; a change to any of them can break one unseen
touches_app=$(printf '%s\n' "${changed[@]}" "${deleted[@]}" | grep -E "$is_code" | grep -cvE '^tests/' || true)

# A deleted module leaves no import graph to follow: an intermediate module can load it dynamically and no test names
# it. So a deleted ts/tsx file falls back to the whole non-browser suite. Slow, but the only safe selection.
related_all=no
printf '%s\n' "${deleted[@]}" | grep -E "$is_code" | grep -qvE '^tests/' && related_all=yes

# Real-Chromium tests (they import puppeteer) time out on a loaded shared X99, and `related` reaches them through hub
# files like src/lib/api.ts. They run apart: serially, and only the ones the diff changes or whose imports it changes.
mapfile -t chromium < <(grep -lE 'puppeteer' tests/*.ts tests/*.tsx 2>/dev/null || true)
is_chromium() { local t; for t in "${chromium[@]}"; do [ "$t" = "$1" ] && return 0; done; return 1; }
related=(); browser=()
for f in "${code[@]}"; do
  [ -n "$f" ] || continue
  if is_chromium "$f"; then browser+=("$f"); else related+=("$f"); fi
done
# browser files that mention a changed source module by name (a direct import; the rest is flagged incomplete below)
mapfile -t stems < <(printf '%s\n' "${code[@]}" | grep -vE '^tests/' | sed -E 's|.*/||; s|\.[a-z]+$||' | sort -u)
for s in "${stems[@]}"; do
  [ -n "$s" ] || continue
  for t in "${chromium[@]}"; do grep -qE "/${s}(\.[a-z]+)?['\"]" "$t" && browser+=("$t"); done
done
[ "${VERIFY_BROWSER:-}" = all ] && browser=("${chromium[@]}")
mapfile -t related < <(printf '%s\n' "${related[@]}" | sort -u | grep -v '^$' || true)
mapfile -t browser < <(printf '%s\n' "${browser[@]}" | sort -u | grep -v '^$' || true)
unrun=$(( ${#chromium[@]} - ${#browser[@]} ))
incomplete=no; [ "$touches_app" -gt 0 ] && [ "$unrun" -gt 0 ] && incomplete=yes

echo "base=$base head=$(git rev-parse --short HEAD) changed=${#changed[@]} deleted=${#deleted[@]} code=${#code[@]}"
echo "plan related: ${related[*]}"
echo "plan browser: ${browser[*]}"
echo "plan browser-unrun: $unrun"
echo "plan browser-incomplete: $incomplete"
echo "plan related-all: $related_all"
echo "plan build: $([ "$needs_build" -gt 0 ] && echo yes || echo no)"
[ -n "${VERIFY_PLAN:-}" ] && exit 0

fail=0
gate() { # gate <name> <cmd...>
  local name=$1; shift
  echo "::: $name: $*"
  if "$@"; then echo "::: $name PASS"; else echo "::: $name FAIL"; fail=1; fi
}

skip=(); for t in "${chromium[@]}"; do skip+=(--exclude "$t"); done
if [ "$related_all" = yes ]; then
  gate related-tests bunx vitest run --maxWorkers="${VERIFY_WORKERS:-4}" "${skip[@]}"
elif [ "${#related[@]}" -gt 0 ]; then
  gate related-tests bunx vitest related --run --maxWorkers="${VERIFY_WORKERS:-4}" "${skip[@]}" "${related[@]}"
else
  echo "::: related-tests SKIP (no ts/tsx changed)"
fi
if [ "${#browser[@]}" -gt 0 ]; then
  gate browser-tests bunx vitest run --maxWorkers=1 "${browser[@]}"
else
  echo "::: browser-tests SKIP (no puppeteer test changed or importing a changed module)"
fi
gate typecheck bun run typecheck
gate lint bun run lint
[ "${#changed[@]}" -gt 0 ] && gate format bunx prettier --check --ignore-unknown "${changed[@]}"
gate doc-lint bun run doc-lint
[ "$needs_build" -gt 0 ] && gate build bun run --bun build || echo "::: build SKIP (no src/shared/public/scripts change)"

if [ "$fail" -ne 0 ]; then echo "VERIFY FAIL"; exit 1; fi
if [ "$incomplete" = yes ]; then
  echo "::: browser-coverage INCOMPLETE: $unrun puppeteer files not run and the diff touches src/ or shared/. Run VERIFY_BROWSER=all, or CI runs them."
  echo "VERIFY PASS (browser coverage incomplete)"
else
  echo "VERIFY PASS"
fi
