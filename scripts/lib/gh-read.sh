# shellcheck shell=bash
# Bounded GitHub reads (CHE-7594, plan CHE-7309 P3a). Source this file; it does not run anything.
#
# Every read returns the response with GH_LO and GH_HI (epoch seconds), both GitHub server times:
#   GH_HI = the response's Date header + 1 s (1 s resolution, set when GitHub sends the response)
#   GH_LO = the Date header of the previous response in the same run
# so GitHub served the read at a time inside [GH_LO, GH_HI]. The local clock is never read.
# A response without a usable Date header is a failed read. A run starts with gh_read_init, a clock
# read of GET /rate_limit (which does not count against the limit).
#
# Results: GH_BODY (response body), GH_STATUS (HTTP status code, empty when none), GH_LO, GH_HI.
# gh_read returns 0 only for a 2xx response with a Date header. Set GH_READ_TRACE=1 to print one
# `read <label> lo=<iso> hi=<iso>` line per read on stderr. GH_BIN overrides the `gh` command.

GH_PREV_DATE=""
GH_LO="" GH_HI="" GH_BODY="" GH_STATUS="" GH_ERR=""

gh_iso() { date -u -d "@$1" '+%Y-%m-%dT%H:%M:%SZ'; }

# gh_read <gh api arguments...>: the first non-flag argument names the read in the trace
# (the path comes first); GH_LABEL=<name> gh_read ... overrides the name.
gh_read() {
  local raw hdr status date_line date_epoch label=""
  GH_BODY="" GH_STATUS="" GH_ERR=""
  for a in "$@"; do case "$a" in -*) ;; *) label="$a"; break ;; esac; done
  label=${GH_LABEL:-$label}
  raw=$("${GH_BIN:-gh}" api -i "$@" 2>/dev/null) || true
  raw=${raw//$'\r'/}
  if [[ "$raw" == *$'\n\n'* ]]; then
    hdr=${raw%%$'\n\n'*}
    GH_BODY=${raw#*$'\n\n'}
  else
    hdr=$raw
    GH_BODY=""
  fi
  status=$(printf '%s\n' "$hdr" | sed -n '1s/^HTTP\/[0-9.]* \([0-9][0-9][0-9]\).*/\1/p')
  GH_STATUS=$status
  date_line=$(printf '%s\n' "$hdr" | sed -n 's/^[Dd][Aa][Tt][Ee]:[[:space:]]*//p' | head -n 1)
  if [ -z "$date_line" ] || ! date_epoch=$(date -u -d "$date_line" +%s 2>/dev/null); then
    GH_ERR="no Date header: read of $label is a failed read"
    return 1
  fi
  GH_HI=$((date_epoch + 1))
  if [ -n "$GH_PREV_DATE" ]; then
    GH_LO=$GH_PREV_DATE
  else
    GH_LO=$date_epoch
  fi
  if [ "$GH_LO" -gt "$GH_HI" ]; then
    GH_ERR="Date went backwards on read of $label"
    return 1
  fi
  GH_PREV_DATE=$date_epoch
  [ -n "${GH_READ_TRACE:-}" ] && printf 'read %s lo=%s hi=%s\n' "$label" "$(gh_iso "$GH_LO")" "$(gh_iso "$GH_HI")" >&2
  case "$status" in
    2??) return 0 ;;
    *) GH_ERR="HTTP ${status:-?} on read of $label"; return 1 ;;
  esac
}

# gh_read_init: the clock read that starts a run.
gh_read_init() {
  GH_PREV_DATE=""
  gh_read rate_limit
}

# gh_read_list <path-with-query-ending-in-?-or-&> : read every page (per_page 100) of a JSON array.
# GH_BODY is the joined array; GH_LO is the first page's lo and GH_HI the last page's hi.
# A failed page fails the whole read.
gh_read_list() {
  local base=$1 page=1 acc='[]' lo="" n sep='?'
  [[ "$base" == *\?* ]] && sep='&'
  while :; do
    gh_read "${base}${sep}per_page=100&page=${page}" || return 1
    [ -n "$lo" ] || lo=$GH_LO
    acc=$(jq -c --argjson more "$GH_BODY" '. + $more' <<<"$acc" 2>/dev/null) || { GH_ERR="page $page of $base is not a JSON array"; return 1; }
    n=$(jq 'length' <<<"$GH_BODY" 2>/dev/null) || { GH_ERR="page $page of $base is not a JSON array"; return 1; }
    [ "$n" -lt 100 ] && break
    page=$((page + 1))
    [ "$page" -le 100 ] || { GH_ERR="more than 100 pages of $base"; return 1; }
  done
  GH_BODY=$acc
  GH_LO=$lo
}
