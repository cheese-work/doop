#!/usr/bin/env bash
# Runs on the C00 deploy runner (CHE-4585). Never builds: it pulls and runs an
# image that already exists in GHCR, named by digest.
#
#   Migration supervision in apply applies only when DOOP_DEPLOY_TRAIN=on. Absent or off, apply behaves as before
#   the train (the app migrates at boot). Confirm and rollback prove quiescence under the lock either way: with the
#   switch off a migration can still be running (the app migrates at boot) and must not be raced.
#   c00.sh apply      take the C00 deploy lock, run the pre-apply check, prove migration quiescence, pin the
#                     running image as the rollback target, pull DEPLOY_REF, run its migrations once in a
#                     supervised one-shot container (C-8.8), then start it with DOOP_SKIP_MIGRATIONS=1
#   c00.sh readback   running digest == DEPLOY_REF's, image revision label == DEPLOY_SHA,
#                     then healthy on 3 consecutive checks inside 90 s; writes T0 (restart_count, t0_epoch, health)
#   c00.sh confirm    under the lock, after the readback delay (C-9): migration quiescence, the confirm recheck
#                     (marker is this run's, digest and label are the candidate's), restart count == RESTART_T0,
#                     healthy, at least C00_CONFIRM_MIN_SECONDS (900) since T0_EPOCH
#   c00.sh rollback   under the lock: prove migration quiescence, then decide (the rollback recheck: marker is this
#                     run's, what C00 runs now) as `action=rollback|none|superseded` to $GITHUB_OUTPUT. Only
#                     `rollback` changes C00: start the pinned previous image, wait for it to be healthy; with
#                     PREDECESSOR_DIGEST and PREDECESSOR_SHA it first checks the retained image is that digest,
#                     then reads back the predecessor's digest, label and health
#   c00.sh quiescence prove migration quiescence and nothing else (compat and lift jobs call this first)
#   c00.sh guard      refuse (exit 1) while an earlier compat migration's quiescence is unproven; re-proves the three
#                     facts and clears the guard when they hold. apply, rollback and sweep run it first; the lift
#                     job calls it. `guard-set run mig db user dbname app` writes it (compat-sandbox.mjs does).
#   c00.sh lift       the C00 half of cd-lift.yml (CHE-5551, C-10.7): refuse while a compat guard holds, take the host
#                     lock, prove migration quiescence, read the running digest, revision label and container
#                     health, and run scripts/deploy-lift.mjs lift under the same lock with those facts. That script
#                     decides, re-reads the decision and the marker right before the write, and writes `clear:*`.
#                     Unproven quiescence does not stop here: the script is told and records the refusal.
#   c00.sh sweep      remove every doop.compat.run resource (containers, networks, volumes), read back
#                     zero, print df before and after. Needs no compose dir and no deploy ref (CHE-5474 C-8.5d).
#
# Env: DEPLOY_REF (image@sha256:...), DEPLOY_SHA, C00_COMPOSE_DIR (compose project on C00),
#      apply, confirm and rollback also need DEPLOY_MODE (train|recovery|drill) and MARKER_EXPECT (this run's own
#      marker value), plus the GH_TOKEN/REPO/EXTRA/PREDECESSOR_DIGEST env that deploy-gate.mjs reads, and the switch
#      and the pause it checks (DOOP_DEPLOY_TRAIN, MAIN_RED_PAUSED, passed as env from the workflow's `vars`).
#      The suspension marker is one file on this host (C00_MARKER_FILE, default $C00_STATE_DIR/deploy-marker; no GitHub
#      token takes part, CHE-9877); a missing or unreadable file reads as suspended and refuses every check,
#      C00_PG_CONTAINER (the live Postgres container; read through `docker exec`, read-only; default: the
#      compose project's `db` service, C00_PG_SERVICE),
#      DEPLOY_RUN_ID (apply with DOOP_DEPLOY_TRAIN=on only: [a-z0-9-], names the one-shot container and its DB sessions).
# Optional: C00_LOCK_FILE (/var/lock/doop-deploy.lock), C00_LOCK_WAIT (600 seconds), C00_COMPOSE_FILE, C00_CONTAINER, C00_READBACK_SECONDS (90), C00_CONFIRM_MIN_SECONDS (900), C00_ROLLBACK_SECONDS (300),
#           C00_POLL_SECONDS (10), C00_STABLE_CHECKS (3), C00_PG_USER (doop), C00_PG_DB (doop),
#           C00_MIGRATE_SECONDS (120), C00_QUIESCE_SECONDS (30), C00_QUIESCE_POLL_SECONDS (2),
#           C00_DF_PATH (sweep df path, /var/lib/docker),
#           C00_GUARD_FILE (default $C00_STATE_DIR/compat-unresolved.env; C00_STATE_DIR defaults to /var/lib/doop-deploy).
# Outcomes go to $GITHUB_OUTPUT as `outcome=migrate_failed|needs_operator`.
set -euo pipefail

cmd=${1:-}
container=${C00_CONTAINER:-doop}
rollback_tag=doop-rollback:previous
poll=${C00_POLL_SECONDS:-10}
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

die() { echo "c00.sh: $*" >&2; exit 1; }
need_dir() { [ -n "${C00_COMPOSE_DIR:-}" ] || die "C00_COMPOSE_DIR is not set"; }

# The host-level lock (C-5): no second deploy, and no other tool taking this lock, changes C00 while this one
# runs. Released when this process exits. Sets lock_wait_seconds (also written to $GITHUB_OUTPUT).
take_lock() {
  local t=$SECONDS
  exec 9>"${C00_LOCK_FILE:-/var/lock/doop-deploy.lock}"
  flock -w "${C00_LOCK_WAIT:-600}" 9 || die "could not take the deploy lock within ${C00_LOCK_WAIT:-600}s"
  lock_wait_seconds=$((SECONDS - t))
}

# The running container is image <digest> built from <sha>: digest first, then the revision label.
check_running() { # $1 = sha256:<64 hex>, $2 = SHA
  local id digests label
  id=$(docker inspect --format '{{.Image}}' "$container") || die "$container not found"
  digests=$(docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$id")
  grep -q "@$1\$" <<<"$digests" || die "running image digest is not $1"
  label=$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$id")
  [ "$label" = "$2" ] || die "image revision label '$label' is not the expected SHA $2"
}

restart_count() { docker inspect --format '{{.RestartCount}}' "$container"; }

# The supervised migration path is the train's. Absent, off or anything but `on` keeps the
# deploy exactly as it was before the train (the app migrates at boot); CHE-6526.
train_on() { [ "${DOOP_DEPLOY_TRAIN:-}" = on ]; }

# C-8.8: an unproven migration (outcome needs_operator) leaves a guard file that outlives every sweep. Any later
# apply, rollback, compat run or lift checks the three facts first and refuses until they hold: the migration
# container is exited, no session of its application_name is left, the advisory key is free. A guard that holds
# is cleared here. All reads are bounded; a read that fails counts as not proven.
guard_file=${C00_GUARD_FILE:-${C00_STATE_DIR:-/var/lib/doop-deploy}/compat-unresolved.env}
guard_token='^[A-Za-z0-9_.-]+$'
guard_val() { sed -n "s/^$1=//p" "$guard_file" | head -n 1; }
guard_check() {
  [ -e "$guard_file" ] || return 0
  local run mig dbc user db app v out dbup sessions locks
  run=$(guard_val run_id); mig=$(guard_val migrate_container); dbc=$(guard_val db_container)
  user=$(guard_val db_user); db=$(guard_val db_name); app=$(guard_val app_name)
  for v in "$run" "$mig" "$dbc" "$user" "$db" "$app"; do
    [[ $v =~ $guard_token ]] || die "refused: $guard_file is unreadable; an operator must prove quiescence and remove it"
  done
  local why=""
  if out=$(timeout 30 docker inspect --format '{{.State.Running}}' "$mig" 2>&1); then
    [ "$out" = false ] || why="$why migration container $mig is not exited;"
  else
    case $out in *[Nn]"o such"*) ;; *) why="$why cannot inspect $mig;" ;; esac
  fi
  if dbup=$(timeout 30 docker inspect --format '{{.State.Running}}' "$dbc" 2>&1); then :; else
    case $dbup in *[Nn]"o such"*) dbup=gone ;; *) dbup=unknown ;; esac
  fi
  case $dbup in
    true)
      if sessions=$(timeout 30 docker exec "$dbc" psql -U "$user" -d "$db" -tAc \
        "select count(*) from pg_stat_activity where application_name='$app' and pid<>pg_backend_pid()"); then
        [ "$sessions" = 0 ] || why="$why $sessions session(s) of $app are open;"
      else why="$why cannot read pg_stat_activity;"; fi
      if locks=$(timeout 30 docker exec "$dbc" psql -U "$user" -d "$db" -tAc \
        "select count(*) from pg_locks where locktype='advisory' and classid=1685025648 and objid=1 and objsubid=2"); then
        [ "$locks" = 0 ] || why="$why the advisory key is held;"
      else why="$why cannot read pg_locks;"; fi
      ;;
    false | gone) ;; # no database process, so no session and no lock
    *) why="$why cannot inspect $dbc;" ;;
  esac
  [ -z "$why" ] || die "refused: compat run $run is unresolved (needs_operator):$why fix it, then rerun"
  rm -f "$guard_file" || die "guard proven but $guard_file could not be removed"
  echo "guard cleared: compat run $run is quiescent"
}

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

# One C-5 recheck, run under the lock (confirm and rollback decide here, never before the lock). The gate's
# output goes through a private file so this script can read the action it decided, then on to $GITHUB_OUTPUT.
need_gate_inputs() {
  mode=${DEPLOY_MODE:-}
  expect=${MARKER_EXPECT:-}
  [ -n "$mode" ] && [ -n "$expect" ] || die "DEPLOY_MODE and MARKER_EXPECT are required"
}
gate_action=
gate_recheck() { # $1 = op (confirm | rollback)
  local gout rc=0
  gout=$(mktemp) || die "cannot create a temp file for the gate"
  GITHUB_OUTPUT=$gout node "$here/../../scripts/deploy-gate.mjs" recheck "$mode" --op "$1" --expect "$expect" || rc=$?
  gate_action=$(sed -n 's/^action=//p' "$gout" | tail -n 1)
  [ -z "${GITHUB_OUTPUT:-}" ] || cat "$gout" >> "$GITHUB_OUTPUT"
  rm -f "$gout"
  return $rc
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
  guard) guard_check ;;

  guard-set)
    [ $# -eq 7 ] || die "usage: c00.sh guard-set <run> <migrate container> <db container> <db user> <db name> <app name>"
    for v in "${@:2}"; do [[ $v =~ $guard_token ]] || die "guard-set: '$v' is not a plain token"; done
    mkdir -p "$(dirname "$guard_file")" || die "guard-set: cannot create $(dirname "$guard_file")"
    tmp=$guard_file.$$
    {
      printf 'run_id=%s\nmigrate_container=%s\ndb_container=%s\ndb_user=%s\ndb_name=%s\napp_name=%s\n' "${@:2}"
      printf 'written_ict=%s\n' "$(TZ=Asia/Bangkok date '+%Y-%m-%d %H:%M:%S ICT')"
    } > "$tmp" && mv "$tmp" "$guard_file" || die "guard-set: cannot write $guard_file"
    echo "guard written: $guard_file"
    ;;

  apply)
    guard_check
    ref=${DEPLOY_REF:-}
    [[ $ref =~ ^[a-z0-9._/-]+@sha256:[0-9a-f]{64}$ ]] || die "DEPLOY_REF must be image@sha256:<64 hex>, got '$ref'"
    need_dir
    mode=${DEPLOY_MODE:-}
    expect=${MARKER_EXPECT:-}
    [ -n "$mode" ] && [ -n "$expect" ] || die "DEPLOY_MODE and MARKER_EXPECT are required"
    take_lock
    # Under the lock the answer can no longer change: ask again before anything is tagged, pulled or started.
    node "$here/../../scripts/deploy-gate.mjs" recheck "$mode" --op pre-apply --expect "$expect" ||
      die "pre-apply check refused the deploy"
    set_output lock_wait_seconds "$lock_wait_seconds"
    # Under the lock, prove quiescence and read the ledger the failure path compares against.
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
    check_running "${ref##*@}" "$sha"
    wait_healthy "${C00_READBACK_SECONDS:-90}"
    # T0 for the delayed confirm (C-9): when the candidate proved healthy, and how often it had restarted.
    set_output restart_count "$(restart_count)"
    set_output health healthy
    set_output t0_epoch "$(date +%s)"
    echo "readback ok: $container runs ${ref##*@} at $sha and is healthy"
    ;;

  confirm)
    ref=${DEPLOY_REF:-}
    sha=${DEPLOY_SHA:-}
    [ -n "$ref" ] && [ -n "$sha" ] || die "DEPLOY_REF and DEPLOY_SHA are required"
    [[ ${RESTART_T0:-} =~ ^[0-9]+$ ]] && [[ ${T0_EPOCH:-} =~ ^[0-9]{10}$ ]] || die "RESTART_T0 and T0_EPOCH are required (from the readback)"
    need_gate_inputs
    take_lock
    # Under the lock: no migration may be running (switch on or off), and the marker, the quiescence proof and the
    # running digest are read again right before anything is confirmed.
    require_quiescent
    gate_recheck confirm || die "confirm check refused"
    # The wait timer lives in the repository environment, outside this repo; if it is missing the delay is
    # zero, and a confirm that early would prove nothing. Fail closed.
    waited=$(($(date +%s) - T0_EPOCH))
    [ "$waited" -ge "${C00_CONFIRM_MIN_SECONDS:-900}" ] ||
      die "readback delay not honoured: ${waited}s since T0, need ${C00_CONFIRM_MIN_SECONDS:-900}s (is the c00-readback-delay wait timer set?)"
    check_running "${ref##*@}" "$sha"
    [ "$(docker inspect --format '{{.State.Running}}' "$container" 2>/dev/null || echo false)" = true ] || die "$container is not running"
    health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$container")
    [ "$health" = healthy ] || die "$container is not healthy ($health)"
    now_restarts=$(restart_count)
    [ "$now_restarts" = "$RESTART_T0" ] || die "$container restarted since T0 (restart count $RESTART_T0 -> $now_restarts)"
    set_output restart_count_confirm "$now_restarts"
    set_output confirmed_epoch "$(date +%s)"
    echo "confirm ok: $container still runs ${ref##*@} at $sha, healthy, $now_restarts restarts, ${waited}s after T0"
    ;;

  rollback)
    # With PREDECESSOR_DIGEST and PREDECESSOR_SHA (D2 always sets both) the rollback is by digest: the retained
    # image must be that digest, and its digest, label and health are read back after the restart.
    pdigest=${PREDECESSOR_DIGEST:-}
    psha=${PREDECESSOR_SHA:-}
    if [ -n "$pdigest" ] || [ -n "$psha" ]; then
      [[ $pdigest =~ ^sha256:[0-9a-f]{64}$ ]] && [[ $psha =~ ^[0-9a-f]{40}$ ]] ||
        die "PREDECESSOR_DIGEST must be sha256:<64 hex> and PREDECESSOR_SHA a full SHA"
    fi
    guard_check
    need_gate_inputs
    take_lock
    # Decided under the lock, on what C00 and the marker say now: a deployment or a marker change that landed while
    # this waited for the lock is seen here, and nothing is replaced on a stale answer.
    require_quiescent
    gate_recheck rollback || die "rollback check refused"
    set_output action "$gate_action"
    case $gate_action in
      rollback) ;;
      none | superseded)
        echo "rollback not needed: action=$gate_action, C00 was not changed"
        exit 0
        ;;
      *) die "rollback check returned an unknown action '$gate_action'" ;;
    esac
    docker image inspect "$rollback_tag" >/dev/null 2>&1 || die "no previous image to roll back to (first deploy?)"
    if [ -n "$pdigest" ]; then
      retained=$(docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$rollback_tag") ||
        die "cannot read the retained image"
      grep -q "@$pdigest\$" <<<"$retained" || die "the retained image is not the predecessor $pdigest"
    fi
    compose_up "$rollback_tag"
    wait_healthy "${C00_ROLLBACK_SECONDS:-300}"
    if [ -n "$pdigest" ]; then
      check_running "$pdigest" "$psha"
      echo "rollback ok: $container runs the predecessor $pdigest at $psha and is healthy"
    else
      echo "rollback ok: $container runs the previous image again"
    fi
    ;;

  lift)
    guard_check
    take_lock
    # Under the lock: the three C-8.8 facts (in a subshell, so a refusal is handed on rather than exiting), then what
    # C00 runs. A read that fails leaves its fact empty, which the lift script refuses.
    if ( require_quiescent ) >&2; then LIFT_QUIESCENT=true; else LIFT_QUIESCENT=false; fi
    img=$(docker inspect --format '{{.Image}}' "$container" 2>/dev/null) || img=
    LIFT_DIGEST=
    LIFT_REVISION=
    if [ -n "$img" ]; then
      LIFT_DIGEST=$(docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$img" 2>/dev/null |
        sed -n 's/.*@\(sha256:[0-9a-f]\{64\}\)$/\1/p' | head -n 1) || LIFT_DIGEST=
      LIFT_REVISION=$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$img" 2>/dev/null) || LIFT_REVISION=
    fi
    LIFT_CONTAINER_HEALTH=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$container" 2>/dev/null) || LIFT_CONTAINER_HEALTH=
    export LIFT_QUIESCENT LIFT_DIGEST LIFT_REVISION LIFT_CONTAINER_HEALTH
    echo "lift facts: quiescent=$LIFT_QUIESCENT digest=${LIFT_DIGEST:-unknown} revision=${LIFT_REVISION:-unknown} container=${LIFT_CONTAINER_HEALTH:-unknown}"
    node "$here/../../scripts/deploy-lift.mjs" lift
    ;;

  quiescence)
    require_quiescent
    echo "quiescent: no migrate container running, no migrate session, advisory key free"
    ;;

  sweep)
    guard_check # an unproven migration keeps its sandbox: the sweep would erase the evidence
    label=doop.compat.run
    df_bytes() { df -B1 --output=avail "${C00_DF_PATH:-/var/lib/docker}" 2>/dev/null | tail -n 1 | tr -d ' ' || true; }
    echo "df_before_bytes=$(df_bytes)"
    ids=$(docker ps -aq --filter "label=$label") || die "sweep: cannot list containers"
    # shellcheck disable=SC2086
    [ -z "$ids" ] || docker rm -f -v $ids >/dev/null || die "sweep: removing containers failed"
    ids=$(docker network ls -q --filter "label=$label") || die "sweep: cannot list networks"
    # shellcheck disable=SC2086
    [ -z "$ids" ] || docker network rm $ids >/dev/null || die "sweep: removing networks failed"
    ids=$(docker volume ls -q --filter "label=$label") || die "sweep: cannot list volumes"
    # shellcheck disable=SC2086
    [ -z "$ids" ] || docker volume rm -f $ids >/dev/null || die "sweep: removing volumes failed"
    left_c=$(docker ps -aq --filter "label=$label" | wc -l | tr -d ' ')
    left_n=$(docker network ls -q --filter "label=$label" | wc -l | tr -d ' ')
    left_v=$(docker volume ls -q --filter "label=$label" | wc -l | tr -d ' ')
    [ "$left_c$left_n$left_v" = "000" ] || die "sweep: left containers=$left_c networks=$left_n volumes=$left_v"
    echo "df_after_bytes=$(df_bytes)"
    echo "sweep ok: containers=0 networks=0 volumes=0"
    ;;

  *) die "usage: c00.sh apply|readback|confirm|rollback|quiescence|lift|sweep|guard|guard-set" ;;
esac
