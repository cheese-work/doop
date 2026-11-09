// Decides whether this image.yml run may deploy to C00 (CHE-4585). Called by the
// `gate` job; the verdict goes to $GITHUB_OUTPUT, the deploy job reads only that.
//
// Order is deliberate and every error path fails closed:
//   1. who merged cheese/main (or who dispatched) must be on the allowlist;
//   2. MAIN_RED_PAUSED stops merge-triggered deploys;
//   3. a failed deploy suspends auto-deploy until an allowlisted human dispatches one.
// `recheck` repeats the dispatch rule of step 1 and step 3 inside the deploy lock, where the
// answer can no longer change and a rerun of failed jobs cannot skip it.
// A thrown error fails the gate job, so the deploy job never starts.
import { appendFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const OWNER = 'congvc-dev'
const BRANCH = 'cheese/main'
const RUN_PAGE = 100
// A deploy finishes long after its run was created, and a rerun keeps the original creation time. The
// bound is enforced, not assumed: `recheck` refuses a run MAX_AGE or more past its creation, inside the
// deploy lock (job-level `concurrency`, so every lock and runner wait is over before the job starts), and
// the deploy job's `timeout-minutes` (30) bounds every step after it. So a deploy that touches C00 ends
// before created_at + MAX_AGE + 30 minutes, and a run created more than LAG (MAX_AGE plus a day) before
// the newest lifting success cannot finish after it. Paging stops there; it never reads more than MAX_PAGES.
const MAX_AGE = 30 * 24 * 3600 * 1000
const LAG = MAX_AGE + 24 * 3600 * 1000
const MAX_PAGES = 10
const UNKNOWN = `the last deploy result is unknown (${MAX_PAGES * RUN_PAGE} runs read, no later deploy decided it)`

const logins = (extra) =>
  new Set([OWNER, ...String(extra ?? '').split(',')].map((s) => s.trim().toLowerCase()).filter(Boolean))

async function mergerOf({ repo, sha, ghApi }) {
  const owners = await ghApi(`repos/${repo}/commits/${sha}/pulls`)
  const listed = owners.find((p) => p.merge_commit_sha === sha)
  if (!listed) return { error: `no pull request merged ${sha.slice(0, 7)}; nobody found to authorize it` }
  // The list endpoint omits merged_by; read the pull request itself.
  const pr = await ghApi(`repos/${repo}/pulls/${listed.number}`)
  if (!pr.merged_at || pr.merge_commit_sha !== sha || pr.base?.ref !== BRANCH) {
    return { error: `pull request #${listed.number} is not a merge of ${sha.slice(0, 7)} into ${BRANCH}` }
  }
  const login = pr.merged_by?.login
  if (!login) return { error: `pull request #${listed.number} has no merger; nobody found to authorize it` }
  return { login }
}

const lower = (s) => String(s ?? '').toLowerCase()

const isDeploy = (j) => j.name === 'deploy'

// A rerun keeps its run id, so its earlier attempts are only visible per attempt.
async function failedBefore({ repo, id, attempt, ghApi }) {
  for (let n = 1; n < attempt; n++) {
    const { jobs } = await ghApi(`repos/${repo}/actions/runs/${id}/attempts/${n}/jobs?per_page=100`)
    if (jobs.find(isDeploy)?.conclusion === 'failure') return true
  }
  return false
}

// The finished deploys of one run, each with when it finished. A deploy that has not finished says
// nothing yet. A success lifts a suspension only if an allowlisted login started it: attempt 1 passed
// the gate, a later attempt counts if its initiator is on the list. The initiator of an attempt that a
// newer one replaced is unknown, so its success does not lift (fail closed).
async function deploysOf({ repo, run, allowed, ghApi }) {
  const latest = run.run_attempt ?? 1
  const by = run.triggering_actor?.login
  const out = []
  const add = (job, lifts, who) => {
    const result = job?.conclusion
    if (result !== 'success' && result !== 'failure') return
    const at = Date.parse(job.completed_at)
    if (Number.isNaN(at)) throw new Error(`the deploy of run ${run.id} finished without a completion time`)
    out.push({ id: run.id, result, at, lifts: result === 'success' && lifts, who })
  }
  for (let n = 1; n < latest; n++) {
    const { jobs } = await ghApi(`repos/${repo}/actions/runs/${run.id}/attempts/${n}/jobs?per_page=100`)
    add(jobs.find(isDeploy), n === 1)
  }
  const { jobs } = await ghApi(`repos/${repo}/actions/runs/${run.id}/jobs?per_page=100`)
  add(jobs.find(isDeploy), latest === 1 || allowed.has(lower(by)), by)
  return out
}

// Deploys run one at a time under the lock but finish in their own order, not in the order GitHub
// lists the runs (creation). So the history is every finished deploy in the pages read, sorted by when it
// finished. The latest decides: a lifting success (an allowlisted login started it) clears the
// suspension, a failure suspends. A success nobody on the allowlist started is skipped, so a rerun
// is not a recovery. A failure and a success finishing at the same instant count as the failure.
async function suspendedBy({ repo, runId, attempt, trigger, allowed, ghApi }) {
  const own = Number(attempt) || 1
  if (own > 1 && !allowed.has(lower(trigger)) && (await failedBefore({ repo, id: runId, attempt: own, ghApi }))) {
    return `an earlier attempt of run ${runId} failed, and ${trigger} is not on the deploy allowlist`
  }
  const deploys = []
  const seen = new Set()
  let lifted = -Infinity // a run last updated before this cannot have finished a deploy after it
  let complete = false // true once every run that could still decide has been read
  for (let page = 1; page <= MAX_PAGES && !complete; page++) {
    const { workflow_runs: runs } = await ghApi(
      `repos/${repo}/actions/workflows/image.yml/runs?branch=${BRANCH}&per_page=${RUN_PAGE}&page=${page}`,
    )
    let oldest = Infinity
    let dated = true // a run without a creation time cannot show that older runs are out of reach
    for (const run of runs) {
      const created = Date.parse(run.created_at)
      if (Number.isNaN(created)) dated = false
      else oldest = Math.min(oldest, created)
      if (seen.has(run.id)) continue
      seen.add(run.id)
      if (String(run.id) === String(runId)) continue // this attempt's own deploy has not run yet
      if (Date.parse(run.updated_at) < lifted) continue
      for (const d of await deploysOf({ repo, run, allowed, ghApi })) {
        deploys.push(d)
        if (d.lifts) lifted = Math.max(lifted, d.at)
      }
    }
    complete = runs.length < RUN_PAGE || (dated && oldest < lifted - LAG)
  }
  deploys.sort((x, y) => x.at - y.at || (x.result === 'failure' ? 1 : 0) - (y.result === 'failure' ? 1 : 0))
  const skipped = []
  for (const d of deploys.reverse()) {
    if (d.lifts) return complete ? null : UNKNOWN
    if (d.result === 'success') {
      skipped.push(d)
      continue
    }
    const rerun = skipped.find((r) => r.id === d.id)
    return rerun
      ? `the deploy of run ${d.id} failed and ${rerun.who} reran it; a rerun is not a recovery`
      : `the deploy of run ${d.id} failed`
  }
  // Older history was not read and nothing decided: it is unknown, so stay suspended.
  return complete ? null : UNKNOWN
}

// The one dispatch rule, used by `decide` and by `recheck` so the two cannot disagree. A rerun keeps
// the original actor and GitHub reuses a passed gate, so whoever started THIS attempt decides, on
// every attempt. Returns the refusal, or null when an allowlisted login started it.
function dispatchRefusal({ actor, trigger, allowed }) {
  const who = trigger || actor
  return allowed.has(lower(who)) ? null : `${who || 'an unknown login'} is not on the deploy allowlist`
}

export async function decide({ event, ref, sha, repo, runId, attempt, actor, trigger, extra, paused, ghApi }) {
  if (ref !== `refs/heads/${BRANCH}`) throw new Error(`deploys run only from ${BRANCH}, not ${ref}`)
  const allowed = logins(extra)

  if (event === 'workflow_dispatch') {
    const refusal = dispatchRefusal({ actor, trigger, allowed })
    if (refusal) throw new Error(refusal)
    return { authorized: true, reason: `dispatched by ${trigger || actor}` }
  }
  if (event !== 'push') throw new Error(`event ${event} may not deploy`)

  const merger = await mergerOf({ repo, sha, ghApi })
  if (merger.error) return { authorized: false, reason: merger.error }
  if (!allowed.has(merger.login.toLowerCase())) {
    return {
      authorized: false,
      reason: `merged by ${merger.login}, who is not on the deploy allowlist; built and stopped`,
    }
  }
  if (String(paused ?? '') !== '') return { authorized: false, reason: `MAIN_RED_PAUSED is set: ${paused}` }

  const suspended = await suspendedBy({ repo, runId, attempt, trigger, allowed, ghApi })
  if (suspended) return { authorized: false, reason: `auto-deploy suspended: ${suspended}` }
  return { authorized: true, reason: `merged by ${merger.login}` }
}

// Plain REST, so it also runs on the C00 runner, which has node but not `gh`.
// The gate runs before the deploy job queues for the lock, and a rerun of failed jobs reuses its
// passed gate, so the deploy job judges again once it holds the lock. A dispatch is judged by the
// login that started this attempt and, if allowlisted, bypasses suspension. A push checks the
// failure history. Any other event is refused. A run MAX_AGE old is refused first (see LAG).
export async function recheck({ event, repo, runId, attempt, actor, trigger, extra, ghApi, now = Date.now() }) {
  const allowed = logins(extra)
  // The age bound comes first and covers every event: a failed dispatch deploy enters the history too.
  const created = Date.parse((await ghApi(`repos/${repo}/actions/runs/${runId}`)).created_at)
  if (Number.isNaN(created)) return { authorized: false, reason: `run ${runId} has no creation time` }
  if (now - created >= MAX_AGE) return { authorized: false, reason: `run ${runId} is older than 30 days` }
  if (event === 'workflow_dispatch') {
    const refusal = dispatchRefusal({ actor, trigger, allowed })
    return refusal
      ? { authorized: false, reason: refusal }
      : { authorized: true, reason: `dispatched by ${trigger || actor}` }
  }
  if (event !== 'push') return { authorized: false, reason: `event ${event} may not deploy` }
  const suspended = await suspendedBy({ repo, runId, attempt, trigger, allowed, ghApi })
  return suspended
    ? { authorized: false, reason: `auto-deploy suspended: ${suspended}` }
    : { authorized: true, reason: 'no failed deploy while this run waited for the lock' }
}

const gh = async (path) => {
  const res = await fetch(`${process.env.GITHUB_API_URL || 'https://api.github.com'}/${path}`, {
    headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/vnd.github+json' },
  })
  if (!res.ok) throw new Error(`GitHub ${res.status} for ${path}`)
  return res.json()
}

async function main() {
  const env = process.env
  if (process.argv[2] === 'recheck') {
    const out = await recheck({
      event: env.EVENT,
      repo: env.REPO,
      runId: env.RUN_ID,
      attempt: env.ATTEMPT,
      actor: env.ACTOR,
      trigger: env.TRIGGER,
      extra: env.EXTRA,
      ghApi: gh,
    })
    console.log(`deploy recheck: authorized=${out.authorized} (${out.reason})`)
    if (!out.authorized) throw new Error(out.reason) // the job stays failed, so the suspension holds
    return
  }
  const out = await decide({
    event: env.EVENT,
    ref: env.REF,
    sha: env.SHA,
    repo: env.REPO,
    runId: env.RUN_ID,
    attempt: env.ATTEMPT,
    actor: env.ACTOR,
    trigger: env.TRIGGER,
    extra: env.EXTRA,
    paused: env.PAUSED,
    ghApi: gh,
  })
  const reason = out.reason.replace(/[\r\n]+/g, ' ')
  console.log(`deploy gate: authorized=${out.authorized} (${reason})`)
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `authorized=${out.authorized}\nreason=${reason}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`deploy gate failed closed: ${err.message}`)
    process.exit(1)
  })
}
