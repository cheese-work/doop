#!/usr/bin/env bash
# Runs on the C00 deploy runner (CHE-4585). Never builds: it pulls and runs an
# image that already exists in GHCR, named by digest.
#
#   Everything below that mentions migration supervision applies only when DOOP_DEPLOY_TRAIN=on. Absent or
#   off, apply and rollback behave as before the train (no quiescence check, the app migrates at boot).
#   c00.sh apply      prove migration quiescence, pin the running image as the rollback target, pull
#                     DEPLOY_REF, run its migrations once in a supervised one-shot container (C-8.8),
#                     then start it with DOOP_SKIP_MIGRATIONS=1
#   c00.sh readback   running digest == DEPLOY_REF's, image revision label == DEPLOY_SHA,
#                     then healthy on consecutive checks inside the window
#   c00.sh rollback   prove migration quiescence, start the pinned previous image, wait for it to be healthy
#   c00.sh quiescence prove migration quiescence and nothing else (compat and lift jobs call this first)
#
# Env: DEPLOY_REF (image@sha256:...), DEPLOY_SHA, C00_COMPOSE_DIR (compose project on C00),
#      C00_PG_CONTAINER (the live Postgres container; read through `docker exec`, read-only; default: the
#      compose project's `db` service, C00_PG_SERVICE),
#      DEPLOY_RUN_ID (apply with DOOP_DEPLOY_TRAIN=on only: [a-z0-9-], names the one-shot container and its DB sessions).
# Optional: C00_COMPOSE_FILE, C00_CONTAINER, C00_READBACK_SECONDS (900), C00_ROLLBACK_SECONDS (300),
#           C00_POLL_SECONDS (10), C00_STABLE_CHECKS (3), C00_PG_USER (doop), C00_PG_DB (doop),
#           C00_MIGRATE_SECONDS (120), C00_QUIESCE_SECONDS (30), C00_QUIESCE_POLL_SECONDS (2).
# Outcomes go to $GITHUB_OUTPUT as `outcome=migrate_failed|needs_operator`.
set -euo pipefail

cmd=${1:-}
container=${C00_CONTAINER:-doop}
rollback_tag=doop-rollback:previous
poll=${C00_POLL_SECONDS:-10}
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

die() { echo "c00.sh: $*" >&2; exit 1; }
need_dir() { [ -n "${C00_COMPOSE_DIR:-}" ] || die "C00_COMPOSE_DIR is not set"; }

# The supervised migration path is the train's. Absent, off or anything but `on` keeps the
# deploy exactly as it was before the train (the app migrates at boot); CHE-6526.
train_on() { [ "${DOOP_DEPLOY_TRAIN:-}" = on ]; }

compose_up() { # $1 = image to run
  need_dir
  local extra=()
  ! train_on || extra=(-f "$here/compose.supervised.yml")
  DOOP_IMAGE=$1 docker compose --project-directory "$C00_COMPOSE_DIR" \
    -f "$C00_COMPOSE_DIR/${C00_COMPOSE_FILE:-compose.yaml}" -f "$here/compose.image.yml" ${extra[@]+"${extra[@]}"} \
    up -d --no-build --pull never --force-recreate app
}

# Healthy on N consecutive polls inside the window; unhealthy or stopped fails at once.
wait_healthy() { # $1 = window seconds
  local deadline=$((SECONDS + $1)) stable=0 need=${C00_STABLE_CHECKS:-3} running health
  while :; do
    running=$(docker inspect --format '{{.State.Running}}' "$container" 2>/dev/null || echo false)
    [ "$running" = true ] || die "$container is not running"
    health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$container")
    case $health in
      healthy) stable=$((stable + 1)); [ "$stable" -ge "$need" ] && return 0 ;;
      unhealthy | none) die "$container is $health" ;;
      *) stable=0 ;;
    esac
    [ "$SECONDS" -lt "$deadline" ] || die "$container not healthy ${need}x within $1s (last: $health)"
    sleep "$poll"
  done
}

# ---- Migration supervision and quiescence (CHE-5474 C-8.8) -------------------------------------
# One fixed doop advisory key (two int4: 'doop', 1). `scripts/../server/db/migrate.ts` holds it for a run.
lock_class=1685025648
lock_obj=1
migrate_prefix=doop-migrate-
tmp=
why=

set_output() { [ -z "${GITHUB_OUTPUT:-}" ] || echo "$1=$2" >> "$GITHUB_OUTPUT"; }

# C00_PG_CONTAINER, else the container of the compose project's database service (C00_PG_SERVICE, `db`).
# Neither found: refuse. Read-only: `compose ps` changes nothing.
need_pg() {
  if [ -z "${C00_PG_CONTAINER:-}" ]; then
    need_dir
    C00_PG_CONTAINER=$(docker compose --project-directory "$C00_COMPOSE_DIR" \
      -f "$C00_COMPOSE_DIR/${C00_COMPOSE_FILE:-compose.yaml}" ps -q "${C00_PG_SERVICE:-db}" 2>/dev/null | head -n 1) || C00_PG_CONTAINER=
  fi
  [ -n "$C00_PG_CONTAINER" ] || die "no Postgres container: set C00_PG_CONTAINER or run a compose service ${C00_PG_SERVICE:-db}"
}

need_run_id() {
  run_id=${DEPLOY_RUN_ID:-}
  [[ $run_id =~ ^[a-z0-9][a-z0-9-]{0,40}$ ]] || die "DEPLOY_RUN_ID must match [a-z0-9-] (got '$run_id')"
}

# Read-only SQL on the live database through the container's local socket.
pg() {
  docker exec -e PGOPTIONS='-c default_transaction_read_only=on' "$C00_PG_CONTAINER" \
    psql -X -q -t -A -F '|' -v ON_ERROR_STOP=1 -U "${C00_PG_USER:-doop}" -d "${C00_PG_DB:-doop}" -c "$1"
}

ledger() { pg 'select hash, created_at from drizzle.__drizzle_migrations order by id'; }

# "(pid, backend_start); ..." or "none"
fmt_sessions() { if [ -z "$1" ]; then echo none; else sed -E 's/^([^|]*)\|(.*)$/(\1, \2)/' <<<"$1" | paste -sd ';' - | sed 's/;/; /g'; fi; }

# Each fact returns 0 when it holds. Anything else, including a read that fails, leaves `why` set.
fact_sessions_gone() { # $1 = SQL predicate on application_name
  local rows
  rows=$(pg "select pid, backend_start from pg_stat_activity where application_name $1 order by pid") \
    || { why="cannot read pg_stat_activity"; return 1; }
  sessions=$rows
  [ -z "$rows" ] || { why="live migrate sessions: $(fmt_sessions "$rows")"; return 1; }
}
fact_lock_free() {
  local n
  n=$(pg "select count(*) from pg_locks where locktype = 'advisory' and classid = $lock_class and objid = $lock_obj and objsubid = 2") \
    || { why="cannot read pg_locks"; return 1; }
  [ "$n" = 0 ] || { why="the migrate advisory lock is held or awaited"; return 1; }
}
fact_container_exited() { # $1 = container name
  local st
  st=$(docker inspect --format '{{.State.Status}}' "$1" 2>/dev/null) || { why="cannot inspect $1"; return 1; }
  [ "$st" = exited ] || { why="$1 is $st"; return 1; }
}
fact_no_migrate_running() {
  local rows
  rows=$(docker ps -a --filter label=doop.migrate.run --format '{{.Names}} {{.State}}') \
    || { why="cannot list migrate containers"; return 1; }
  if grep -qvE ' exited$' <<<"$rows" && [ -n "$rows" ]; then why="a migrate container is not exited: $(grep -vE ' exited$' <<<"$rows" | head -1)"; return 1; fi
  return 0
}

# Gate for apply, rollback, compat and lift: no migrate container running, no session whose
# application_name starts with doop-migrate-, advisory key free. Else needs_operator.
require_quiescent() {
  need_pg
  if fact_no_migrate_running && fact_sessions_gone "like '${migrate_prefix}%'" && fact_lock_free; then return 0; fi
  set_output outcome needs_operator
  echo "outcome=needs_operator"
  die "migration quiescence not proven: $why"
}

# Runs the migrations once for this deploy; returns only when they succeeded.
migrate_supervised() { # $1 = image ref
  local name=${migrate_prefix}$run_id budget=${C00_MIGRATE_SECONDS:-120} qbudget=${C00_QUIESCE_SECONDS:-30}
  local qpoll=${C00_QUIESCE_POLL_SECONDS:-2} rc timed_out=0 before after proven=0 ledger_after
  tmp=$(mktemp)
  trap 'rm -f "$tmp"' EXIT # global: the EXIT trap runs after the function's locals are gone
  DOOP_IMAGE=$1 docker compose --project-directory "$C00_COMPOSE_DIR" \
    -f "$C00_COMPOSE_DIR/${C00_COMPOSE_FILE:-compose.yaml}" -f "$here/compose.image.yml" \
    run -d --no-deps --name "$name" --label "doop.migrate.run=$run_id" \
    -e "DOOP_MIGRATE_APP_NAME=$name" -e "DOOP_MIGRATE_DEADLINE_SECONDS=$budget" \
    app node server/db/migrate.ts >/dev/null || die "could not start $name"
  timeout "$budget" docker wait "$name" >"$tmp" || timed_out=$?
  rc=$(tr -d '[:space:]' <"$tmp")
  if [ "$timed_out" = 0 ] && [ "$rc" = 0 ]; then
    docker rm -f "$name" >/dev/null || true
    return 0
  fi
  [ "$timed_out" = 0 ] && echo "c00.sh: $name exited $rc" >&2 || echo "c00.sh: $name passed its ${budget}s deadline" >&2
  docker logs --tail 40 "$name" >&2 || true

  # Failed or timed out: no app start. Kill, wait, end every session of this run, then prove quiescence.
  docker kill "$name" >/dev/null 2>&1 || true
  timeout "$qbudget" docker wait "$name" >/dev/null 2>&1 || true
  fact_sessions_gone "= '$name'" || true
  before=$sessions
  pg "select pid, pg_terminate_backend(pid) from pg_stat_activity where application_name = '$name'" >/dev/null 2>&1 || true
  local deadline=$((SECONDS + qbudget))
  while :; do
    why=
    sessions=
    if fact_container_exited "$name" && fact_sessions_gone "= '$name'" && fact_lock_free; then proven=1; break; fi
    [ "$SECONDS" -lt "$deadline" ] || break
    sleep "$qpoll"
  done
  after=$sessions
  echo "sessions_before=$(fmt_sessions "$before")"
  echo "sessions_after=$(fmt_sessions "$after")"

  # Compare the ledger with the one read before the apply.
  local changed=unknown
  if ledger_after=$(ledger); then
    if [ "$ledger_after" = "$ledger_before" ]; then changed=false; else changed=true; fi
  else
    proven=0
    why="cannot read the ledger after the failure"
  fi
  echo "ledger_changed=$changed"

  if [ "$proven" = 1 ]; then
    docker rm -f "$name" >/dev/null 2>&1 || true
    set_output outcome migrate_failed
    echo "outcome=migrate_failed"
    die "migration failed; quiescence proven, the running app is untouched"
  fi
  set_output outcome needs_operator
  echo "outcome=needs_operator"
  die "migration quiescence not proven: $why"
}

case $cmd in
  apply)
    ref=${DEPLOY_REF:-}
    [[ $ref =~ ^[a-z0-9._/-]+@sha256:[0-9a-f]{64}$ ]] || die "DEPLOY_REF must be image@sha256:<64 hex>, got '$ref'"
    need_dir
    if train_on; then
      need_run_id
      need_pg
      require_quiescent
      ledger_before=$(ledger) || die "cannot read the migration ledger"
    fi
    docker rmi "$rollback_tag" >/dev/null 2>&1 || true # a stale target must never be mistaken for this deploy's
    if prev=$(docker inspect --format '{{.Image}}' "$container" 2>/dev/null) && [ -n "$prev" ]; then
      docker tag "$prev" "$rollback_tag"
    fi
    docker pull "$ref"
    if train_on; then
      migrate_supervised "$ref" # a failure stops here: the running app is untouched, no rollback is meaningful
    fi
    # From here the running service may change; only then is a rollback meaningful.
    [ -z "${GITHUB_OUTPUT:-}" ] || echo "attempted=true" >> "$GITHUB_OUTPUT"
    compose_up "$ref"
    ;;

  readback)
    ref=${DEPLOY_REF:-}
    sha=${DEPLOY_SHA:-}
    [ -n "$ref" ] && [ -n "$sha" ] || die "DEPLOY_REF and DEPLOY_SHA are required"
    id=$(docker inspect --format '{{.Image}}' "$container") || die "$container not found"
    digests=$(docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$id")
    grep -q "@${ref##*@}\$" <<<"$digests" || die "running image digest is not ${ref##*@}"
    label=$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$id")
    [ "$label" = "$sha" ] || die "image revision label '$label' is not the deployed SHA $sha"
    wait_healthy "${C00_READBACK_SECONDS:-900}"
    echo "readback ok: $container runs ${ref##*@} at $sha and is healthy"
    ;;

  rollback)
    ! train_on || require_quiescent
    docker image inspect "$rollback_tag" >/dev/null 2>&1 || die "no previous image to roll back to (first deploy?)"
    compose_up "$rollback_tag"
    wait_healthy "${C00_ROLLBACK_SECONDS:-300}"
    echo "rollback ok: $container runs the previous image again"
    ;;

  quiescence)
    require_quiescent
    echo "quiescent: no migrate container running, no migrate session, advisory key free"
    ;;

  *) die "usage: c00.sh apply|readback|rollback|quiescence" ;;
esac
