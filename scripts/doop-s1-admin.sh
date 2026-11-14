#!/usr/bin/env bash
# CHE-5543 / plan CHE-5474 C-1 steps 1-4 and 6. Run once by a repo admin of cheese-work/doop
# AFTER the S1 PR is merged into cheese/main (it carries merge-queue-watch and the mirror workflow).
# Usage: bash doop-s1-admin.sh apply | verify | rollback
set -euo pipefail
R=cheese-work/doop
UP=kgoedecke/doop  # fork parent; the mirror script fast-forwards from here
rs() { gh api "repos/$R/rulesets" --jq ".[]|select(.name==\"$1\")|.id"; }

die() { echo "ERROR: $*" >&2; exit 1; }
# 3 (branch): upstream-main must exist at, or behind, the UPSTREAM tip, never cut from fork main. Fork main
# has diverged from upstream (fork-only commits), so such a branch could never fast-forward (CHE-5543 review P1).
# Fork and parent share one object network, so the ref can point at the parent commit directly.
# Any failure aborts apply before rulesets or the default branch change (CHE-5543 review round 2 P1).
seed_upstream_main() {
  local sha status
  sha=$(gh api "repos/$UP/git/ref/heads/main" --jq .object.sha) || die "cannot read $UP main; upstream-main not seeded"
  [ -n "$sha" ] || die "empty $UP main sha; upstream-main not seeded"
  if gh api "repos/$R/git/ref/heads/upstream-main" >/dev/null 2>&1; then
    # existing branch must be an ancestor of the upstream tip (compare upstream-main...tip is ahead or identical)
    status=$(gh api "repos/$R/compare/upstream-main...$sha" --jq .status) || die "cannot compare upstream-main with $UP main"
    case "$status" in ahead | identical) ;; *) die "existing upstream-main is not an ancestor of $UP main (compare status: $status); fix or delete it first" ;; esac
  else
    gh api "repos/$R/git/refs" -f ref=refs/heads/upstream-main -f sha="$sha" >/dev/null || die "could not create upstream-main from $UP main"
  fi
}

apply() {
  gh api "repos/$R/contents/.github/workflows/merge-queue-watch.yml?ref=cheese/main" --jq .path >/dev/null  # C-1.6 precondition
  seed_upstream_main  # exits non-zero before any settings change if the mirror branch is not usable
  # 1: retarget both rulesets to refs/heads/main
  for n in "protect main" "protect default branches"; do
    id=$(rs "$n")
    gh api "repos/$R/rulesets/$id" | jq '{name,target,enforcement,bypass_actors:(.bypass_actors // []),rules,conditions:{ref_name:{include:["refs/heads/main"],exclude:[]}}}' \
      | gh api -X PUT "repos/$R/rulesets/$id" --input - --jq .id
  done
  # 2: protect cheese/main (no merge queue); checks = contexts ci.yml reports (PR #34 on cheese/main)
  jq -n '{name:"protect cheese/main",target:"branch",enforcement:"active",bypass_actors:[],
    conditions:{ref_name:{include:["refs/heads/cheese/main"],exclude:[]}},
    rules:[{type:"deletion"},{type:"non_fast_forward"},
      {type:"pull_request",parameters:{required_approving_review_count:0,dismiss_stale_reviews_on_push:true,require_code_owner_review:false,require_last_push_approval:false,required_review_thread_resolution:true,allowed_merge_methods:["merge","squash","rebase"]}},
      {type:"required_status_checks",parameters:{strict_required_status_checks_policy:false,do_not_enforce_on_create:true,
        required_status_checks:[{context:"commit-message"},{context:"typecheck"},{context:"lint"},{context:"build"},{context:"tests"}]}}]}' \
    | gh api -X POST "repos/$R/rulesets" --input - --jq .id
  # 3: upstream-main ruleset: deletion only
  jq -n '{name:"protect upstream-main",target:"branch",enforcement:"active",bypass_actors:[],
    conditions:{ref_name:{include:["refs/heads/upstream-main"],exclude:[]}},rules:[{type:"deletion"}]}' \
    | gh api -X POST "repos/$R/rulesets" --input - --jq .id
  # 3: environment for the mirror App token. Secrets C00_MULTICADO_APP_ID / C00_MULTICADO_CI_PRIVATE_KEY:
  #    set by the owner (gh secret set ... --env ci-app-token -R $R); this script never handles the key.
  jq -n '{deployment_branch_policy:{protected_branches:false,custom_branch_policies:true}}' | gh api -X PUT "repos/$R/environments/ci-app-token" --input - --jq .name
  gh api -X POST "repos/$R/environments/ci-app-token/deployment-branch-policies" -f name=cheese/main --jq .name || true
  # 4: switch default branch
  gh api -X PATCH "repos/$R" -f default_branch=cheese/main --jq .default_branch
  date -u +"switched at %FT%TZ ($(TZ=Asia/Bangkok date +%T) ICT)"
}
verify() {
  gh api "repos/$R/git/ref/heads/upstream-main" --jq .object.sha >/dev/null || die "upstream-main is missing"
  gh api "repos/$R" --jq '"default_branch=" + .default_branch'
  gh api "repos/$R/rulesets" --jq '.[]|[.name,(.id|tostring)]|@tsv'
  gh api "repos/$R/rulesets" --jq '.[]|.id' | while read -r id; do gh api "repos/$R/rulesets/$id" --jq '[.name,.conditions.ref_name.include[0],([.rules[].type]|join(","))]|@tsv'; done
  gh api "repos/$R/actions/workflows/merge-queue-watch.yml/runs?event=schedule&per_page=3" --jq '.workflow_runs[]|[.id,.head_branch,.conclusion,.created_at]|@tsv'
}
rollback() {  # C-1.5
  gh api -X PATCH "repos/$R" -f default_branch=main --jq .default_branch
  for n in "protect main" "protect default branches"; do
    id=$(rs "$n")
    gh api "repos/$R/rulesets/$id" | jq '{name,target,enforcement,bypass_actors:(.bypass_actors // []),rules,conditions:{ref_name:{include:["~DEFAULT_BRANCH"],exclude:[]}}}' \
      | gh api -X PUT "repos/$R/rulesets/$id" --input - --jq .id
  done
}
"${1:?apply|verify|rollback}"
