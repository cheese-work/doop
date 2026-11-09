// Decides whether this image.yml run may deploy to C00 (CHE-4585). Called by the
// `gate` job; the verdict goes to $GITHUB_OUTPUT, the deploy job reads only that.
//
// Order is deliberate and every error path fails closed:
//   1. who merged cheese/main (or who dispatched) must be on the allowlist;
//   2. MAIN_RED_PAUSED stops merge-triggered deploys;
//   3. a failed deploy suspends auto-deploy until an allowlisted human dispatches one.
// `recheck` repeats step 3 inside the deploy lock, where the answer can no longer change.
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

// Newest first. The newest run whose deploy job finished decides: failure suspends.
async function suspendedBy({ repo, runId, ghApi }) {
  const { workflow_runs: runs } = await ghApi(
    `repos/${repo}/actions/workflows/image.yml/runs?branch=${BRANCH}&per_page=${RUN_PAGE}`,
  )
  for (const run of runs) {
    if (String(run.id) === String(runId)) continue
    const { jobs } = await ghApi(`repos/${repo}/actions/runs/${run.id}/jobs?per_page=100`)
    const deploy = jobs.find((j) => j.name === 'deploy')
    if (deploy?.conclusion === 'success') return null
    if (deploy?.conclusion === 'failure') return `the deploy of run ${run.id} failed`
  }
  // Page full and no deploy seen: older history is unknown, so stay suspended.
  return runs.length >= RUN_PAGE ? 'the last deploy result is unknown (no deploy in the last 100 runs)' : null
}

export async function decide({ event, ref, sha, repo, runId, actor, extra, paused, ghApi }) {
  if (ref !== `refs/heads/${BRANCH}`) throw new Error(`deploys run only from ${BRANCH}, not ${ref}`)
  const allowed = logins(extra)

  if (event === 'workflow_dispatch') {
    const who = String(actor ?? '').toLowerCase()
    if (!allowed.has(who)) throw new Error(`${actor} is not on the deploy allowlist`)
    return { authorized: true, reason: `dispatched by ${actor}` }
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

  const suspended = await suspendedBy({ repo, runId, ghApi })
  if (suspended) return { authorized: false, reason: `auto-deploy suspended: ${suspended}` }
  return { authorized: true, reason: `merged by ${merger.login}` }
}

// Plain REST, so it also runs on the C00 runner, which has node but not `gh`.
// The gate runs before the deploy job queues for the lock, so a run that passed it
// can wait behind a deploy that then fails. The deploy job calls this once it
// holds the lock; a dispatch is a deliberate human act and is never re-judged.
export async function recheck({ event, repo, runId, ghApi }) {
  if (event !== 'push') return { authorized: true, reason: `${event} is not re-judged` }
  const suspended = await suspendedBy({ repo, runId, ghApi })
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
    const out = await recheck({ event: env.EVENT, repo: env.REPO, runId: env.RUN_ID, ghApi: gh })
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
    actor: env.ACTOR,
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
