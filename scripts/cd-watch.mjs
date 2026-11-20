// The two watchers of the doop deploy train (CHE-5550, plan CHE-5474 C-7). The decisions are pure functions;
// the CLI at the bottom reads facts from GitHub and from C00's /healthz and acts on them.
//   freshness  (cd-freshness-watch.yml, hosted, every 15 min)  C-7.1: a slot 45 min old with a qualified candidate
//              ahead of the last successful D2 SHA and no D2 run since: one `schedule_backup` dispatch. At 90 min:
//              fail the run. A failed D1 build is rerun once.
//   live       (cd-live-revision.yml, on cheese-x99-gate)      C-7.2: C00's /healthz revision must not be behind
//              the last successful D2 SHA.
// "Last successful D2 SHA" is the candidate of the newest D2 run whose deploy-evidence artifact says `confirmed`.
// A D2 run that skips ends green, so a run conclusion says nothing about what was deployed.
// Both watchers do nothing while DOOP_DEPLOY_TRAIN is not `on`: with the train off nothing is due, so an alarm
// would only be noise. They are scheduled before the switch can turn on, so that their first runs are already seen.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { gitIsAncestor, pickCandidate } from './deploy-gate.mjs'

const MIN = 60_000
const BRANCH = 'cheese/main'
const SHA40 = /^[0-9a-f]{40}$/
// D2's slots: cron `17 23,7,15 * * *`, as minutes after midnight UTC (06:17, 14:17 and 22:17 ICT).
const SLOT_MINUTES = [7 * 60 + 17, 15 * 60 + 17, 23 * 60 + 17]
const DISPATCH_AFTER = 45 * MIN
const ALARM_AFTER = 90 * MIN
const short = (sha) => String(sha ?? 'none').slice(0, 7)

// The newest D2 slot at or before `nowMs`, as epoch ms.
export function lastSlot(nowMs) {
  const day = Date.UTC(new Date(nowMs).getUTCFullYear(), new Date(nowMs).getUTCMonth(), new Date(nowMs).getUTCDate())
  const slots = [-1, 0].flatMap((d) => SLOT_MINUTES.map((m) => day + d * 24 * 60 * MIN + m * MIN))
  return Math.max(...slots.filter((s) => s <= nowMs))
}

// C-7.1. Facts: switch, clock, the qualified candidate (or null), the last successful D2 SHA (or null), how many D2
// runs were created since the slot, and the newest D1 run (conclusion null while it runs).
// Result: what to do, why, and whether to rerun the failed D1 build.
export function freshness({ trainOn, nowMs, candidate, deployedSha, d2RunsSinceSlot, head }) {
  if (!trainOn) return { action: 'none', rerunD1: false, reason: 'DOOP_DEPLOY_TRAIN is not on: nothing is due' }
  const rerunD1 = head?.conclusion === 'failure' && head?.attempt === 1
  const age = nowMs - lastSlot(nowMs)
  const idle = (reason) => ({ action: 'none', rerunD1, reason })
  if (!candidate) return idle('no qualified candidate')
  if (candidate.sha === deployedSha) return idle(`candidate ${short(candidate.sha)} is already deployed`)
  const behind = `candidate ${short(candidate.sha)} is ahead of the last successful D2 ${short(deployedSha)}`
  if (age >= ALARM_AFTER) {
    const mins = Math.floor(age / MIN)
    return { action: 'alarm', rerunD1, reason: `${behind}, ${mins} min after the slot (limit ${ALARM_AFTER / MIN})` }
  }
  if (age < DISPATCH_AFTER) return idle('the slot is not 45 min old yet')
  if (d2RunsSinceSlot > 0) return idle(`${behind}; a D2 run exists since the slot`)
  return { action: 'dispatch', rerunD1, reason: `${behind}; no D2 run since the slot` }
}

// C-7.2. `body` is what /healthz answered (null when it did not answer or was not JSON), `deployed` the last
// successful D2 SHA, `isAncestor(a, b)` whether a is an ancestor of b. Fails closed on anything unusable.
export async function liveVerdict({ body, deployed, isAncestor }) {
  if (deployed === null || deployed === undefined) {
    return { ok: true, reason: 'no successful D2 yet: nothing to compare the live revision with' }
  }
  if (!body || body.ok !== true) return { ok: false, reason: `/healthz did not report ok: ${JSON.stringify(body)}` }
  const live = body.revision
  if (typeof live !== 'string' || !SHA40.test(live)) {
    return { ok: false, reason: `/healthz revision is not a full commit SHA: ${JSON.stringify(live)}` }
  }
  if (live === deployed) return { ok: true, reason: `live ${short(live)} is the last successful D2` }
  if (await isAncestor(live, deployed)) {
    return { ok: false, reason: `live ${short(live)} is behind the last successful D2 ${short(deployed)}` }
  }
  if (await isAncestor(deployed, live)) {
    return { ok: true, reason: `live ${short(live)} is ahead of the last successful D2 ${short(deployed)}` }
  }
  return { ok: false, reason: `live ${short(live)} and the last successful D2 ${short(deployed)} have diverged` }
}

// The candidate of the newest run (newest first) whose evidence says confirmed; null when none did.
// `read(id)` gives that run's deploy-evidence, or null when it has none (expired, never written).
export async function lastDeployed(runs, read) {
  for (const run of runs) {
    const evidence = await read(run.id)
    if (evidence?.outcome === 'confirmed' && SHA40.test(evidence.candidate_sha ?? '')) return evidence.candidate_sha
  }
  return null
}

// ---------------------------------------------------------------------------------------------
// CLI: node scripts/cd-watch.mjs freshness | live. Inputs come from env. Any error fails the run.
const gh = (args) => {
  const r = spawnSync('gh', args, { encoding: 'utf8', env: process.env })
  if (r.status !== 0) throw Object.assign(new Error(`gh ${args.join(' ')} failed: ${r.stderr.trim()}`), { r })
  return r.stdout
}
const api = (repo, route) => JSON.parse(gh(['api', `repos/${repo}/${route}`]))

// deploy-evidence.json of one D2 run, or null when the run has no such artifact.
function evidenceOf(repo, id) {
  const dir = mkdtempSync(path.join(tmpdir(), 'cd-watch-'))
  try {
    const r = spawnSync(
      'gh',
      ['run', 'download', String(id), '--repo', repo, '--name', 'deploy-evidence', '--dir', dir],
      {
        encoding: 'utf8',
      },
    )
    if (r.status !== 0) {
      if (/no artifact|not found|expired|no valid artifacts/i.test(r.stderr)) return null
      throw new Error(`gh run download ${id} failed: ${r.stderr.trim()}`)
    }
    return JSON.parse(readFileSync(path.join(dir, 'deploy-evidence.json'), 'utf8'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// The last successful D2 SHA, from the newest 30 D2 runs that ended green (a skip and a deploy both do).
const deployedSha = (repo) =>
  lastDeployed(api(repo, 'actions/workflows/cd-deploy.yml/runs?status=completed&per_page=30').workflow_runs, (id) =>
    evidenceOf(repo, id),
  )

async function cli(argv, env) {
  const [command] = argv
  const repo = env.REPO ?? env.GITHUB_REPOSITORY
  const trainOn = env.DOOP_DEPLOY_TRAIN === 'on'
  if (command === 'freshness') {
    const nowMs = Date.now()
    if (!trainOn) {
      console.log(`cd-watch freshness: ${freshness({ trainOn, nowMs }).reason}`)
      return
    }
    const d1 = (q) =>
      api(repo, `actions/workflows/image.yml/runs?branch=${BRANCH}&event=push&${q}per_page=50`).workflow_runs
    const candidate = pickCandidate(d1('status=success&'))
    const newest = d1('')[0]
    const sinceIso = new Date(lastSlot(nowMs)).toISOString().replace(/\.\d{3}Z$/, 'Z')
    const d2 = api(repo, `actions/workflows/cd-deploy.yml/runs?created=>=${sinceIso}&per_page=50`)
    const out = freshness({
      trainOn,
      nowMs,
      candidate,
      deployedSha: await deployedSha(repo),
      d2RunsSinceSlot: d2.total_count,
      head: newest && { conclusion: newest.conclusion, attempt: newest.run_attempt },
    })
    console.log(`cd-watch freshness: ${out.action}: ${out.reason}`)
    if (out.rerunD1) {
      console.log(`rerunning the failed D1 run ${newest.id} once`)
      gh(['run', 'rerun', String(newest.id), '--repo', repo, '--failed'])
    }
    if (out.action === 'dispatch') {
      gh([
        'api',
        '-X',
        'POST',
        `repos/${repo}/actions/workflows/cd-deploy.yml/dispatches`,
        '-f',
        `ref=${BRANCH}`,
        '-f',
        'inputs[mode]=train',
        '-f',
        'inputs[schedule_backup]=true',
      ])
      console.log('sent one schedule_backup dispatch of cd-deploy.yml')
    }
    if (out.action === 'alarm') {
      console.log(`::error::D2 is overdue: ${out.reason}`)
      process.exitCode = 1
    }
    return
  }
  if (command === 'live') {
    if (!trainOn) {
      console.log('cd-watch live: DOOP_DEPLOY_TRAIN is not on: nothing is due')
      return
    }
    if (!env.DOOP_C00_HOST) throw new Error('repo variable DOOP_C00_HOST is not set')
    let body = null
    let timer
    try {
      // A host that does not answer is a failed read, not a hung job.
      const read = fetch(`https://${env.DOOP_C00_HOST}/healthz`).then((res) => res.json())
      const late = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('no answer in 15 s')), 15_000)
      })
      body = await Promise.race([read, late])
    } catch (err) {
      console.log(`/healthz could not be read: ${err.message}`)
    } finally {
      clearTimeout(timer)
    }
    const out = await liveVerdict({ body, deployed: await deployedSha(repo), isAncestor: gitIsAncestor })
    console.log(`cd-watch live: ${out.ok ? 'ok' : 'fail'}: ${out.reason}`)
    if (!out.ok) {
      console.log(`::error::C00 live revision check failed: ${out.reason}`)
      process.exitCode = 1
    }
    return
  }
  throw new Error(`unknown command '${command}'`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  cli(process.argv.slice(2), process.env).catch((err) => {
    console.log(`::error::cd-watch failed: ${err.message}`)
    process.exit(1)
  })
}
