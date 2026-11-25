// The audited lift (CHE-5551, train S3b, plan CHE-5474 C-10.6 and C-10.7): the only way from `suspended:*` or
// `armed:*` back to `clear:*`. It runs in `cd-lift.yml` on the C00 runner, under the host lock, and refuses unless
// ONE approved Multica decision of action type doop.deploy_lift, answered by the configured approver (Cheese), names
// the exact marker that stands now, and C00 is quiescent and healthy. Nothing is parsed from free text.
//
//   admit   the dispatcher (and the login that triggered the run) is in the allowlist
//   lift    decide on the decision, the marker and the C00 facts; read the decision and the marker again right
//           before the write; write `clear:<nonce>:<lift run id>`, read it back; record the evidence
//
// The decision read is `GET {server}/api/decisions/{id}/state` (scoped read-only token, X-Workspace-ID header):
//   decision_id, action_id, action_type, action_version, state, approver_id, answered_at, withdrawn_at, revoked_at,
//   expires_at, params { marker_value, repo }. A missing or malformed field is a refusal, never a pass.
// A refusal leaves the marker unchanged. The evidence (`lift-evidence.json`, the run summary) is written for a
// refusal too: outcome `lifted`, `refused` (nothing written) or `failed` (a write that could not be read back; the
// marker must be checked by hand).
//
// CLI: node scripts/deploy-lift.mjs admit | lift
// Env (admit): ACTOR, TRIGGER, DISPATCHERS
// Env (lift):  GH_TOKEN (marker GitHub App token), REPO, RUN_ID, LIFTER, DECISION_ID, APPROVER_ID, MULTICA_SERVER_URL,
//              MULTICA_WORKSPACE_ID, DECISION_READ_TOKEN, HEALTHZ_URL, and the C00 facts c00.sh lift proved under the
//              lock: LIFT_QUIESCENT (true), LIFT_DIGEST, LIFT_REVISION, LIFT_CONTAINER_HEALTH.
import { appendFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { ghFetch } from './gh-fetch.mjs'
import { kindOf, lift as writeLift, readMarker } from './deploy-marker.mjs'

const ACTION_TYPE = 'doop.deploy_lift'
const ACTION_VERSION = 1
const ID = /^[A-Za-z0-9][A-Za-z0-9-]{5,63}$/
const DIGEST = /^sha256:[0-9a-f]{64}$/
const SHA40 = /^[0-9a-f]{40}$/
const READ_MS = 15_000

class Refusal extends Error {}
const refuse = (why) => new Refusal(why)

export const parseList = (text) =>
  String(text ?? '')
    .split(/[\s,]+/)
    .filter(Boolean)

/** Both the actor and the login that triggered this attempt must be allowlisted (a rerun keeps the original actor). */
export function admitDispatcher({ actor, triggering, allowed }) {
  const list = parseList(allowed).map((x) => x.toLowerCase())
  for (const login of [actor, triggering]) {
    if (!login || !list.includes(String(login).toLowerCase()))
      throw new Error(`refused: dispatcher '${login ?? ''}' is not in DOOP_LIFT_DISPATCHERS`)
  }
}

const pad = (n) => String(n).padStart(2, '0')
/** `YYYY-MM-DD HH:MM:SS ICT` (UTC+7, no daylight saving). */
export function ictTime(date) {
  const d = new Date(date.getTime() + 7 * 3600_000)
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} ICT`
  )
}

/** The decision, as the API answers it. Refuses (throws) when it is missing or cannot be read; no token in any error. */
export async function readDecision({ fetchImpl = fetch, server, workspace, token, id }) {
  if (!/^https?:\/\/[^\s/]+/.test(server ?? ''))
    throw refuse('unreadable decision: the Multica server URL is not http(s)')
  if (!token) throw refuse('unreadable decision: no read token')
  if (!workspace) throw refuse('unreadable decision: no workspace id')
  if (!ID.test(id ?? '')) throw refuse('unreadable decision: the decision id is not a plain id')
  let res
  try {
    res = await fetchImpl(`${server.replace(/\/+$/, '')}/api/decisions/${id}/state`, {
      headers: { Authorization: `Bearer ${token}`, 'X-Workspace-ID': workspace, Accept: 'application/json' },
      signal: AbortSignal.timeout(READ_MS),
    })
  } catch (err) {
    throw refuse(`unreadable decision: the Multica API did not answer (${String(err?.message ?? err).split('\n')[0]})`)
  }
  if (res.status === 404) throw refuse('no such decision (404)')
  if (!res.ok) throw refuse(`unreadable decision: the Multica API answered ${res.status}`)
  let body
  try {
    body = JSON.parse(await res.text())
  } catch {
    throw refuse('unreadable decision: the answer is not JSON')
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw refuse('unreadable decision: not an object')
  return body
}

const str = (v) => typeof v === 'string' && v !== ''
const instant = (v) => (str(v) && !Number.isNaN(Date.parse(v)) ? Date.parse(v) : null)

/**
 * Why this decision does not lift this marker, or null when it does. Pure: no I/O. Every field is checked;
 * anything missing or of the wrong shape is a refusal.
 */
export function refusalFor(d, { marker, repo, approverId, now, id }) {
  if (!d || typeof d !== 'object') return 'unreadable decision'
  if (id !== undefined && d.decision_id !== id) return 'unreadable decision: it answers for another decision id'
  if (d.action_type !== ACTION_TYPE) return `wrong action type '${d.action_type}', need ${ACTION_TYPE}`
  for (const f of ['state', 'approver_id']) if (!str(d[f])) return `unreadable decision: no ${f}`
  if (!str(d.params?.marker_value) || !str(d.params?.repo))
    return 'unreadable decision: params lack marker_value or repo'
  if (d.answered_at == null || instant(d.answered_at) === null) return 'unreadable decision: no answered_at'
  // The API always sends these three, null when unset. An absent key is a malformed answer, not "unset".
  for (const f of ['withdrawn_at', 'revoked_at', 'expires_at'])
    if (!(f in d)) return `unreadable decision: no ${f} field`
  if (d.expires_at != null && instant(d.expires_at) === null) return 'unreadable decision: expires_at is not a time'
  if (Number(d.action_version) !== ACTION_VERSION)
    return `wrong action version '${d.action_version}', need ${ACTION_VERSION}`
  if (d.state !== 'approved') return `the decision is not approved (state ${d.state})`
  if (d.withdrawn_at != null) return 'the decision was withdrawn'
  if (d.revoked_at != null) return 'the decision was revoked'
  if (d.expires_at != null && instant(d.expires_at) <= now.getTime()) return 'the decision has expired'
  if (!approverId) return 'no approver id is configured (DOOP_LIFT_APPROVER_ID)'
  if (d.approver_id !== approverId) return 'the approver is not the configured approver'
  if (d.params.repo !== repo) return `the repo param '${d.params.repo}' is not ${repo}`
  if (d.params.marker_value !== marker) return 'the marker_value param is not the marker that stands now'
  return null
}

/** The marker that stands, as something a lift may replace; refuses for absent, unreadable, clear or unknown. */
async function standingMarker(ghApi, repo) {
  let marker
  try {
    marker = await readMarker(ghApi, repo)
  } catch (err) {
    throw refuse(`the marker cannot be read (${String(err?.message ?? err).split('\n')[0]})`)
  }
  if (marker === null) throw refuse('the marker is absent; there is nothing to lift')
  const kind = kindOf(marker)
  if (kind === 'clear') throw refuse('the marker is already clear; there is nothing to lift')
  if (kind === null) throw refuse('the marker is not a marker value; it is not lifted')
  return marker
}

async function checkHealth({ fetchImpl, healthzUrl, containerHealth }) {
  if (containerHealth !== 'healthy') throw refuse(`C00 health: the container is ${containerHealth || 'unknown'}`)
  let res
  try {
    res = await fetchImpl(healthzUrl, { redirect: 'manual', signal: AbortSignal.timeout(READ_MS) })
  } catch (err) {
    throw refuse(`C00 health: ${healthzUrl} did not answer (${String(err?.message ?? err).split('\n')[0]})`)
  }
  if (res.status !== 200) throw refuse(`C00 health: ${healthzUrl} answered ${res.status}, not 200`)
  return { status: 200, url: healthzUrl }
}

/**
 * Run the lift. Always returns the evidence; `outcome` is `lifted`, `refused` (nothing was written) or `failed`.
 * The caller holds the C00 lock; `facts` are what it proved under that lock.
 */
export async function lift(o) {
  const clock = o.now ?? (() => new Date())
  const started = clock()
  const ev = {
    outcome: 'refused',
    reason: '',
    lifter: o.lifter ?? '',
    decision_id: o.decisionId ?? '',
    approver_id: '',
    decision_answered_at: '',
    lift_run_id: String(o.runId ?? ''),
    repo: o.repo ?? '',
    marker_before: null,
    marker_after: null,
    health: null,
    quiescence: o.facts?.quiescent === true ? 'proven' : 'not proven',
    digest: o.facts?.digest ?? '',
    revision: o.facts?.revision ?? '',
    started_ict: ictTime(started),
    finished_ict: '',
  }
  try {
    if (!/^\d+$/.test(ev.lift_run_id)) throw refuse('the lift run id is not a number')
    if (!str(ev.lifter)) throw refuse('no lifter login')
    const read = () =>
      readDecision({
        fetchImpl: o.fetchImpl,
        server: o.server,
        workspace: o.workspace,
        token: o.token,
        id: o.decisionId,
      })
    const judge = (d, marker) =>
      refusalFor(d, { marker, repo: o.repo, approverId: o.approverId, now: clock(), id: o.decisionId })

    // 1. Decide on the decision, the marker and C00.
    const decision = await read()
    ev.approver_id = str(decision.approver_id) ? decision.approver_id : ''
    ev.decision_answered_at = str(decision.answered_at) ? decision.answered_at : ''
    const marker = await standingMarker(o.ghApi, o.repo)
    ev.marker_before = marker
    const why = judge(decision, marker)
    if (why) throw refuse(why)
    if (o.facts?.quiescent !== true) throw refuse('migration quiescence is not proven (C-8.8)')
    if (!DIGEST.test(o.facts?.digest ?? '')) throw refuse('no readable running digest')
    if (!SHA40.test(o.facts?.revision ?? '')) throw refuse('no readable revision label')
    ev.health = await checkHealth({
      fetchImpl: o.fetchImpl,
      healthzUrl: o.healthzUrl,
      containerHealth: o.facts.containerHealth,
    })

    // 2. Immediately before the write: the decision again, then the marker again, and still equal.
    const again = await read()
    const whyAgain = judge(again, await standingMarker(o.ghApi, o.repo))
    if (whyAgain) throw refuse(`changed during the lift: ${whyAgain}`)

    // 3. writeMarker reads the marker once more, writes, and reads it back.
    try {
      ev.marker_after = await writeLift({ ghApi: o.ghApi, repo: o.repo, runId: ev.lift_run_id, expected: marker })
    } catch (err) {
      const msg = String(err?.message ?? err)
      if (/nothing was written/.test(msg)) throw refuse(`the marker changed during the lift: ${msg}`)
      ev.outcome = 'failed'
      ev.reason = `the marker write failed: ${msg}; check ${o.repo} variable DOOP_DEPLOY_SUSPENDED by hand`
      return finish(ev, clock)
    }
    ev.outcome = 'lifted'
    ev.reason = ''
  } catch (err) {
    if (!(err instanceof Refusal)) ev.reason = `refused (unexpected): ${String(err?.message ?? err).split('\n')[0]}`
    else ev.reason = err.message
    ev.outcome = 'refused'
  }
  return finish(ev, clock)
}

const finish = (ev, clock) => ({ ...ev, finished_ict: ictTime(clock()) })

function summary(ev) {
  const rows = [
    ['Outcome', ev.outcome === 'lifted' ? 'lifted (marker is clear)' : `${ev.outcome}: ${ev.reason}`],
    ['Lifter', ev.lifter],
    ['Decision', ev.decision_id],
    ['Approver', ev.approver_id],
    ['Decision answered', ev.decision_answered_at],
    ['Lift run', ev.lift_run_id],
    ['Marker before', `\`${ev.marker_before ?? ''}\``],
    ['Marker after', `\`${ev.marker_after ?? ''}\``],
    ['Health', ev.health ? `${ev.health.status} from ${ev.health.url}` : 'not checked'],
    ['Migration quiescence', ev.quiescence],
    ['Running digest', ev.digest],
    ['Revision label', ev.revision],
    ['Started', ev.started_ict],
    ['Finished', ev.finished_ict],
  ]
  return `## Deploy lift\n\n| | |\n| --- | --- |\n${rows.map(([k, v]) => `| ${k} | ${String(v).replace(/\|/g, '\\|')} |`).join('\n')}\n`
}

function record(ev, env) {
  writeFileSync('lift-evidence.json', `${JSON.stringify(ev, null, 2)}\n`)
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, summary(ev))
  console.log(`deploy lift: ${ev.outcome}${ev.reason ? ` (${ev.reason})` : ''}`)
}

// ---------------------------------------------------------------------------------------------
const api =
  (token) =>
  async (path, init = {}) => {
    const res = await ghFetch(`${process.env.GITHUB_API_URL || 'https://api.github.com'}/${path}`, {
      method: init.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
    })
    if (!res.ok)
      throw Object.assign(
        new Error(
          `GitHub ${res.status} for ${init.method ?? 'GET'} ${path}${res.ghMessage ? `: ${res.ghMessage}` : ''}`,
        ),
        {
          status: res.status,
        },
      )
    const text = await res.text()
    return text ? JSON.parse(text) : {}
  }

async function cli(argv, env) {
  const [command] = argv
  if (command === 'admit') {
    admitDispatcher({ actor: env.ACTOR, triggering: env.TRIGGER, allowed: env.DISPATCHERS })
    console.log(`deploy lift: dispatcher ${env.ACTOR} admitted`)
    return 0
  }
  if (command !== 'lift') throw new Error(`unknown command '${command}'`)
  const ev = await lift({
    ghApi: api(env.GH_TOKEN ?? ''),
    fetchImpl: fetch,
    repo: env.REPO ?? '',
    runId: env.RUN_ID,
    lifter: env.LIFTER,
    decisionId: env.DECISION_ID,
    approverId: env.APPROVER_ID,
    server: env.MULTICA_SERVER_URL,
    workspace: env.MULTICA_WORKSPACE_ID,
    token: env.DECISION_READ_TOKEN,
    healthzUrl: env.HEALTHZ_URL,
    facts: {
      quiescent: env.LIFT_QUIESCENT === 'true',
      digest: env.LIFT_DIGEST,
      revision: env.LIFT_REVISION,
      containerHealth: env.LIFT_CONTAINER_HEALTH,
    },
  })
  record(ev, env)
  return ev.outcome === 'lifted' ? 0 : 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  cli(process.argv.slice(2), process.env).then(
    (code) => process.exit(code),
    (err) => {
      console.error(`deploy lift failed closed: ${err.message}`)
      process.exit(1)
    },
  )
}
