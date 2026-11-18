// Upstream-watch decision table (CHE-7207 plan r9, "Admission: the ledger and the watch").
// Pure: JSON in, JSON out, Node standard library only. It never reads or writes the
// platform; admit.mjs turns the returned actions into CLI calls.
//
// input:  { tag: 'v0.16.0', commit, inMain, children: [issue], lookupError }
//         `children` are the ledger's children as `multica issue children` prints them.
// output: { alerts: [{ code, key?, detail }], actions: [...] }
//   actions: promote | cancel_duplicate | create | retarget (shapes below)

import { pathToFileURL } from 'node:url'

const NEW_TITLE = /^task\(doop\): merge upstream doop (\d+\.\d+\.\d+) into cheese\/main$/
const LEGACY_TITLE = /^task\(doop\): merge upstream doop (\d+\.\d+\.\d+) into cheese\/main and redeploy on C00$/
const NEW_FIRST_LINE = /^Upstream: kgoedecke\/doop v(\d+\.\d+\.\d+) commit ([0-9a-f]{40})$/
const SHA40 = /^[0-9a-f]{40}$/
const TERMINAL = new Set(['done', 'cancelled'])

const semver = (v) => v.split('.').map(Number)
const cmp = (a, b) => {
  const [x, y] = [semver(a), semver(b)]
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]
}

/** Parse one ledger child; null = unparseable (no new or legacy match, or no commit). */
export function parseChild(issue) {
  const title = issue?.title ?? ''
  let version, commit, form
  const first = String(issue?.description ?? '').split('\n', 1)[0]
  if (LEGACY_TITLE.test(title)) {
    // CHE-7205 only: the commit lives in metadata, set by S1b's adoption write.
    form = 'legacy'
    version = LEGACY_TITLE.exec(title)[1]
    commit = issue.metadata?.upstream_sync_sha
  } else if (NEW_TITLE.test(title)) {
    form = 'new'
    const m = NEW_FIRST_LINE.exec(first)
    if (!m || m[1] !== NEW_TITLE.exec(title)[1]) return null
    version = m[1]
    commit = m[2]
  } else return null
  if (typeof commit !== 'string' || !SHA40.test(commit)) return null
  const status = issue.status
  return {
    issue,
    id: issue.id,
    key: issue.identifier,
    number: issue.number,
    revision: issue.revision,
    status,
    version,
    commit,
    form,
    live: !TERMINAL.has(status),
    claimed: status !== 'backlog' && !TERMINAL.has(status),
  }
}

export function decide({ tag, commit, inMain, children = [], lookupError = null }) {
  const alerts = []
  const actions = []
  const alert = (code, key, detail) => alerts.push({ code, ...(key ? { key } : {}), detail })

  // 1. lookup error or unparseable child: alert only (fails closed, zero writes)
  if (lookupError) {
    alert('lookup-error', null, String(lookupError))
    return { alerts, actions }
  }
  const parsed = []
  for (const c of children) {
    const p = parseChild(c)
    if (p) parsed.push(p)
    else alert('unparseable', c?.identifier, `no new or legacy match, or no commit: ${c?.title}`)
  }
  if (alerts.length) return { alerts, actions }

  const version = tag.replace(/^v/, '')
  const live = parsed.filter((p) => p.live).sort((a, b) => a.number - b.number)

  // 2. tag moved: a live child for T records another commit
  const liveT = live.filter((p) => p.version === version)
  const moved = liveT.find((p) => p.commit !== commit)
  if (moved) alert('tag-moved', moved.key, `${tag} is ${commit}, child records ${moved.commit}`)

  // 3. duplicates: per version keep the lowest number; cancel the other backlog ones
  const keep = new Map()
  for (const p of live) {
    if (p.version === version && moved) continue // "no action for T"
    const first = keep.get(p.version)
    if (!first) keep.set(p.version, p)
    else if (p.claimed) alert('claimed-duplicate', p.key, `duplicate of ${first.key}`)
    else actions.push({ type: 'cancel_duplicate', id: p.id, key: p.key, duplicateOf: first.key })
  }
  if (moved) return { alerts, actions }

  // 4. C is in cheese/main
  if (inMain) return { alerts, actions }

  const claimedOlder = live.filter((p) => p.claimed && cmp(p.version, version) < 0)
  const survivor = keep.get(version)

  // 5. a live child for T
  if (survivor) {
    const claimedForT = liveT.some((p) => p.claimed)
    if (survivor.status === 'backlog' && !claimedForT && !claimedOlder.length) {
      actions.push({ type: 'promote', id: survivor.id, key: survivor.key, revision: survivor.revision })
    }
    return { alerts, actions }
  }

  // 6. no live child for T
  for (const p of parsed) {
    // done, or cancelled other than as a duplicate (cancel-as-duplicate sets duplicate_of)
    if (p.version === version && !p.live && !(p.status === 'cancelled' && p.issue.duplicate_of)) {
      alert('terminal-without-merge', p.key, `${p.status}, but ${commit} is not in cheese/main`)
      break // one alert
    }
  }
  const target = { version, tag, commit }
  if (claimedOlder.length) {
    // latest predecessor; lowest number on a tie
    const S = claimedOlder.sort((a, b) => cmp(b.version, a.version) || a.number - b.number)[0]
    const older = live.find((p) => !p.claimed && cmp(p.version, version) < 0)
    if (older) actions.push({ type: 'retarget', id: older.id, key: older.key, ...target, waitsFor: S.key })
    else actions.push({ type: 'create', ...target, waitsFor: S.key, promote: false })
  } else {
    // admit.mjs creates in backlog, lists again, dedupes, and promotes the survivor
    actions.push({ type: 'create', ...target, waitsFor: null, promote: true })
  }
  return { alerts, actions }
}

// CLI: JSON on stdin -> JSON on stdout
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let raw = ''
  for await (const chunk of process.stdin) raw += chunk
  process.stdout.write(JSON.stringify(decide(JSON.parse(raw))) + '\n')
}
