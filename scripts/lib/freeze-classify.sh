# shellcheck shell=bash
# Refusal table (CHE-7594, plan CHE-7309 P3a). Source this file; P3b and P3c reuse it.
#
#   fc_classify <text|reason> <value> [<pin facts JSON>]
#     prints one class: freeze-specific | generic-rule | queue-removal | unrelated | unknown
#   fc_passes_direct <class>   exit 0 only for freeze-specific (a direct or immediate-enqueue refusal)
#   fc_pin_facts <rules.json>  prints {"has_update":bool,"has_freeze_context":bool} for a rule list
#                              (the ref's rules without our freeze's)
#
# `text` is an error text; `reason` is a queue removal reason (or a PR state such as draft). Input is
# lower-cased here. Pin facts must show that the ref's non-freeze rules have no `update` rule and no
# context named `main-frozen (CHE-7309)`; without them a freeze-looking text is generic-rule.

FC_FREEZE_CONTEXT='main-frozen (che-7309)'

fc_pin_facts() {
  jq -c '{
    has_update: (map(select(.type == "update")) | length > 0),
    has_freeze_context: ([.[] | select(.type == "required_status_checks") | (.parameters.required_status_checks // [])[] | .context] | index("main-frozen (CHE-7309)") != null)
  }' "$1"
}

fc_passes_direct() { [ "$1" = freeze-specific ]; }

fc_classify() {
  local mode=$1 v=${2-} facts=${3-}
  v=${v,,}
  v=${v#"${v%%[![:space:]]*}"}
  v=${v%"${v##*[![:space:]]}"}
  case "$mode" in
    reason) _fc_reason "$v" ;;
    text) _fc_text "$v" "$facts" ;;
    *) echo unknown ;;
  esac
}

_fc_reason() {
  case "$1" in
    branch_protections | checks_timed_out | ci_timeout) echo queue-removal ;;
    merge_conflict | manual | manually_removed | ci_failure | checks_failed | failed_checks | queue_cleared | already_merged | merged | git_tree_invalid | invalid_merge_commit | roll_back | draft | conflict | closed | closed_pr)
      echo unrelated ;;
    *) echo unknown ;;
  esac
}

_fc_text() {
  local t=$1 facts=$2 clean=0
  case "$t" in "" | null) echo unknown; return ;; esac
  # a transport error is never a refusal
  case "$t" in
    *timeout* | *"timed out"* | *"deadline exceeded"* | *"rate limit"* | *"http 5"* | *" 500"* | *" 502"* | *" 503"* | *" 504"* | *"gateway"* | *"connection reset"* | *"connection refused"* | *"service unavailable"* | *"internal server error"*)
      echo unknown; return ;;
  esac
  if [[ "$t" == *"$FC_FREEZE_CONTEXT"* || "$t" == *"cannot update this protected ref"* ]]; then
    if [ -n "$facts" ] && jq -e '.has_update == false and .has_freeze_context == false' <<<"$facts" >/dev/null 2>&1; then clean=1; fi
    if [ $clean = 1 ]; then echo freeze-specific; else echo generic-rule; fi
    return
  fi
  case "$t" in
    *"repository rule violation"* | *"rule violations"* | *"merge queue"* | *"required status check"* | *"status check"* | *"approving review"* | *"review is required"* | *"required review"* | *"code owner"* | *"pull request"* | *"protected ref"* | *"protected branch"* | *"non-fast-forward"* | *"signed commits"*)
      echo generic-rule ;;
    *) echo unknown ;;
  esac
}
