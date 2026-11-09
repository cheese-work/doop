#!/usr/bin/env bash
# Runs on the C00 deploy runner (CHE-4585). Never builds: it pulls and runs an
# image that already exists in GHCR, named by digest.
#
#   c00.sh apply      pin the running image as the rollback target, pull DEPLOY_REF, start it
#   c00.sh readback   running digest == DEPLOY_REF's, image revision label == DEPLOY_SHA,
#                     then healthy on consecutive checks inside the window
#   c00.sh rollback   start the pinned previous image and wait for it to be healthy
#
# Env: DEPLOY_REF (image@sha256:...), DEPLOY_SHA, C00_COMPOSE_DIR (compose project on C00).
# Optional: C00_COMPOSE_FILE, C00_CONTAINER, C00_READBACK_SECONDS (900), C00_ROLLBACK_SECONDS (300),
#           C00_POLL_SECONDS (10), C00_STABLE_CHECKS (3).
set -euo pipefail

cmd=${1:-}
container=${C00_CONTAINER:-doop}
rollback_tag=doop-rollback:previous
poll=${C00_POLL_SECONDS:-10}
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

die() { echo "c00.sh: $*" >&2; exit 1; }
need_dir() { [ -n "${C00_COMPOSE_DIR:-}" ] || die "C00_COMPOSE_DIR is not set"; }

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
  apply)
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
    docker image inspect "$rollback_tag" >/dev/null 2>&1 || die "no previous image to roll back to (first deploy?)"
    compose_up "$rollback_tag"
    wait_healthy "${C00_ROLLBACK_SECONDS:-300}"
    echo "rollback ok: $container runs the previous image again"
    ;;

  *) die "usage: c00.sh apply|readback|rollback" ;;
esac
