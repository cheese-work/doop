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

// A rerun keeps its run id, so its earlier attempts are only visible per attempt.
async function failedBefore({ repo, id, attempt, ghApi }) {
  for (let n = 1; n < attempt; n++) {
    const { jobs } = await ghApi(`repos/${repo}/actions/runs/${id}/attempts/${n}/jobs?per_page=100`)
    if (jobs.find((j) => j.name === 'deploy')?.conclusion === 'failure') return true
  }
  return false
}

// Newest first. The newest run whose deploy job finished decides: failure suspends.
// A rerun is not a recovery: an earlier failed attempt keeps counting as a failure, unless an
// allowlisted login started the rerun. Only a successful deploy that someone on the allowlist
// started lifts a suspension.
async function suspendedBy({ repo, runId, attempt, trigger, allowed, ghApi }) {
  const own = Number(attempt) || 1
  if (own > 1 && !allowed.has(lower(trigger)) && (await failedBefore({ repo, id: runId, attempt: own, ghApi }))) {
    return `an earlier attempt of run ${runId} failed, and ${trigger} is not on the deploy allowlist`
  }
  const { workflow_runs: runs } = await ghApi(
    `repos/${repo}/actions/workflows/image.yml/runs?branch=${BRANCH}&per_page=${RUN_PAGE}`,
  )
  for (const run of runs) {
    if (String(run.id) === String(runId)) continue // this attempt's own deploy has not run yet
    const { jobs } = await ghApi(`repos/${repo}/actions/runs/${run.id}/jobs?per_page=100`)
    const conclusion = jobs.find((j) => j.name === 'deploy')?.conclusion
    const attempts = run.run_attempt ?? 1
    const rerunAfterFailure =
      attempts > 1 &&
      !allowed.has(lower(run.triggering_actor?.login)) &&
      (await failedBefore({ repo, id: run.id, attempt: attempts, ghApi }))
    if (rerunAfterFailure) {
      return `the deploy of run ${run.id} failed and ${run.triggering_actor?.login} reran it; a rerun is not a recovery`
    }
    if (conclusion === 'success') return null
    if (conclusion === 'failure') return `the deploy of run ${run.id} failed`
  }
  // Page full and no deploy seen: older history is unknown, so stay suspended.
  return runs.length >= RUN_PAGE ? 'the last deploy result is unknown (no deploy in the last 100 runs)' : null
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
// failure history. Any other event is refused.
export async function recheck({ event, repo, runId, attempt, actor, trigger, extra, ghApi }) {
  const allowed = logins(extra)
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
