#!/usr/bin/env bash
# Runs on the C00 deploy runner (CHE-4585). Never builds: it pulls and runs an
# image that already exists in GHCR, named by digest.
#
#   c00.sh apply      pin the running image as the rollback target, pull DEPLOY_REF, start it
#   c00.sh readback   running digest == DEPLOY_REF's, image revision label == DEPLOY_SHA,
#                     then healthy on consecutive checks inside the window
#   c00.sh rollback   start the pinned previous image and wait for it to be healthy
#   c00.sh guard      refuse (exit 1) while an earlier migration's quiescence is unproven; re-proves the three
#                     facts and clears the guard when they hold. apply, rollback and sweep run it first; the lift
#                     job calls it. `guard-set run mig db user dbname app` writes it (compat-sandbox.mjs does).
#   c00.sh sweep      remove every doop.compat.run resource (containers, networks, volumes), read back
#                     zero, print df before and after. Needs no compose dir and no deploy ref (CHE-5474 C-8.5d).
#
# Env: DEPLOY_REF (image@sha256:...), DEPLOY_SHA, C00_COMPOSE_DIR (compose project on C00).
# Optional: C00_COMPOSE_FILE, C00_CONTAINER, C00_READBACK_SECONDS (900), C00_ROLLBACK_SECONDS (300),
#           C00_POLL_SECONDS (10), C00_STABLE_CHECKS (3), C00_DF_PATH (sweep df path, /var/lib/docker),
#           C00_GUARD_FILE (default $C00_STATE_DIR/compat-unresolved.env; C00_STATE_DIR defaults to /var/lib/doop-deploy).
set -euo pipefail

cmd=${1:-}
container=${C00_CONTAINER:-doop}
rollback_tag=doop-rollback:previous
poll=${C00_POLL_SECONDS:-10}
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

die() { echo "c00.sh: $*" >&2; exit 1; }
need_dir() { [ -n "${C00_COMPOSE_DIR:-}" ] || die "C00_COMPOSE_DIR is not set"; }

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
  DOOP_IMAGE=$1 docker compose --project-directory "$C00_COMPOSE_DIR" \
    -f "$C00_COMPOSE_DIR/${C00_COMPOSE_FILE:-compose.yaml}" -f "$here/compose.image.yml" \
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
    docker rmi "$rollback_tag" >/dev/null 2>&1 || true # a stale target must never be mistaken for this deploy's
    if prev=$(docker inspect --format '{{.Image}}' "$container" 2>/dev/null) && [ -n "$prev" ]; then
      docker tag "$prev" "$rollback_tag"
    fi
    docker pull "$ref"
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
    guard_check
    docker image inspect "$rollback_tag" >/dev/null 2>&1 || die "no previous image to roll back to (first deploy?)"
    compose_up "$rollback_tag"
    wait_healthy "${C00_ROLLBACK_SECONDS:-300}"
    echo "rollback ok: $container runs the previous image again"
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

  *) die "usage: c00.sh apply|readback|rollback|sweep|guard|guard-set" ;;
esac
