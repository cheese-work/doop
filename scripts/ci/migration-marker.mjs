// Log marker formats for the migration checks (CHE-7207 S2a). One place for the writer and the parser so
// `migration-base.mjs` (S2, S3b), the replay test (S3b) and `merge-proof.mjs` cannot drift apart.
//
//   migration-base event=<e> candidate=<sha> base=<sha> merged_head=<sha|-> pr_head=<sha|-> run_attempt=<n>
//   migration-replay OK candidate=<sha> base=<sha> pr_head=<sha|-> run_attempt=<n>
//
// Parsers scan a whole job log: GitHub prefixes each line with a timestamp, so a marker may start mid-line.
// A line that does not match the full pattern (a `FAIL` line, a truncated marker) is not a marker.

const SHA = '[0-9a-f]{40}'
const END = '(?=\\s|$)'

const BASE = new RegExp(
  `migration-base event=(\\S+) candidate=(${SHA}) base=(${SHA}) merged_head=(${SHA}|-) pr_head=(${SHA}|-) run_attempt=(\\d+)${END}`,
  'g',
)
const REPLAY = new RegExp(
  `migration-replay OK candidate=(${SHA}) base=(${SHA}) pr_head=(${SHA}|-) run_attempt=(\\d+)${END}`,
  'g',
)

export const formatBaseMarker = ({ event, candidate, base, mergedHead, prHead, runAttempt }) =>
  `migration-base event=${event} candidate=${candidate} base=${base} merged_head=${mergedHead} pr_head=${prHead} run_attempt=${runAttempt}`

export const formatReplayMarker = ({ candidate, base, prHead, runAttempt }) =>
  `migration-replay OK candidate=${candidate} base=${base} pr_head=${prHead} run_attempt=${runAttempt}`

export const parseBaseMarkers = (log) =>
  [...String(log).matchAll(BASE)].map(([, event, candidate, base, mergedHead, prHead, runAttempt]) => ({
    event,
    candidate,
    base,
    mergedHead,
    prHead,
    runAttempt,
  }))

export const parseReplayMarkers = (log) =>
  [...String(log).matchAll(REPLAY)].map(([, candidate, base, prHead, runAttempt]) => ({
    candidate,
    base,
    prHead,
    runAttempt,
  }))
