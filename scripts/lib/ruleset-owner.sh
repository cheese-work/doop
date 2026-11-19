# shellcheck shell=bash
# Ruleset ownership (CHE-7594, plan CHE-7309 P3a). Source this file; P3b, P3c and P3d reuse it.
#
#   ro_has_prefix <name>   exit 0 when the name starts with one of our ruleset prefixes
#   ro_classify <detail.json> <comments.json> <admin-member-id> <source-ids-csv>
#     prints one line:
#       own freeze <nonce>
#       own mirror <nonce> source=<id>
#       own pin <nonce>
#       foreign <reason> [detail]      reasons: bad-name no-intent unknown-source bad-shape collision
#       other                          not ours, not a collision
#
# A ruleset is ours only when all three hold: its name is `<prefix> #<8 hex>` (a mirror adds `.<source id>`),
# an intent record of the right kind for this nonce exists as a whole line of a comment by the admin member,
# and its shape equals what the script sets (only the fields the script sets are compared; fields GitHub
# adds are ignored). Anything with our prefix that fails one of these is foreign. A ruleset without our
# prefix is a collision when it names a freeze-probe or guard-rehearsal ref or requires the main-frozen
# context, unless it is one of the source rulesets. Unreadable bypass actors (null) fail closed.
#
# A mirror is compared with its source ruleset, read from "$RO_DETAIL_DIR/<source id>.json".

RO_CTX='main-frozen (CHE-7309)'
RO_P_FREEZE='freeze main (CHE-7309)'
RO_P_MIRROR='freeze probe mirror (CHE-7309)'
RO_P_PIN='port head pin (CHE-7309)'
RO_FREEZE_INCLUDE='["refs/heads/freeze-probe/d-frozen","refs/heads/freeze-probe/q-frozen","refs/heads/main"]'
RO_MIRROR_INCLUDE='["refs/heads/freeze-probe/d-frozen","refs/heads/freeze-probe/d-open","refs/heads/freeze-probe/q-frozen","refs/heads/freeze-probe/q-open"]'

ro_has_prefix() {
  case "$1" in "$RO_P_FREEZE "* | "$RO_P_MIRROR "* | "$RO_P_PIN "*) return 0 ;; esac
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

# _ro_common_shape <detail.json> <strict|mirror>: empty when target/enforcement/bypass/exclude are canonical,
# else a reason. A mirror copies enforcement and bypass actors from its source, so only the source
# comparison constrains them; null bypass actors still fail closed.
_ro_common_shape() {
  jq -r --arg mode "$2" '
    if .target != "branch" then "target"
    elif .bypass_actors == null then "bypass_actors unreadable (null)"
    elif ((.conditions.ref_name.exclude // []) != []) then "exclude not empty"
    elif $mode == "mirror" then ""
    elif .enforcement != "active" then "enforcement"
    elif .bypass_actors != [] then "bypass_actors not empty"
    else "" end' "$1"
}

ro_classify() {
  local detail=$1 comments=$2 admin=$3 sources=$4
  local name id nonce kind="" src="" want="" prefix reason inc
  name=$(jq -r '.name // ""' "$detail")
  id=$(jq -r '.id' "$detail")

  if ! ro_has_prefix "$name"; then
    case ",$sources," in *",$id,"*) echo other; return ;; esac
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
  else
    kind=pin; nonce=${name#"$RO_P_PIN #"}
  fi
  if ! [[ "$nonce" =~ ^[0-9a-f]{8}$ ]] || { [ "$kind" = mirror ] && [ -z "$src" ]; }; then
    echo "foreign bad-name"
    return
  fi

  # the intent record: whole line, right kind, this nonce, written by the admin member
  case $kind in freeze | mirror) want=freeze ;; pin) want=merge-fence ;; esac
  if ! jq -e --arg a "$admin" --arg line "^${want}-intent v1 nonce=${nonce}( |\$)" '
      any(.[]?; .author_type == "member" and .author_id == $a and ((.content // "") | split("\n") | any(test($line))))' "$comments" >/dev/null 2>&1; then
    echo "foreign no-intent"
    return
  fi

  reason=$(_ro_common_shape "$detail" "$([ "$kind" = mirror ] && echo mirror || echo strict)")
  if [ -n "$reason" ]; then echo "foreign bad-shape $reason"; return; fi

  case $kind in
    freeze)
      inc=$(jq -cS '.conditions.ref_name.include | sort' "$detail")
      [ "$inc" = "$RO_FREEZE_INCLUDE" ] || { echo "foreign bad-shape include"; return; }
      [ "$(_ro_rules <"$detail")" = "$(_ro_freeze_rules)" ] || { echo "foreign bad-shape rules"; return; }
      echo "own freeze $nonce" ;;
    pin)
      jq -e '(.conditions.ref_name.include // []) | length > 0 and all(.[]; startswith("refs/heads/"))' "$detail" >/dev/null || { echo "foreign bad-shape include"; return; }
      [ "$(_ro_rules <"$detail")" = "$(_ro_pin_rules)" ] || { echo "foreign bad-shape rules"; return; }
      echo "own pin $nonce" ;;
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
