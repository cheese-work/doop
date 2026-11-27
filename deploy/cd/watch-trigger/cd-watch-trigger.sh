#!/usr/bin/env bash
# cd-watch-trigger.sh (CHE-10354, plan CHE-9850): a non-GitHub trigger for the CD freshness watch.
#
# GitHub's own cron skips slots (CHE-9479), so X99 dispatches `cd-freshness-watch.yml` from a systemd user timer.
# The watch is guarded by "no D2 run since the slot", so an extra dispatch is harmless, and the dispatch the watch
# itself sends uses the workflow token, so the D2 gate is not bypassed.
#
# This script can dispatch exactly one workflow on exactly one ref. It takes no arguments and never names the deploy
# workflow. The token is minted for one repository with `actions: write` only, kept in memory, and never printed.
#
# Environment (tests only): CD_WATCH_TOKEN_BIN (token minter), GH_BIN (gh).
set -euo pipefail

REPO=cheese-work/doop
WORKFLOW=cd-freshness-watch.yml
REF=cheese/main
MINT=${CD_WATCH_TOKEN_BIN:-$HOME/projects/cheese-work/multica-dotfiles/scripts/bot-token/github-app-token.sh}
GH=${GH_BIN:-gh}

if ! token=$(GITHUB_APP_OWNER=cheese-work GITHUB_APP_REPOSITORIES='["doop"]' \
  GITHUB_APP_PERMISSIONS='{"actions":"write"}' "$MINT"); then
  echo "cd-watch-trigger: token mint failed" >&2
  exit 1
fi
if [ -z "$token" ]; then
  echo "cd-watch-trigger: token minter printed nothing" >&2
  exit 1
fi

GH_TOKEN=$token "$GH" workflow run "$WORKFLOW" -R "$REPO" --ref "$REF"
echo "cd-watch-trigger: dispatched $WORKFLOW on $REF"
