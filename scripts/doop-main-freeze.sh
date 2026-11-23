#!/usr/bin/env bash
# doop-main-freeze.sh (CHE-7594, plan CHE-7309 r13 step P3a): read-only `plan` and `status` for the main freeze.
#
#   plan   --expect-head <M_f> --probe-heads <list> --issue <id> --admin-member <id>
#          Checks every precondition for a freeze and prints S0, the point snapshot of main, with its
#          bounds. Exit 0: all checks pass, S0 is clean. Exit 2: a check failed or a read failed.
#          Exit 6: a foreign ruleset collides with our names, refs or context. Exit 64: usage.
#   status --issue <id> --admin-member <id> [--nonce <hex8>]
#          Prints the rules on main and the 4 probe refs, the ownership result of every ruleset with
#          our prefixes, current_user_can_bypass per source, mirror and freeze, and the policy hashes.
#   policy-hash --rules-file <f> [--freeze-id <id[,id]>] [--sources-file <f>]
#          Prints the normalized sha256 of a rule list (and, with --sources-file, Pm).
#
# The source set is read on every run: the ruleset ids that rules/branches/main lists, minus every
# ruleset that carries one of our prefixes. There is no id list to pass or to keep current.
#
# Neither plan nor status writes anything: every gh call is a read (the merge queue count is a GraphQL
# query, which gh sends as a POST) and the only multica call is a comment list. Every bound is GitHub server time (see lib/gh-read.sh); the local clock is never read.
#
# Environment: DOOP_REPO (default cheese-work/doop), DOOP_BASE (default cheese/main),
# MULTICA_CLI_PATH (default multica), GH_BIN (default gh).

set -u
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib/gh-read.sh
. "$HERE/lib/gh-read.sh"
# shellcheck source=lib/ruleset-owner.sh
. "$HERE/lib/ruleset-owner.sh"
# shellcheck source=lib/freeze-classify.sh
. "$HERE/lib/freeze-classify.sh"

REPO=${DOOP_REPO:-cheese-work/doop}
BASE=${DOOP_BASE:-cheese/main}
MULTICA=${MULTICA_CLI_PATH:-multica}
PROBES=(q-frozen q-open d-frozen d-open)
export GH_READ_TRACE=1

usage() {
  sed -n '2,/^$/p' "$0" | sed 's/^# \{0,1\}//' >&2
  exit 64
}
die_usage() { echo "usage error: $*" >&2; exit 64; }

FAILS=0
FOREIGN=0
fail() { FAILS=$((FAILS + 1)); echo "FAIL $1${2:+: $2}"; }
ok() { echo "ok $1"; }
finish() {
  if [ $FOREIGN -gt 0 ]; then exit 6; fi
  if [ $FAILS -gt 0 ]; then exit 2; fi
  exit 0
}
# a failed read ends the run: nothing past it can be trusted
read_failed() { fail "read" "$GH_ERR"; exit 2; }

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

iso() { gh_iso "$1"; }

# ---------------------------------------------------------------- argument parsing
parse_args() {
  EXPECT_HEAD="" PROBE_HEADS="" ISSUE="" ADMIN="" NONCE="" SOURCES=""
  RULES_FILE="" FREEZE_IDS="" SOURCES_FILE=""
  while [ $# -gt 0 ]; do
    [ $# -ge 2 ] || die_usage "$1 needs a value"
    case "$1" in
      --expect-head) EXPECT_HEAD=$2 ;;
      --probe-heads) PROBE_HEADS=$2 ;;
      --issue) ISSUE=$2 ;;
      --admin-member) ADMIN=$2 ;;
      --nonce) NONCE=$2 ;;
      --rules-file) RULES_FILE=$2 ;;
      --freeze-id) FREEZE_IDS="${FREEZE_IDS:+$FREEZE_IDS,}$2" ;;
      --sources-file) SOURCES_FILE=$2 ;;
      *) die_usage "unknown argument $1" ;;
    esac
    shift 2
  done
}

# ---------------------------------------------------------------- policy hash
# normalized rule list: type and parameters only (no ruleset id or source), sorted, key order fixed
normalize_rules() { # <rules.json> [excluded ids csv]
  jq -cS --arg ex "${2:-}" '
    ($ex | split(",") | map(select(length > 0) | tonumber)) as $skip
    | [.[] | select((.ruleset_id as $i | $skip | index($i)) == null) | {type, parameters: (.parameters // null)}]
    | sort_by(tojson)' "$1"
}
sha_of() { sha256sum | cut -d' ' -f1; }
policy_hash() { # <rules.json> [excluded ids csv] [sources.json]
  if [ -n "${3:-}" ]; then
    jq -cS -n --slurpfile r <(normalize_rules "$1" "${2:-}") --slurpfile s "$3" \
      '{rules: $r[0], sources: ($s[0] | map({id, updated_at, bypass_actors}) | sort_by(.id))}' | sha_of
  else
    normalize_rules "$1" "${2:-}" | sha_of
  fi
}

cmd_policy_hash() {
  [ -n "$RULES_FILE" ] || die_usage "policy-hash needs --rules-file"
  [ -f "$RULES_FILE" ] || die_usage "no such file: $RULES_FILE"
  policy_hash "$RULES_FILE" "$FREEZE_IDS" "$SOURCES_FILE"
}

# ---------------------------------------------------------------- shared reads
# load_rulesets: reads the ruleset list and every detail, the rules on main, and the intent records; derives
# the source set ($SOURCES, csv) and classifies every ruleset.
# Result files under $WORK: list.ndjson, rs/<id>.json, rules-main.json, owners.tsv (id<TAB>result), comments.json
load_rulesets() {
  mkdir -p "$WORK/rs"
  gh_read_list "repos/$REPO/rulesets" || read_failed
  jq -c '.[]' <<<"$GH_BODY" >"$WORK/list.ndjson"
  local row id
  while IFS= read -r row; do
    id=$(jq -r '.id' <<<"$row")
    gh_read "repos/$REPO/rulesets/$id" || read_failed
    printf '%s' "$GH_BODY" >"$WORK/rs/$id.json"
  done <"$WORK/list.ndjson"
  if ! "$MULTICA" issue comment list "$ISSUE" --full --output json >"$WORK/comments.json" 2>"$WORK/comments.err" ||
    ! jq -e 'type == "array"' "$WORK/comments.json" >/dev/null 2>&1; then
    fail "intent-records" "cannot read the comments of issue $ISSUE"
    exit 2
  fi
  # the source set: every ruleset that rules/branches/main lists, except those with our prefixes
  gh_read_list "repos/$REPO/rules/branches/main" || read_failed
  printf '%s' "$GH_BODY" >"$WORK/rules-main.json"
  PRE_IDS=$(prefixed_ids)
  SOURCES=$(jq -r --arg ex "$PRE_IDS" '
    ($ex | split(",") | map(select(length > 0) | tonumber)) as $skip
    | [.[] | .ruleset_id | select(. != null and ((. as $i | $skip | index($i)) == null))] | unique | map(tostring) | join(",")' "$WORK/rules-main.json")
  RO_DETAIL_DIR="$WORK/rs"
  : >"$WORK/owners.tsv"
  local f res
  for f in "$WORK"/rs/*.json; do
    [ -e "$f" ] || continue
    res=$(ro_classify "$f" "$WORK/comments.json" "$ADMIN" "$SOURCES")
    printf '%s\t%s\n' "$(jq -r '.id' "$f")" "$res" >>"$WORK/owners.tsv"
  done
}

# every source needs a repository ruleset detail: its updated_at and bypass actors are part of Pm
missing_source_detail() {
  local s miss=""
  local -a ids=()
  IFS=',' read -r -a ids <<<"$SOURCES"
  for s in "${ids[@]}"; do [ -z "$s" ] || [ -f "$WORK/rs/$s.json" ] || miss="${miss:+$miss,}$s"; done
  echo "$miss"
}

# prefixed_ids: ids of rulesets with our name prefixes (own or foreign), comma separated
prefixed_ids() {
  local f ids=""
  for f in "$WORK"/rs/*.json; do
    [ -e "$f" ] || continue
    if ro_has_prefix "$(jq -r '.name // ""' "$f")"; then ids="${ids:+$ids,}$(jq -r '.id' "$f")"; fi
  done
  echo "$ids"
}

# ---------------------------------------------------------------- plan
cmd_plan() {
  [ -n "$EXPECT_HEAD" ] || die_usage "plan needs --expect-head"
  [ -n "$PROBE_HEADS" ] || die_usage "plan needs --probe-heads"
  [ -n "$ISSUE" ] || die_usage "plan needs --issue"
  [ -n "$ADMIN" ] || die_usage "plan needs --admin-member"
  [[ "$EXPECT_HEAD" =~ ^[0-9a-f]{40}$ ]] || die_usage "--expect-head is not a 40-hex sha"

  gh_read_init || read_failed
  load_rulesets

  # ownership: any foreign ruleset ends in exit 6; an own freeze or mirror is stale
  local id res kind nonce
  while IFS=$'\t' read -r id res; do
    case "$res" in
      foreign*)
        FOREIGN=$((FOREIGN + 1))
        echo "FAIL ownership: ruleset $id is foreign: ${res#foreign }" ;;
      "own "*)
        kind=$(cut -d' ' -f2 <<<"$res"); nonce=$(cut -d' ' -f3 <<<"$res")
        fail "stale-own" "stale own #$nonce ($kind ruleset $id)" ;;
    esac
  done <"$WORK/owners.tsv"
  [ $FOREIGN -eq 0 ] || { echo "foreign ruleset found: no snapshot taken"; finish; }

  # source rules on main, without the rules of any ruleset that carries our prefix
  local pre_ids=$PRE_IDS facts miss
  miss=$(missing_source_detail)
  if [ -n "$miss" ]; then fail source-detail "no repository ruleset detail for source id(s) $miss"; else ok source-detail; fi
  facts=$(jq -c --arg ex "$pre_ids" '
    ($ex | split(",") | map(select(length > 0) | tonumber)) as $skip
    | [.[] | select((.ruleset_id as $i | $skip | index($i)) == null)]' "$WORK/rules-main.json" >"$WORK/src-rules.json" && fc_pin_facts "$WORK/src-rules.json")
  if [ "$(jq -r '.has_update' <<<"$facts")" = true ]; then fail source-update "a source ruleset on main has an update rule"; else ok source-update; fi
  if [ "$(jq -r '.has_freeze_context' <<<"$facts")" = true ]; then fail source-context "a source ruleset on main requires $RO_CTX"; else ok source-context; fi

  # no workflow file may report the freeze context
  gh_read "repos/$REPO/contents/.github/workflows?ref=$EXPECT_HEAD" || read_failed
  local wf_hit=0 path
  while IFS= read -r path; do
    case "$path" in *.yml | *.yaml) ;; *) continue ;; esac
    gh_read "repos/$REPO/contents/$path?ref=$EXPECT_HEAD" -H 'Accept: application/vnd.github.raw' || read_failed
    if grep -iqF 'main-frozen' <<<"$GH_BODY"; then wf_hit=1; echo "  $path mentions main-frozen"; fi
  done < <(jq -r '.[]?.path' <<<"$GH_BODY" 2>/dev/null)
  if [ $wf_hit = 1 ]; then fail workflow-context "a workflow file reports the main-frozen context"; else ok workflow-context; fi

  # probe heads: the fixed order q-frozen q-open d-frozen d-open, bare or as name=sha
  local -a given=()
  IFS=',' read -r -a given <<<"$PROBE_HEADS"
  local i n sha named=0
  if [ ${#given[@]} -ne ${#PROBES[@]} ]; then
    fail probe-heads "expected ${#PROBES[@]} heads, got ${#given[@]}"
  else
    for i in "${!PROBES[@]}"; do
      if [[ "${given[$i]}" == *=* ]]; then named=1; fi
    done
    local bad=0
    for i in "${!PROBES[@]}"; do
      n=${PROBES[$i]}; sha=${given[$i]}
      if [ $named = 1 ]; then
        sha=$(printf '%s\n' "${given[@]}" | sed -n "s/^$n=//p" | head -n 1)
      fi
      gh_read "repos/$REPO/git/ref/heads/freeze-probe/$n" || read_failed
      if [ "$(jq -r '.object.sha // ""' <<<"$GH_BODY")" != "$sha" ]; then bad=1; echo "  freeze-probe/$n is not at ${sha:-<none>}"; fi
    done
    if [ $bad = 1 ]; then fail probe-heads "a probe branch head differs"; else ok probe-heads; fi
  fi

  # M_f is contained in $BASE: a permanent relation (BASE only moves forward), so it is read outside S0
  gh_read "repos/$REPO/compare/$BASE...$EXPECT_HEAD" || read_failed
  case "$(jq -r '.status // ""' <<<"$GH_BODY")" in
    behind | identical) ok head-compare ;;
    *) fail head-compare "$EXPECT_HEAD is not contained in $BASE" ;;
  esac

  # S0: the point snapshot of main, 4 reads
  local lo_min="" hi_max="" lo hi
  snap() { lo=$GH_LO; hi=$GH_HI; [ -n "$lo_min" ] && [ "$lo_min" -le "$lo" ] || lo_min=$lo; [ -n "$hi_max" ] && [ "$hi_max" -ge "$hi" ] || hi_max=$hi; }

  GH_LABEL=snapshot:queue gh_read graphql -f query="query { repository(owner:\"${REPO%%/*}\", name:\"${REPO##*/}\") { mergeQueue(branch:\"main\") { entries(first:1) { totalCount } } } }" || read_failed
  snap
  local entries
  entries=$(jq -r '.data.repository.mergeQueue.entries.totalCount // "unreadable"' <<<"$GH_BODY" 2>/dev/null || echo unreadable)
  if [ "$entries" = 0 ]; then ok queue-entries; else fail queue-entries "totalCount=$entries"; fi

  GH_LABEL=snapshot:groups gh_read "repos/$REPO/git/matching-refs/heads/gh-readonly-queue/main/" || read_failed
  snap
  n=$(jq 'if type == "array" then length else -1 end' <<<"$GH_BODY" 2>/dev/null || echo -1)
  if [ "$n" = 0 ]; then ok group-refs; else fail group-refs "$n live group refs"; fi

  GH_LABEL=snapshot:pulls gh_read "repos/$REPO/pulls?state=open&base=main&per_page=1&page=1" || read_failed
  snap
  n=$(jq 'if type == "array" then length else -1 end' <<<"$GH_BODY" 2>/dev/null || echo -1)
  if [ "$n" = 0 ]; then ok open-prs; else fail open-prs "$n open PRs into main"; fi

  GH_LABEL=snapshot:head gh_read "repos/$REPO/git/ref/heads/main" || read_failed
  snap
  sha=$(jq -r '.object.sha // ""' <<<"$GH_BODY")
  if [ "$sha" = "$EXPECT_HEAD" ]; then ok head; else fail head "main is at ${sha:-<unreadable>}, expected $EXPECT_HEAD"; fi

  if [ $FAILS -eq 0 ]; then
    echo "S0 lo=$(iso "$lo_min") hi=$(iso "$hi_max") clean"
  else
    echo "S0 lo=$(iso "$lo_min") hi=$(iso "$hi_max") dirty"
  fi
  finish
}

# ---------------------------------------------------------------- status
cmd_status() {
  [ -n "$ISSUE" ] || die_usage "status needs --issue"
  [ -n "$ADMIN" ] || die_usage "status needs --admin-member"
  if [ -n "$NONCE" ] && ! [[ "$NONCE" =~ ^[0-9a-f]{8}$ ]]; then die_usage "--nonce is not 8 hex digits"; fi

  gh_read_init || read_failed
  load_rulesets

  local pre_ids=$PRE_IDS

  # rules on main (read with the rulesets) and on each probe ref
  local ref label
  for ref in main "${PROBES[@]/#/freeze-probe/}"; do
    if [ "$ref" != main ]; then
      gh_read_list "repos/$REPO/rules/branches/$ref" || read_failed
      printf '%s' "$GH_BODY" >"$WORK/rules-$(tr / - <<<"$ref").json"
    fi
    echo "rules $ref:"
    jq -r '.[] | "  ruleset=\(.ruleset_id) type=\(.type)"' "$WORK/rules-$(tr / - <<<"$ref").json"
  done

  # ownership of every ruleset with our prefixes (or a collision), and the source rulesets
  local id res f name bypass shown=0 kind nonce src line detail
  while IFS=$'\t' read -r id res; do
    f="$WORK/rs/$id.json"
    name=$(jq -r '.name // ""' "$f")
    bypass=$(jq -r '.current_user_can_bypass // "unknown"' "$f")
    case "$res" in
      "own "*)
        kind=$(cut -d' ' -f2 <<<"$res"); nonce=$(cut -d' ' -f3 <<<"$res")
        src=$(grep -o 'source=[0-9]*' <<<"$res" || true)
        [ -z "$NONCE" ] || [ "$nonce" = "$NONCE" ] || continue
        echo "ruleset $id name=\"$name\" owner=own kind=$kind nonce=$nonce${src:+ $src} current_user_can_bypass=$bypass"
        shown=$((shown + 1)) ;;
      foreign*)
        nonce=$(grep -o '#[0-9a-f]\{8\}' <<<"$name" | head -n 1 | tr -d '#' || true)
        [ -z "$NONCE" ] || [ "$nonce" = "$NONCE" ] || continue
        line=${res#foreign }
        detail=""
        [ "${line#* }" = "$line" ] || detail=" detail=\"${line#* }\""
        echo "ruleset $id name=\"$name\" owner=foreign reason=${line%% *}$detail current_user_can_bypass=$bypass"
        shown=$((shown + 1)) ;;
      other)
        if [ -z "$NONCE" ]; then
          case ",$SOURCES," in
            *",$id,"*) echo "ruleset $id name=\"$name\" role=source enforcement=$(jq -r '.enforcement' "$f") current_user_can_bypass=$bypass" ;;
          esac
        fi ;;
    esac
  done <"$WORK/owners.tsv"
  if [ -n "$NONCE" ] && [ $shown -eq 0 ]; then echo "nonce $NONCE: no rulesets"; fi

  # policy hashes: our rulesets' rules are left out, so a freeze does not change the policy it sits on
  for ref in main "${PROBES[@]/#/freeze-probe/}"; do
    label=$ref
    echo "policy $label sha256=$(policy_hash "$WORK/rules-$(tr / - <<<"$ref").json" "$pre_ids")"
  done
  # Pm adds each source ruleset's id, updated_at and bypass list
  local miss
  miss=$(missing_source_detail)
  if [ -n "$miss" ]; then
    fail source-detail "no repository ruleset detail for source id(s) $miss: Pm not computed"
    exit 2
  fi
  local src_json="$WORK/sources.json"
  local -a src_files=()
  local s
  IFS=',' read -r -a src_ids <<<"$SOURCES"
  for s in "${src_ids[@]}"; do [ -z "$s" ] || src_files+=("$WORK/rs/$s.json"); done
  if [ ${#src_files[@]} -gt 0 ]; then jq -cs '.' "${src_files[@]}" >"$src_json"; else echo '[]' >"$src_json"; fi
  echo "Pm sha256=$(policy_hash "$WORK/rules-main.json" "$pre_ids" "$src_json")"
  exit 0
}

# ---------------------------------------------------------------- main
[ $# -ge 1 ] || usage
CMD=$1
shift
case "$CMD" in
  plan | status | policy-hash) ;;
  *) die_usage "unknown command $CMD" ;;
esac
parse_args "$@"
case "$CMD" in
  plan) cmd_plan ;;
  status) cmd_status ;;
  policy-hash) cmd_policy_hash ;;
esac
