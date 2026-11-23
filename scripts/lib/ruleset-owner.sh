# shellcheck shell=bash
# Ruleset ownership (CHE-7594, plan CHE-7309 P3a). Source this file; P3b, P3c and P3d reuse it.
#
#   ro_has_prefix <name>   exit 0 when the name starts with one of our ruleset prefixes
#   ro_classify <detail.json> <comments.json> <admin-member-id> <source-ids-csv>
#     prints one line:
#       own freeze <nonce>
#       own mirror <nonce> source=<id>
#       own pin <nonce>
#       own fence <nonce>              port merge fence (CHE-7309)
#       own actor <nonce>              port merge actor (CHE-7309)
#       foreign <reason> [detail]      reasons: bad-name no-intent unknown-source bad-shape collision
#       other                          not ours, not a collision
#
# A ruleset is ours only when all three hold: its name is `<prefix> #<8 hex>` (a mirror adds `.<source id>`),
# an intent record of the right kind for this nonce exists as a whole line of a comment by the admin member,
# and its shape equals what the script sets (only the fields the script sets are compared; fields GitHub
# adds are ignored). Anything with our prefix that fails one of these is foreign. A ruleset without our
# prefix is a collision when it names a freeze-probe or guard-rehearsal ref or requires the main-frozen
# context, a ruleset that main lists as a source included. Unreadable bypass actors (null) fail closed.
#
# A mirror is compared with its source ruleset, read from "$RO_DETAIL_DIR/<source id>.json".

RO_CTX='main-frozen (CHE-7309)'
RO_P_FREEZE='freeze main (CHE-7309)'
RO_P_MIRROR='freeze probe mirror (CHE-7309)'
RO_P_PIN='port head pin (CHE-7309)'
RO_P_FENCE='port merge fence (CHE-7309)'
RO_P_ACTOR='port merge actor (CHE-7309)'
RO_FREEZE_INCLUDE='["refs/heads/freeze-probe/d-frozen","refs/heads/freeze-probe/q-frozen","refs/heads/main"]'
RO_MIRROR_INCLUDE='["refs/heads/freeze-probe/d-frozen","refs/heads/freeze-probe/d-open","refs/heads/freeze-probe/q-frozen","refs/heads/freeze-probe/q-open"]'

ro_has_prefix() {
  case "$1" in "$RO_P_FREEZE "* | "$RO_P_MIRROR "* | "$RO_P_PIN "* | "$RO_P_FENCE "* | "$RO_P_ACTOR "*) return 0 ;; esac
  return 1
}

# canonical rule list: type + parameters only, sorted
_ro_rules() { jq -cS '[.rules[]? | {type, parameters: (.parameters // null)}] | sort_by(tojson)'; }

_ro_freeze_rules() {
  jq -cnS --arg ctx "$RO_CTX" '[
    {type:"update",parameters:null},
    {type:"deletion",parameters:null},
    {type:"non_fast_forward",parameters:null},
    {type:"required_status_checks",parameters:{strict_required_status_checks_policy:false,do_not_enforce_on_create:false,required_status_checks:[{context:$ctx}]}}
  ] | sort_by(tojson)'
}

_ro_pin_rules() {
  jq -cnS '[{type:"update",parameters:null},{type:"deletion",parameters:null},{type:"non_fast_forward",parameters:null}] | sort_by(tojson)'
}

# Merge fence A (port merge fence): the fields the script sets, reduced to type + those parameters.
# GitHub adds defaults to pull_request and required_status_checks; they are ignored.
_ro_fence_view() {
  jq -cS '[.rules[]? | if .type == "required_status_checks" then
      {type, strict: .parameters.strict_required_status_checks_policy,
       contexts: ([.parameters.required_status_checks[]?.context] | sort)}
    elif .type == "pull_request" then
      {type, methods: ((.parameters.allowed_merge_methods // []) | sort), approvals: .parameters.required_approving_review_count}
    else {type} end] | sort_by(tojson)'
}
_ro_fence_expected() {
  jq -cnS '[
    {type:"required_status_checks",strict:true,contexts:["build","commit-message","lint","tests","typecheck"]},
    {type:"pull_request",methods:["merge"],approvals:0}
  ] | sort_by(tojson)'
}

# _ro_common_shape <detail.json> <strict|mirror|actor>: empty when target/enforcement/bypass/exclude are canonical,
# else a reason. A mirror copies enforcement and bypass actors from its source, so only the source
# comparison constrains them; null bypass actors still fail closed. An actor ruleset (merge fence B) has
# exactly one bypass actor, so the empty-list rule is replaced by its own check.
_ro_common_shape() {
  jq -r --arg mode "$2" '
    if .target != "branch" then "target"
    elif .bypass_actors == null then "bypass_actors unreadable (null)"
    elif ((.conditions.ref_name.exclude // []) != []) then "exclude not empty"
    elif $mode == "mirror" then ""
    elif .enforcement != "active" then "enforcement"
    elif $mode == "actor" then
      (if (.bypass_actors | length) == 1 and (.bypass_actors[0].actor_type == "User")
          and (.bypass_actors[0].bypass_mode == "pull_request") and ((.bypass_actors[0].actor_id | type) == "number")
       then "" else "bypass_actors not exactly one User with mode pull_request" end)
    elif .bypass_actors != [] then "bypass_actors not empty"
    else "" end' "$1"
}

ro_classify() {
  local detail=$1 comments=$2 admin=$3 sources=$4
  local name id nonce kind="" src="" want="" prefix reason inc mode
  name=$(jq -r '.name // ""' "$detail")
  id=$(jq -r '.id' "$detail")

  if ! ro_has_prefix "$name"; then
    if jq -e --arg ctx "$RO_CTX" '
        ([.conditions.ref_name.include[]? | select(startswith("refs/heads/freeze-probe/") or startswith("refs/heads/guard-rehearsal/"))] | length > 0)
        or ([.rules[]? | select(.type == "required_status_checks") | .parameters.required_status_checks[]?.context] | index($ctx) != null)' "$detail" >/dev/null; then
      echo "foreign collision"
    else
      echo other
    fi
    return
  fi

  if [[ "$name" == "$RO_P_FREEZE #"* ]]; then
    kind=freeze; nonce=${name#"$RO_P_FREEZE #"}
  elif [[ "$name" == "$RO_P_MIRROR #"* ]]; then
    kind=mirror; nonce=${name#"$RO_P_MIRROR #"}
    if [[ "$nonce" =~ ^[0-9a-f]{8}\.[0-9]+$ ]]; then src=${nonce#*.}; nonce=${nonce%%.*}; fi
  elif [[ "$name" == "$RO_P_FENCE #"* ]]; then
    kind=fence; nonce=${name#"$RO_P_FENCE #"}
  elif [[ "$name" == "$RO_P_ACTOR #"* ]]; then
    kind=actor; nonce=${name#"$RO_P_ACTOR #"}
  else
    kind=pin; nonce=${name#"$RO_P_PIN #"}
  fi
  if ! [[ "$nonce" =~ ^[0-9a-f]{8}$ ]] || { [ "$kind" = mirror ] && [ -z "$src" ]; }; then
    echo "foreign bad-name"
    return
  fi

  # the intent record: whole line, right kind, this nonce, written by the admin member
  case $kind in freeze | mirror) want=freeze ;; pin | fence | actor) want=merge-fence ;; esac
  local iline
  iline=$(jq -r --arg a "$admin" --arg line "^${want}-intent v1 nonce=${nonce}( |\$)" '
      [.[]? | select(.author_type == "member" and .author_id == $a) | (.content // "") | split("\n")[] | select(test($line))] | first // empty' "$comments" 2>/dev/null)
  if [ -z "$iline" ]; then
    echo "foreign no-intent"
    return
  fi

  # A merge-fence intent names the exact refs and the admin it binds. The ruleset must carry exactly
  # those values; a caller may also pin them (RO_ADMIN_ID, RO_BASE_REF, RO_HEAD_REF) and they must equal
  # the record's. A record without all three fields owns nothing.
  local i_base="" i_head="" i_admin=""
  if [ "$want" = merge-fence ]; then
    [[ " $iline " =~ \ base_ref=([^\ ]+)\  ]] && i_base=${BASH_REMATCH[1]}
    [[ " $iline " =~ \ head_ref=([^\ ]+)\  ]] && i_head=${BASH_REMATCH[1]}
    [[ " $iline " =~ \ admin=[^\ /]+/([0-9]+)\  ]] && i_admin=${BASH_REMATCH[1]}
    if [ -z "$i_base" ] || [ -z "$i_head" ] || [ -z "$i_admin" ]; then
      echo "foreign no-intent"
      return
    fi
    if { [ -n "${RO_ADMIN_ID:-}" ] && [ "$RO_ADMIN_ID" != "$i_admin" ]; } ||
      { [ -n "${RO_BASE_REF:-}" ] && [ "$RO_BASE_REF" != "$i_base" ]; } ||
      { [ -n "${RO_HEAD_REF:-}" ] && [ "$RO_HEAD_REF" != "$i_head" ]; }; then
      echo "foreign bad-shape intent differs from expected"
      return
    fi
  fi

  case $kind in mirror) mode=mirror ;; actor) mode=actor ;; *) mode=strict ;; esac
  reason=$(_ro_common_shape "$detail" "$mode")
  if [ -n "$reason" ]; then echo "foreign bad-shape $reason"; return; fi

  case $kind in
    freeze)
      inc=$(jq -cS '.conditions.ref_name.include | sort' "$detail")
      [ "$inc" = "$RO_FREEZE_INCLUDE" ] || { echo "foreign bad-shape include"; return; }
      [ "$(_ro_rules <"$detail")" = "$(_ro_freeze_rules)" ] || { echo "foreign bad-shape rules"; return; }
      echo "own freeze $nonce" ;;
    pin)
      jq -e --arg r "refs/heads/$i_head" '(.conditions.ref_name.include // []) == [$r]' "$detail" >/dev/null || { echo "foreign bad-shape include"; return; }
      [ "$(_ro_rules <"$detail")" = "$(_ro_pin_rules)" ] || { echo "foreign bad-shape rules"; return; }
      echo "own pin $nonce" ;;
    fence | actor)
      jq -e --arg r "refs/heads/$i_base" '(.conditions.ref_name.include // []) == [$r]' "$detail" >/dev/null || { echo "foreign bad-shape include"; return; }
      if [ "$kind" = actor ]; then
        jq -e --argjson id "$i_admin" '.bypass_actors[0].actor_id == $id' "$detail" >/dev/null || { echo "foreign bad-shape bypass_actors"; return; }
      fi
      if [ "$kind" = fence ]; then
        [ "$(_ro_fence_view <"$detail")" = "$(_ro_fence_expected)" ] || { echo "foreign bad-shape rules"; return; }
      else
        [ "$(_ro_rules <"$detail")" = "$(jq -cnS '[{type:"update",parameters:null}]')" ] || { echo "foreign bad-shape rules"; return; }
      fi
      echo "own $kind $nonce" ;;
    mirror)
      case ",$sources," in *",$src,"*) ;; *) echo "foreign unknown-source $src"; return ;; esac
      local sd="${RO_DETAIL_DIR:?RO_DETAIL_DIR is not set}/$src.json"
      [ -f "$sd" ] || { echo "foreign unknown-source $src"; return; }
      inc=$(jq -cS '.conditions.ref_name.include | sort' "$detail")
      [ "$inc" = "$RO_MIRROR_INCLUDE" ] || { echo "foreign bad-shape include"; return; }
      [ "$(jq -cS '.enforcement' "$detail")" = "$(jq -cS '.enforcement' "$sd")" ] || { echo "foreign bad-shape enforcement"; return; }
      [ "$(jq -cS '.bypass_actors' "$detail")" = "$(jq -cS '.bypass_actors' "$sd")" ] || { echo "foreign bad-shape bypass_actors"; return; }
      [ "$(_ro_rules <"$detail")" = "$(_ro_rules <"$sd")" ] || { echo "foreign bad-shape rules"; return; }
      echo "own mirror $nonce source=$src" ;;
  esac
}
