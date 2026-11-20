#!/usr/bin/env node
// Cutover of the doop upstream watch from the old route (autopilot 984cd96a, part C) to the new
// one (CHE-7207 plan r9, "Cutover: one writer at every moment"; step S1d).
//
//   node cutover.mjs --state | --start | --resume | --rollback | --release-waiting --s1b <S1b key>
//
// One writer at every moment. The script keeps no local file: the direction lives in the ledger's
// metadata `cutover_intent`, the state is read from the platform at the start of every run, and each
// write is read back before the next step. It stops at the first failure and prints one JSON line:
//   { mode, state_before, state, stop?: { step, next: 'wait' | 'blocked', reason, ... }, alerts, steps }
// A stop exits 1. The S1b agent reads `stop.next`: `blocked` means set S1b `blocked` with the reason.
// This script never writes an issue status.
//
// Env (tests): MULTICA_CLI_PATH (the CLI), CUTOVER_ADMIT (admit.mjs), CUTOVER_GIT (git),
// CUTOVER_NOW (ISO time of the local clock; used only for the 3 h and 504 h windows, never for T).
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decide, parseChild } from './decide.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const sha = (s) => createHash('sha256').update(s).digest('hex')
const BEFORE = readFileSync(join(HERE, 'legacy-before.md'), 'utf8')
const AFTER = readFileSync(join(HERE, 'legacy-after.md'), 'utf8')
const BEFORE_SHA = sha(BEFORE)
const AFTER_SHA = sha(AFTER)

const LEGACY = '984cd96a-6c54-4802-90d1-c560d8df16a6'
const OLD_TITLE = 'Upstream release watch: sub2api, doop, hindsight-api'
const RETIRED_TITLE = 'Upstream release watch: sub2api, hindsight-api'
const NEW_TITLE = 'Upstream release watch: doop'
const LEDGER_TITLE = 'chore(doop): upstream sync ledger (CHE-7207)'
const PROJECT_DOOP = 'a8809cf1-12d8-4e75-82ce-f398d6004e24'
const AGENT = 'x99-claude-sonnet'
const CRON = '30 4,10,16,22 * * *'
const TZ = 'Asia/Ho_Chi_Minh'
const KEY_7205 = 'CHE-7205'
const SHA_7205 = '9a4fb9ec442a982772b752004761eda3aca2633d'
const TAG_URL = 'https://github.com/kgoedecke/doop.git'
const SHA40 = /^[0-9a-f]{40}$/
const RESUME = 'resume wake: run cutover.mjs --resume'
const RELEASE = 'release wake: run cutover.mjs --release-waiting'
const EVENTS = 'task.completed,task.failed,task.cancelled'
const H = 3600_000
const WIN_RUN = 3 * H // a stop waiting on a task
const WIN_HOLD = 504 * H // a rollback holding for a claimed predecessor

const CLI = process.env.MULTICA_CLI_PATH
const ADMIT = process.env.CUTOVER_ADMIT ?? join(HERE, 'admit.mjs')
const GIT = process.env.CUTOVER_GIT ?? 'git'
const NOW = process.env.CUTOVER_NOW ?? new Date().toISOString()

/* ---- platform access: every call goes through the CLI, every error names the call ---- */
function exec(bin, args) {
  try {
    return execFileSync(bin, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (e) {
    const call = [bin.split('/').pop(), ...args].join(' ').slice(0, 160)
    throw new Error(`${call}: ${String(e.stderr || e.message).trim()}`, { cause: e })
  }
}
const cli = (...a) => {
  const out = exec(CLI, [...a, '--output', 'json'])
  return out.trim() ? JSON.parse(out) : null
}
const list = (r, key) => r?.[key] ?? (Array.isArray(r) ? r : [])

class Stop extends Error {
  constructor(step, next, reason, more = {}) {
    super(reason)
    this.info = { step, next, reason, ...more }
  }
}
/** Run `fn`; any CLI or readback error becomes a stop at `step`. */
const at = (step, fn) => {
  try {
    return fn()
  } catch (e) {
    throw e instanceof Stop ? e : new Stop(step, 'blocked', e.message)
  }
}

/* ---- run context ---- */
let S1B = null // the S1b issue the wakeups hang on
let L = null // the ledger issue, refreshed after each write to it
const steps = []
const alerts = []
const done = (step, detail) => steps.push({ step, detail })

/* ---- reads ---- */
const apGet = (id) => {
  const r = cli('autopilot', 'get', id)
  const a = r.autopilot ?? r
  return { ...a, triggers: r.triggers ?? a.triggers ?? [] }
}
const hasTrigger = (a) => a.triggers.some((t) => (t.cron ?? t.cron_expression) === CRON && t.enabled !== false)
function newAp() {
  const hit = list(cli('autopilot', 'list'), 'autopilots').find((a) => a.title === NEW_TITLE)
  return hit ? apGet(hit.id) : null
}
function findLedger() {
  const hits = list(cli('issue', 'search', LEDGER_TITLE, '--include-closed', '--limit', '50'), 'issues')
    .filter((i) => i.title === LEDGER_TITLE)
    .sort((a, b) => a.number - b.number)
  return hits[0] ? cli('issue', 'get', hits[0].id) : null
}
// `issue children` lists staged children under `stages` and the rest flat under `unstaged`; sync children have no stage
const kids = () => {
  const r = cli('issue', 'children', L.id)
  return [...list(r, 'stages').flatMap((s) => s.issues ?? []), ...list(r, 'unstaged')]
}
const TERMINAL = new Set(['completed', 'failed', 'cancelled'])
/** The whole run history, paged until an empty page. A status outside TERMINAL counts as in flight. */
function runsOf(apId) {
  const all = []
  for (let off = 0, n = 0; n < 200; off += 50, n++) {
    const page = list(cli('autopilot', 'runs', apId, '--limit', '50', '--offset', String(off)), 'runs')
    if (!page.length) break
    all.push(...page)
  }
  return all
}
const brief = (r) => ({ id: r.id, status: r.status, task_id: r.task_id })
const show = (a) =>
  a && { title: a.title, status: a.status, sha256: sha(a.description ?? ''), updated_at: a.updated_at }

function live() {
  const ledger = findLedger()
  const raw = ledger?.metadata?.cutover_intent
  const intent = ['forward', 'rollback', 'rolled_back'].includes(raw) ? raw : undefined
  const legacy = apGet(LEGACY)
  const h = sha(legacy.description ?? '')
  const np = newAp()
  const active = np?.status === 'active'
  let state
  if (h !== BEFORE_SHA && h !== AFTER_SHA) state = 'UNKNOWN'
  else if (intent === 'rollback') state = 'ROLLBACK'
  else if (h === BEFORE_SHA && active) state = 'SPLIT'
  else if (h === BEFORE_SHA) state = intent === 'forward' ? 'STARTED' : 'FRESH'
  else if (intent === 'forward') state = active && hasTrigger(np) ? 'DONE' : 'RETIRED'
  else state = 'ORPHAN'
  return { state, ledger, intent, legacy, np, T: legacy.updated_at }
}
const snapshot = () => {
  try {
    const s = live()
    return { state: s.state, intent: s.intent, legacy: show(s.legacy), new: show(s.np) }
  } catch (e) {
    return { error: e.message }
  }
}

/* ---- writes, each read back ---- */
function writeMeta(key, value, id = L.id) {
  cli('issue', 'metadata', 'set', id, '--key', key, '--value', value, '--type', 'string')
  const back = cli('issue', 'get', id)
  if (back.metadata?.[key] !== value) throw new Error(`readback ${id} ${key}: ${back.metadata?.[key]} != ${value}`)
  if (id === L?.id) L = back
}
const clearMarkers = () => {
  for (const k of ['cutover_stopped_at', 'cutover_hold_renewed']) {
    if (L.metadata?.[k] && L.metadata[k] !== 'none') writeMeta(k, 'none')
  }
}

/* ---- stop, wait, wakeups ---- */
const parseStopped = (v) => {
  const [iso, step] = String(v ?? '').split(' ')
  return Number.isNaN(Date.parse(iso)) ? null : { at: Date.parse(iso), step }
}
function mkWake(w) {
  if (!S1B) throw new Error('--s1b is required to register a wakeup')
  const base = ['issue', 'wakeup', 'create', S1B]
  let r
  if (w.release) {
    r = cli(
      ...base,
      '--until-issue',
      w.release.id,
      '--until-issue-state',
      'ended',
      '--expires-in',
      '504h',
      '--on-timeout',
      'wake',
      '--instruction',
      RELEASE,
    )
  } else {
    try {
      if (!w.task.task_id) throw new Error('run has no task id')
      r = cli(
        ...base,
        '--event',
        EVENTS,
        '--task-id',
        w.task.task_id,
        '--expires-in',
        '3h',
        '--on-timeout',
        'wake',
        '--instruction',
        RESUME,
      )
    } catch {
      // the CLI refused a task with no issue: one `at` wakeup at the run's start + 90 min (the longest legacy run took 79 min)
      const when = new Date(Date.parse(w.task.created_at) + 90 * 60_000).toISOString()
      r = cli(...base, '--kind', 'at', '--at', when, '--instruction', RESUME)
    }
  }
  const id = r?.id ?? r?.wakeup?.id
  if (!id) throw new Error('wakeup create returned no id')
  cli('issue', 'wakeup', 'get', S1B, id)
}
/** Registers and reads back every wake, then writes the stop marker. A failure is a blocked stop with no marker, so a later run retries. */
function register(step, wakes) {
  try {
    for (const w of wakes) mkWake(w)
    writeMeta('cutover_stopped_at', `${NOW} ${step}`)
  } catch (e) {
    throw new Stop(step, 'blocked', `wake registration failed: ${e.message}`)
  }
}
/**
 * A wait stop. The first stop at `step` writes its time and registers `wakes`; a later run at the same
 * step writes nothing. Returns 'expired' once `ms` have passed since that stop; otherwise throws the wait.
 */
function hold(step, ms, wakes, detail) {
  const rec = parseStopped(L?.metadata?.cutover_stopped_at)
  if (rec?.step === step) {
    if (Date.parse(NOW) - rec.at >= ms) return 'expired'
  } else register(step, wakes)
  throw new Stop(step, 'wait', detail.reason, detail)
}
const inflightDetail = (n, runs) => ({ reason: `${n} run(s) in flight`, runs: runs.map(brief) })

/* ---- forward steps ---- */
function step1() {
  at('1', () => {
    if (!L) {
      const c = cli(
        'issue',
        'create',
        '--title',
        LEDGER_TITLE,
        '--project',
        PROJECT_DOOP,
        '--status',
        'backlog',
        '--assignee',
        AGENT,
        '--property',
        'Readiness=parked',
        '--description',
        'Index only. On any wake, end with a check-in.',
      )
      L = cli('issue', 'get', c.id ?? c.issue.id)
      if (L.title !== LEDGER_TITLE) throw new Error(`ledger readback: ${L.title}`)
    }
    let c = cli('issue', 'get', KEY_7205)
    if (c.parent_issue_id !== L.id) cli('issue', 'update', KEY_7205, '--parent', L.id, '--no-start')
    if (c.metadata?.upstream_sync_sha !== SHA_7205) writeMeta('upstream_sync_sha', SHA_7205, KEY_7205)
    c = cli('issue', 'get', KEY_7205)
    if (c.parent_issue_id !== L.id || c.metadata?.upstream_sync_sha !== SHA_7205)
      throw new Error('CHE-7205 adoption readback failed')
    clearMarkers() // a stale stop from an earlier cutover must not count against this one
    writeMeta('cutover_intent', 'forward')
  })
  done('1', `ledger ${L.identifier}, ${KEY_7205} adopted, intent forward`)
}

function step2() {
  const inflight = at('2', () => runsOf(LEGACY).filter((r) => !TERMINAL.has(r.status)))
  if (inflight.length) {
    const d = inflightDetail(inflight.length, inflight)
    if (
      hold(
        '2',
        WIN_RUN,
        inflight.map((task) => ({ task })),
        d,
      ) === 'expired'
    ) {
      throw new Stop(
        '2',
        'blocked',
        `${inflight.length} legacy run(s) still in flight after 3 h; the old route keeps running`,
        d,
      )
    }
  }
  done('2', 'no legacy run in flight')
}

function step3() {
  const back = at('3', () => {
    const cur = apGet(LEGACY)
    if (sha(cur.description ?? '') !== BEFORE_SHA) throw new Error('legacy description is not the before-text')
    try {
      cli(
        'autopilot',
        'update',
        LEGACY,
        '--title',
        RETIRED_TITLE,
        '--description',
        AFTER,
        '--if-description-sha256',
        BEFORE_SHA,
      )
    } catch (e) {
      throw new Stop('3', 'blocked', e.message, { readback: show(apGet(LEGACY)) })
    }
    const b = apGet(LEGACY)
    if (sha(b.description ?? '') !== AFTER_SHA || b.title !== RETIRED_TITLE) {
      throw new Stop('3', 'blocked', 'readback is not the after-text', { readback: show(b) })
    }
    return b
  })
  done('3', `legacy retired at ${back.updated_at}`)
  return back.updated_at // T: the server's own clock (answers L1)
}

/** Every legacy run created at or before T must be terminal. */
function step4(T) {
  const inflight = at('4', () =>
    runsOf(LEGACY).filter((r) => !(Date.parse(r.created_at) > Date.parse(T)) && !TERMINAL.has(r.status)),
  )
  if (inflight.length) {
    const d = inflightDetail(inflight.length, inflight)
    if (
      hold(
        '4',
        WIN_RUN,
        inflight.map((task) => ({ task })),
        d,
      ) === 'expired'
    ) {
      rollbackFlow()
      throw new Stop('4', 'blocked', 'legacy run still in flight after 3 h; rolled back', d)
    }
  }
  done('4', `no legacy run in flight up to ${T}`)
}

function tagCommit(version) {
  const ref = `refs/tags/v${version}`
  const lines = exec(GIT, ['ls-remote', TAG_URL, ref, `${ref}^{}`])
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => l.split(/\s+/))
  const hit = lines.find(([, r]) => r?.endsWith('^{}')) ?? lines[0]
  if (!hit || !SHA40.test(hit[0])) throw new Error(`no commit for tag v${version}`)
  return hit[0]
}
function step5() {
  const found = at('5', () =>
    list(cli('issue', 'search', 'merge upstream doop', '--limit', '100'), 'issues')
      .filter((i) => /merge upstream doop/i.test(i.title))
      .map((i) => cli('issue', 'get', i.id))
      .filter((i) => i.parent_issue_id !== L.id),
  )
  const bad = found.filter((i) => !/merge upstream doop (\d+\.\d+\.\d+)/.test(i.title))
  if (bad.length) {
    for (const i of bad)
      alerts.push({ code: 'unparseable', key: i.identifier, detail: `no version in title: ${i.title}` })
    throw new Stop('5', 'blocked', `unparseable legacy sync issue: ${bad.map((i) => i.identifier).join(', ')}`)
  }
  at('5', () => {
    for (const i of found) {
      const commit = tagCommit(/merge upstream doop (\d+\.\d+\.\d+)/.exec(i.title)[1])
      if (i.metadata?.upstream_sync_sha !== commit) writeMeta('upstream_sync_sha', commit, i.id)
      cli('issue', 'update', i.identifier, '--parent', L.id, '--no-start')
      const back = cli('issue', 'get', i.id)
      if (back.parent_issue_id !== L.id || back.metadata?.upstream_sync_sha !== commit)
        throw new Error(`adoption readback failed: ${i.identifier}`)
    }
  })
  done('5', `adopted ${found.map((i) => i.identifier).join(', ') || 'nothing'}`)
}

const lastJson = (out) => {
  try {
    return JSON.parse(out.trim().split('\n').pop())
  } catch {
    return { raw: out.trim().slice(0, 500) }
  }
}
function admit(step, args) {
  const out = at(step, () => lastJson(exec(process.execPath, [ADMIT, ...args, '--ledger', L.id])))
  done(step, out)
}

function step8() {
  at('8', () => {
    let ap = newAp()
    if (!ap) {
      const text = [
        'Upstream release watch for kgoedecke/doop (CHE-7207).',
        '1. `git fetch origin cheese/main`.',
        `2. Run \`node scripts/upstream-watch/admit.mjs --ledger ${L.id}\`.`,
        `3. Post the action list as a comment on the ledger ${L.identifier}.`,
        'Failures: a failed step ends the run with one comment `WATCH FAILED: doop` naming the step and the error. Never retry in the same run.',
      ].join('\n')
      const r = cli(
        'autopilot',
        'create',
        '--title',
        NEW_TITLE,
        '--description',
        text,
        '--agent',
        AGENT,
        '--project',
        PROJECT_DOOP,
        '--mode',
        'run_only',
      )
      ap = apGet(r.autopilot?.id ?? r.id)
    } else if (ap.status !== 'active') {
      cli('autopilot', 'update', ap.id, '--status', 'active')
    }
    if (!hasTrigger(ap)) cli('autopilot', 'trigger-add', ap.id, '--cron', CRON, '--timezone', TZ)
    const back = apGet(ap.id)
    if (back.status !== 'active' || !hasTrigger(back))
      throw new Error(`new autopilot readback: ${JSON.stringify(show(back))}`)
  })
  done('8', 'new autopilot active with its trigger')
}

/** From `from` (2 or 4): the steps up to the new writer. A failure after retirement rolls back at once. */
function forward(from, T) {
  if (from <= 2) step2()
  if (from <= 3) T = step3()
  step4(T)
  try {
    step5()
    admit('6', ['--dry-run'])
    admit('7', [])
    step8()
  } catch (e) {
    const info = e instanceof Stop ? e.info : { step: '?', next: 'blocked', reason: e.message }
    try {
      rollbackFlow()
    } catch (r) {
      if (r instanceof Stop) r.info.failure = info
      throw r
    }
    throw new Stop(info.step, 'blocked', `${info.reason}; rolled back`, {
      ...info,
      rolled_back: true,
      readback: snapshot(),
    })
  }
}

/* ---- rollback ---- */
const vcmp = (a, b) => {
  const [x, y] = [a.split('.').map(Number), b.split('.').map(Number)]
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]
}
/** Promote waiting children by decision rule 5 only; never create, retarget or cancel. Returns the ones still waiting. */
function promoteWaiting() {
  for (;;) {
    const all = kids()
    const backlog = all
      .map(parseChild)
      .filter((p) => p?.status === 'backlog')
      .sort((a, b) => a.number - b.number)
    let promoted = false
    for (const b of backlog) {
      const d = decide({ tag: `v${b.version}`, commit: b.commit, inMain: false, children: all })
      if (d.alerts.length) {
        alerts.push(...d.alerts)
        throw new Stop('rollback.4', 'blocked', 'a ledger child cannot be parsed or conflicts; fix it first', {
          alerts: d.alerts,
        })
      }
      if (!d.actions.some((a) => a.type === 'promote' && a.id === b.id)) continue
      at('rollback.4', () => {
        cli('issue', 'update', b.key, '--status', 'todo', '--expected-revision', String(b.revision))
        if (cli('issue', 'get', b.id).status !== 'todo') throw new Error(`promotion readback: ${b.key} is not todo`)
      })
      done('rollback.4', `promoted ${b.key}`)
      promoted = true
      break // re-read: the promoted child is now claimed
    }
    if (!promoted) {
      const parsed = all.map(parseChild).filter(Boolean)
      return { parsed, waiting: parsed.filter((p) => p.status === 'backlog') }
    }
  }
}

function rollbackFlow() {
  if (!L) throw new Stop('rollback.1', 'blocked', 'no ledger exists to carry the intent')
  // 1. direction first; if this write fails nothing else changes
  at('rollback.1', () => L.metadata?.cutover_intent === 'rollback' || writeMeta('cutover_intent', 'rollback'))
  // 2. the new writer off before the old one comes on
  at('rollback.2', () => {
    const np = newAp()
    if (np && np.status !== 'paused') {
      cli('autopilot', 'update', np.id, '--status', 'paused')
      if (apGet(np.id).status !== 'paused') throw new Error('new autopilot readback is not paused')
    }
  })
  // 3. drain the new route
  const np = at('rollback.3', newAp)
  const inflight = np ? at('rollback.3', () => runsOf(np.id).filter((r) => !TERMINAL.has(r.status))) : []
  if (inflight.length) {
    const d = inflightDetail(inflight.length, inflight)
    if (
      hold(
        'rollback.3',
        WIN_RUN,
        inflight.map((task) => ({ task })),
        d,
      ) === 'expired'
    ) {
      throw new Stop('rollback.3', 'blocked', 'new-route run still in flight after 3 h; intent stays rollback', d)
    }
  }
  // 4. hand off waiting children before the old route returns (its moving rule would start them)
  const { parsed, waiting } = promoteWaiting()
  if (waiting.length) {
    const claimed = [
      ...new Map(
        waiting
          .flatMap((w) => parsed.filter((p) => p.claimed && vcmp(p.version, w.version) <= 0))
          .map((p) => [p.id, p]),
      ).values(),
    ]
    const detail = {
      reason: `waiting for ${claimed.map((c) => c.key).join(', ') || 'a claimed predecessor'}`,
      claimed: claimed.map((c) => c.key),
      waiting: waiting.map((w) => w.key),
    }
    if (!claimed.length)
      throw new Stop(
        'rollback.4',
        'blocked',
        `${waiting.map((w) => w.key).join(', ')} stays in backlog with no claimed predecessor to wait for`,
        detail,
      )
    const wakes = claimed.map((c) => ({ release: c }))
    if (hold('rollback.4', WIN_HOLD, wakes, detail) === 'expired') {
      if (L.metadata?.cutover_hold_renewed === 'true') {
        throw new Stop(
          'rollback.4',
          'blocked',
          `still held after 2 x 504 h by ${detail.claimed.join(', ')} for ${detail.waiting.join(', ')}`,
          detail,
        )
      }
      register('rollback.4', wakes)
      at('rollback.4', () => writeMeta('cutover_hold_renewed', 'true'))
      throw new Stop('rollback.4', 'wait', `${detail.reason} (renewed once)`, {
        ...detail,
        renewed: true,
      })
    }
  }
  // 5. restore the old route, only now
  at('rollback.5', () => {
    const cur = apGet(LEGACY)
    const h = sha(cur.description ?? '')
    if (h === BEFORE_SHA) return
    if (h !== AFTER_SHA)
      throw new Stop('rollback.5', 'blocked', 'legacy description is neither text', { readback: show(cur) })
    if (kids().some((k) => k.status === 'backlog')) throw new Error('a ledger child is still in backlog')
    cli(
      'autopilot',
      'update',
      LEGACY,
      '--title',
      OLD_TITLE,
      '--description',
      BEFORE,
      '--if-description-sha256',
      AFTER_SHA,
    )
    const b = apGet(LEGACY)
    if (sha(b.description ?? '') !== BEFORE_SHA || b.title !== OLD_TITLE)
      throw new Error('readback is not the before-text')
  })
  // 6. last
  at('rollback.6', () => {
    clearMarkers()
    writeMeta('cutover_intent', 'rolled_back')
  })
  done('rollback.6', 'old route restored, intent rolled_back')
}

/* ---- entry points ---- */
function dispatch(mode, st) {
  const { state } = st
  if (mode === '--state') return
  if (state === 'UNKNOWN') {
    throw new Stop(
      'state',
      'blocked',
      'legacy description matches neither the before-file nor the after-file; a follow-up PR refreshes them',
      { readback: show(st.legacy) },
    )
  }
  if (mode === '--start') {
    if (state === 'FRESH') {
      step1()
      return forward(2)
    }
    if (state === 'DONE') return
    throw new Stop('state', 'blocked', `state is ${state}: --start only begins from FRESH; run --resume`)
  }
  if (mode === '--release-waiting' && state !== 'ROLLBACK') {
    if (L) promoteWaiting()
    return
  }
  if (mode === '--rollback') return state === 'FRESH' ? undefined : rollbackFlow()
  switch (state) {
    case 'STARTED':
      return forward(2)
    case 'RETIRED':
      return forward(4, st.T)
    case 'ROLLBACK':
    case 'SPLIT':
    case 'ORPHAN':
      return rollbackFlow()
    default: // FRESH, DONE
  }
}

const MODES = ['--state', '--start', '--resume', '--rollback', '--release-waiting']
const argv = process.argv.slice(2)
const mode = MODES.find((m) => argv.includes(m))
if (!mode || !CLI) {
  process.stderr.write(`usage: MULTICA_CLI_PATH=... node cutover.mjs ${MODES.join(' | ')} [--s1b <S1b key>]\n`)
  process.exit(2)
}
S1B = argv.includes('--s1b') ? argv[argv.indexOf('--s1b') + 1] : null

const out = { mode, state_before: null, state: null }
try {
  const st = live()
  L = st.ledger
  out.state_before = st.state
  if (mode === '--state') out.detail = { intent: st.intent, legacy: show(st.legacy), new: show(st.np) }
  dispatch(mode, st)
} catch (e) {
  out.stop = e instanceof Stop ? e.info : { step: 'error', next: 'blocked', reason: e.message }
}
try {
  out.state = live().state
} catch (e) {
  out.state = `unread: ${e.message}`
}
out.alerts = alerts
out.steps = steps
process.stdout.write(JSON.stringify(out) + '\n')
process.exitCode = out.stop ? 1 : 0
