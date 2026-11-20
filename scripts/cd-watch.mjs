// The two watchers of the doop deploy train (CHE-5550, plan CHE-5474 C-7). The decisions are pure functions;
// the CLI at the bottom reads facts from GitHub and from C00's /healthz and acts on them.
//   freshness  (cd-freshness-watch.yml, hosted, every 15 min)  C-7.1: a slot 45 min old with a qualified candidate
//              ahead of the last successful D2 SHA and no D2 run since: one `schedule_backup` dispatch. At 90 min:
//              fail the run. A failed D1 build is rerun once.
//   live       (cd-live-revision.yml, on cheese-x99-gate)      C-7.2: C00's /healthz revision must not be behind
//              the last successful D2 SHA.
// "Last successful D2 SHA" has three answers: known (a SHA), none (a proven first deployment: every D2 run is readable
// and none was confirmed) and unknown (the history cannot be read). Unknown fails both watchers visibly; it is never
// read as none. D2's evidence job records every confirmed deploy as a GitHub deployment (`record`), which outlives the
// 90 day artifacts and any number of skipped runs; the deploy-evidence artifacts are the fallback before the first record.
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
const RECORD_ENV = 'c00-doop'
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
export function freshness({ trainOn, nowMs, candidate, deployed, d2RunsSinceSlot, head }) {
  if (!trainOn) return { action: 'none', rerunD1: false, reason: 'DOOP_DEPLOY_TRAIN is not on: nothing is due' }
  const rerunD1 = head?.conclusion === 'failure' && head?.attempt === 1
  const age = nowMs - lastSlot(nowMs)
  const idle = (reason) => ({ action: 'none', rerunD1, reason })
  if (!candidate) return idle('no qualified candidate')
  if (deployed.state === 'unknown') {
    return { action: 'alarm', rerunD1, reason: `the last successful D2 SHA is unknown: ${deployed.reason}` }
  }
  const deployedSha = deployed.state === 'known' ? deployed.sha : null
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
// successful D2 SHA (known, none or unknown), `isAncestor(a, b)` whether a is an ancestor of b. Fails closed on anything
// unusable: an unknown history, and a /healthz that does not answer, even before any D2 succeeded.
export async function liveVerdict({ body, deployed, isAncestor }) {
  if (deployed.state === 'unknown') {
    return { ok: false, reason: `the last successful D2 SHA is unknown: ${deployed.reason}` }
  }
  if (!body || body.ok !== true) return { ok: false, reason: `/healthz did not report ok: ${JSON.stringify(body)}` }
  const live = body.revision
  if (typeof live !== 'string' || !SHA40.test(live)) {
    return { ok: false, reason: `/healthz revision is not a full commit SHA: ${JSON.stringify(live)}` }
  }
  if (deployed.state === 'none') {
    return { ok: true, reason: `no successful D2 yet: nothing to compare live ${short(live)} with` }
  }
  const last = deployed.sha
  if (live === last) return { ok: true, reason: `live ${short(live)} is the last successful D2` }
  if (await isAncestor(live, last)) {
    return { ok: false, reason: `live ${short(live)} is behind the last successful D2 ${short(last)}` }
  }
  if (await isAncestor(last, live)) {
    return { ok: true, reason: `live ${short(live)} is ahead of the last successful D2 ${short(last)}` }
  }
  return { ok: false, reason: `live ${short(live)} and the last successful D2 ${short(last)} have diverged` }
}

// The last successful D2 SHA. `recorded` is the newest successful deployment record, `{ sha, runId }` (runId: the D2 run
// that wrote it, or null), or null. A record alone is not the answer: if a later confirmed deploy failed to write its
// own record, the record is stale. So the runs newer than the record's run are checked first, newest first: a confirmed
// one that is not the record, or any one whose evidence is gone, green or not (it could have been that deploy, with
// the evidence upload failing after the confirm), makes the history unknown. Runs from the record's run on are older and are
// not read. With no record the whole history is scanned for the first `confirmed` run. At most `maxScan` runs are read.
// Reaching the end of the history with every run readable and none confirmed, and no record, is the one proof of
// "none". `listRuns(page)` gives completed D2 runs, newest first, an empty page at the end; `read(id)` gives a run's
// deploy-evidence, or null when it has none.
export async function lastDeployed({ recorded, listRuns, read, maxScan = 100 }) {
  const record = SHA40.test(recorded?.sha ?? '') ? recorded : null
  const unknown = (reason) => ({ state: 'unknown', reason })
  let scanned = 0
  for (let page = 1; ; page++) {
    const runs = await listRuns(page)
    if (runs.length === 0) {
      return record ? { state: 'known', sha: record.sha, source: 'deployment record' } : { state: 'none' }
    }
    for (const run of runs) {
      if (record && Number.isInteger(record.runId) && run.id <= record.runId) {
        return { state: 'known', sha: record.sha, source: 'deployment record' }
      }
      if (scanned++ >= maxScan) {
        const what = record ? `the record of ${short(record.sha)} is not reached` : 'no deployment record'
        return unknown(`${what}, and no confirmed D2 run in the newest ${maxScan} runs`)
      }
      const evidence = await read(run.id)
      if (evidence === null || evidence === undefined) {
        // Evidence is written on every run, so a run without it is unproven, whatever its conclusion: a deploy can
        // confirm and then fail (or be cancelled) before the evidence upload. Only evidence says it did not confirm.
        return unknown(
          `D2 run ${run.id} (${run.conclusion ?? 'unfinished'}) has no evidence: it could have confirmed a deploy`,
        )
      }
      if (evidence.outcome !== 'confirmed') continue
      if (!SHA40.test(evidence.candidate_sha ?? '')) {
        return unknown(`D2 run ${run.id} is confirmed but its evidence has no usable candidate SHA`)
      }
      if (!record) return { state: 'known', sha: evidence.candidate_sha, source: `evidence of D2 run ${run.id}` }
      if (evidence.candidate_sha === record.sha) return { state: 'known', sha: record.sha, source: 'deployment record' }
      return unknown(
        `D2 run ${run.id} confirmed ${short(evidence.candidate_sha)} but there is no deployment record of it ` +
          `(the newest record is ${short(record.sha)}): its record write failed`,
      )
    }
  }
}

// What D2 records durably after a confirmed deploy: a GitHub deployment of the candidate SHA. Null for anything else.
export function deploymentRecord(evidence) {
  if (evidence?.outcome !== 'confirmed' || !SHA40.test(evidence.candidate_sha ?? '')) return null
  return { ref: evidence.candidate_sha, environment: RECORD_ENV }
}

// ---------------------------------------------------------------------------------------------
// CLI: node scripts/cd-watch.mjs freshness | live | record <deploy-evidence.json>. Inputs come from env. Any error fails the run.
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

// The newest deployment record whose newest status is success, from the newest 30 records, as `{ sha, runId }` (runId
// from the description `... (D2 run <id>)`, null when absent); or null.
function recordedSha(repo) {
  const found = api(repo, `deployments?environment=${RECORD_ENV}&per_page=30`)
  for (const d of found) {
    const [status] = api(repo, `deployments/${d.id}/statuses?per_page=1`)
    if (status?.state === 'success') {
      const runId = Number(/\(D2 run (\d+)\)/.exec(d.description ?? '')?.[1])
      return { sha: d.sha, runId: Number.isInteger(runId) ? runId : null }
    }
  }
  return null
}

const deployedSha = (repo) =>
  lastDeployed({
    recorded: recordedSha(repo),
    listRuns: async (page) =>
      api(repo, `actions/workflows/cd-deploy.yml/runs?status=completed&per_page=100&page=${page}`).workflow_runs,
    read: async (id) => evidenceOf(repo, id),
  })

// `gh api -X POST` arguments: a string field goes with -f, a boolean with -F so that GitHub gets a JSON boolean.
export function ghPostArgs(repo, route, fields) {
  return [
    'api',
    '-X',
    'POST',
    `repos/${repo}/${route}`,
    ...Object.entries(fields).flatMap(([k, v]) => [typeof v === 'string' ? '-f' : '-F', `${k}=${v}`]),
  ]
}

// D2's evidence job: record a confirmed deploy as a successful deployment of the candidate SHA, then read it back.
// Throws when GitHub refuses a write or the record is not what was written, which turns the D2 run red.
export function recordDeployment({ repo, evidence, runId, gh, recordedSha }) {
  const payload = deploymentRecord(evidence)
  if (!payload) return 'cd-watch record: this run did not confirm a deploy; nothing to record'
  const post = (route, fields) => JSON.parse(gh(ghPostArgs(repo, route, fields)))
  const created = post('deployments', {
    ref: payload.ref,
    environment: payload.environment,
    description: `doop deploy train: confirmed on C00 (D2 run ${runId})`,
    auto_merge: false,
    production_environment: true,
  })
  post(`deployments/${created.id}/statuses`, { state: 'success', environment: payload.environment })
  if (recordedSha()?.sha !== payload.ref) {
    throw new Error(`the deployment record of ${short(payload.ref)} did not read back`)
  }
  return `cd-watch record: recorded ${short(payload.ref)} as a ${payload.environment} deployment`
}

async function cli(argv, env) {
  const [command] = argv
  const repo = env.REPO ?? env.GITHUB_REPOSITORY
  const trainOn = env.DOOP_DEPLOY_TRAIN === 'on'
  if (command === 'record') {
    const evidence = JSON.parse(readFileSync(argv[1], 'utf8'))
    const runId = env.GITHUB_RUN_ID
    return console.log(recordDeployment({ repo, evidence, runId, gh, recordedSha: () => recordedSha(repo) }))
  }
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
      deployed: await deployedSha(repo),
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
