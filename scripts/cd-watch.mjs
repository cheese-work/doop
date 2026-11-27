// The two watchers of the doop deploy train (CHE-5550, plan CHE-5474 C-7). The decisions are pure functions;
// the CLI at the bottom reads facts from GitHub and from C00's /healthz and acts on them.
//   freshness  (cd-freshness-watch.yml, hosted, every 15 min)  C-7.1: a slot 45 min old with a qualified candidate
//              ahead of the last successful D2 SHA and no D2 run since: one `schedule_backup` dispatch. At 90 min:
//              fail the run. A failed D1 build is rerun once.
//   live       (cd-live-revision.yml, on cheese-x99-gate)      C-7.2: C00's /healthz revision must not be behind
//              the last successful D2 SHA.
// "Last successful D2 SHA" has four answers: known (a SHA), pending (a young D2 run may still confirm: the SHA comparison waits, the 90 min alarm and the health check do not), none (a proven first deployment: every D2 run is readable
// and none was confirmed) and unknown (the history cannot be read). Unknown fails both watchers visibly; it is never
// read as none. D2's evidence job records every confirmed deploy as a GitHub deployment (`record`), which outlives the
// 90 day artifacts and any number of skipped runs; the deploy-evidence artifacts are the fallback before the first record.
// A D2 run that skips ends green, so a run conclusion says nothing about what was deployed.
// Both watchers do nothing while DOOP_DEPLOY_TRAIN is not `on`: with the train off nothing is due, so an alarm
// would only be noise. They are scheduled before the switch can turn on, so that their first runs are already seen.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
const SKEW = 5 * MIN // runner clock against GitHub clock
const RERUN_WINDOW = 30 * 24 * 60 * MIN // GitHub allows a rerun up to 30 days after the run
const STUCK_AFTER = 3 * 60 * MIN // D2's job timeouts add up to under 2 h
// Where C00 serves doop's /healthz over the tailnet (host[:port], no scheme). Repo variable DOOP_C00_HOST overrides it; a
// missing or blank variable is not a failure (CHE-9479). Documented in deploy/cd/README.md.
const DEFAULT_C00_HOST = 'congvc-c00.taila6fa8a.ts.net:34443'
export const c00Host = (env) => env.DOOP_C00_HOST?.trim() || DEFAULT_C00_HOST
const short = (sha) => String(sha ?? 'none').slice(0, 7)

// The newest D2 slot at or before `nowMs`, as epoch ms.
export function lastSlot(nowMs) {
  const day = Date.UTC(new Date(nowMs).getUTCFullYear(), new Date(nowMs).getUTCMonth(), new Date(nowMs).getUTCDate())
  const slots = [-1, 0].flatMap((d) => SLOT_MINUTES.map((m) => day + d * 24 * 60 * MIN + m * MIN))
  return Math.max(...slots.filter((s) => s <= nowMs))
}

// Why D2's gate skipped its newest run (deploy-evidence `skip_reason`). `suspended` and `unreadable` need Cheese to lift
// the marker, so the watcher alarms and never dispatches. `busy` and `armed` wait for the blocking run, then send one
// dispatch.
const LIFT_SKIPS = ['suspended', 'unreadable']
const WAIT_SKIPS = ['busy', 'armed']
// The alarm's owner: a quiet slot with no live run at all points at the X99 runner (c00-hermes-devops); otherwise the CD lane.
const QUIET_OWNER = { runnerDown: 'c00-hermes-devops', otherwise: 'CD lane' }
const QUEUE_LIMIT = 10 * MIN

// Which step is at fault, and who owns it (plan r5, S2 diagnosis). The first matching fact wins. Facts that the caller
// cannot measure are left null and never match. A confirm that read back `inconclusive` is not here: D2's evidence has no
// such outcome yet, so there is nothing to measure (it belongs to S4, which adds the confirm read-back result).
export function diagnose({ d1Red = false, d1Author = null, c00QueuedMinutes = null, markerSuspended = false }) {
  if (d1Red) return { step: 'D1', reason: 'the D1 image build failed', owner: d1Author ?? 'PR author' }
  if (c00QueuedMinutes !== null && c00QueuedMinutes * MIN > QUEUE_LIMIT) {
    return { step: 'C00', reason: `the C00 job has been queued ${c00QueuedMinutes} min`, owner: 'c00-hermes-devops' }
  }
  if (markerSuspended) return { step: 'marker', reason: 'the deploy marker is suspended', owner: 'Cheese' }
  return null
}

// The `live-evidence.json` the live check writes: the full revision C00 served, whether it was healthy, when it was
// observed, and the run that observed it. `body` is /healthz's answer (null when it did not answer).
export function liveEvidence({ body, observedMs, runId, runAttempt }) {
  const revision = typeof body?.revision === 'string' && SHA40.test(body.revision) ? body.revision : null
  return {
    schema: 1,
    revision,
    ok: body?.ok === true && revision !== null,
    observed_at: new Date(observedMs).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    run_id: /^\d+$/.test(String(runId ?? '')) ? Number(runId) : null,
    run_attempt: /^\d+$/.test(String(runAttempt ?? '')) ? Number(runAttempt) : null,
  }
}

// Quiet slot (option A, FP-03): when the candidate already equals the deployed SHA, the slot counts as delivered only with
// fresh live evidence. `evidence` is one `live-evidence.json` (from `cd-watch live`), `slotMs` the slot's epoch ms, `sha`
// the candidate. Its observation must be after the slot, name the full target revision, and report healthy. Nothing else
// (a green workflow, a head SHA) proves it.
export function quietSlotProof({ evidence, slotMs, sha }) {
  if (!evidence || evidence.schema !== 1) return { delivered: false, reason: 'no live evidence since the slot' }
  const observed = Date.parse(evidence.observed_at ?? '')
  if (!Number.isFinite(observed) || observed <= slotMs) {
    return { delivered: false, reason: 'the live evidence was observed before the slot' }
  }
  if (evidence.revision !== sha) {
    return {
      delivered: false,
      reason: `the live evidence names ${short(evidence.revision)}, not the slot target ${short(sha)}`,
    }
  }
  if (evidence.ok !== true) return { delivered: false, reason: 'the live evidence is not healthy' }
  const run = evidence.run_id ? ` (live run ${evidence.run_id}.${evidence.run_attempt ?? 1})` : ''
  return { delivered: true, reason: `live ${short(sha)} healthy, observed ${evidence.observed_at}${run}` }
}

// The newest qualified D1 candidate that was on cheese/main at `slotMs` (CHE-9956, FP-05). `runs` is D1's push runs, newest
// first. A D1 push run is created by the push that put its commit on cheese/main, so `created_at` is the time the commit
// landed. A commit that landed after the slot is not due until the next one: taking the newest run instead would call
// every merge between a slot and slot + 90 min overdue.
// `deployedSha` (optional): when the SHA D2 last confirmed is itself a later candidate (a dispatch delivered it after the
// slot), that later run is returned, so the older slot candidate is not called undelivered.
export function slotCandidate(runs, slotMs, deployedSha = null) {
  const qualified = (r) =>
    r.event === 'push' && r.conclusion === 'success' && Number.isFinite(Date.parse(r.created_at ?? ''))
  const delivered = deployedSha && runs.find((r) => qualified(r) && r.head_sha === deployedSha)
  if (delivered && Date.parse(delivered.created_at) > slotMs) {
    return { sha: delivered.head_sha, runId: delivered.id, createdMs: Date.parse(delivered.created_at) }
  }
  for (const r of runs) {
    const createdMs = Date.parse(r.created_at ?? '')
    if (r.event !== 'push' || r.conclusion !== 'success' || !Number.isFinite(createdMs) || createdMs > slotMs) continue
    return { sha: r.head_sha, runId: r.id, createdMs }
  }
  return null
}

// The longest wait, in whole minutes, of a queued job that asks for the C00 runner; null when none waits. `jobs` are the
// jobs of one D2 run (GitHub's `status`, `created_at` and `labels`).
export function c00QueuedMinutes(jobs, nowMs) {
  const waits = (jobs ?? [])
    .filter((j) => j.status === 'queued' && (j.labels ?? []).includes('cheese-c00-deploy'))
    .map((j) => Math.floor((nowMs - Date.parse(j.created_at ?? '')) / MIN))
    .filter(Number.isFinite)
  return waits.length ? Math.max(...waits) : null
}

// C-7.1. Facts: switch, clock, the qualified candidate (or null), the last successful D2 SHA (or null), how many D2
// runs were created since the slot, and the newest D1 run (conclusion null while it runs).
// Optional facts (all default to the pre-S2 behaviour):
//   skipReason     why the newest completed D2 run skipped (deploy-evidence skip_reason), or null;
//   d2RunActive    a D2 run is still queued or running;
//   followUpD2     a D2 run was created after the skipped run (the one dispatch after a busy run already went out);
//   quiet          quietSlotProof for the slot, used only when the candidate is already the deployed SHA;
//   runnerSeen     a cd-live-revision run exists since the slot (false points the quiet alarm at the X99 runner);
//   c00QueuedMinutes  how long a C00 job of the active D2 run has been queued (names c00-hermes-devops over 10 min).
// `candidate.createdMs` (FP-05) is when the candidate landed on cheese/main: one that landed after the slot is not due yet.
// Result: what to do, why, whether to rerun the failed D1 build, and a `diagnosis` on an alarm.
export function freshness({
  trainOn,
  nowMs,
  candidate,
  deployed,
  d2RunsSinceSlot,
  head,
  skipReason = null,
  d2RunActive = false,
  followUpD2 = false,
  quiet = null,
  runnerSeen = true,
  c00QueuedMinutes = null,
}) {
  if (!trainOn) return { action: 'none', rerunD1: false, reason: 'DOOP_DEPLOY_TRAIN is not on: nothing is due' }
  const rerunD1 = head?.conclusion === 'failure' && head?.attempt === 1
  const age = nowMs - lastSlot(nowMs)
  const idle = (reason) => ({ action: 'none', rerunD1, reason })
  const alarm = (reason, facts = {}) => ({
    action: 'alarm',
    rerunD1,
    reason,
    diagnosis: diagnose({
      d1Red: rerunD1 || head?.conclusion === 'failure',
      markerSuspended: skipReason === 'suspended',
      c00QueuedMinutes,
      ...facts,
    }),
  })
  if (!candidate) return idle('no qualified candidate')
  if (deployed.state === 'unknown') {
    return alarm(`the last successful D2 SHA is unknown: ${deployed.reason}`)
  }
  // FP-05: a candidate that landed after the slot is due at the next slot. No alarm, no dispatch.
  if (Number.isFinite(candidate.createdMs) && candidate.createdMs > nowMs - age) {
    return idle(`candidate ${short(candidate.sha)} merged after the slot; due at the next slot`)
  }
  if (deployed.state === 'pending') {
    // The run may be the deploy, but a queued or stuck one must not hide a missed window: the 90 min alarm still fires.
    if (age >= ALARM_AFTER) {
      const mins = Math.floor(age / MIN)
      return alarm(`${deployed.reason}, still unfinished ${mins} min after the slot (limit ${ALARM_AFTER / MIN})`)
    }
    return idle(deployed.reason)
  }
  const deployedSha = deployed.state === 'known' ? deployed.sha : null
  if (candidate.sha === deployedSha) {
    // Quiet slot: nothing to deliver, but the slot is delivered only with fresh live evidence (S2 option A).
    if (quiet?.delivered) return idle(`candidate ${short(candidate.sha)} is already deployed: ${quiet.reason}`)
    if (age >= ALARM_AFTER) {
      const owner = runnerSeen ? QUIET_OWNER.otherwise : QUIET_OWNER.runnerDown
      const why = quiet?.reason ?? 'no live evidence since the slot'
      return alarm(
        `candidate ${short(candidate.sha)} is already deployed, but the slot has no fresh live evidence: ${why}; owner ${owner}`,
      )
    }
    return idle(`candidate ${short(candidate.sha)} is already deployed; waiting for live evidence`)
  }
  const behind = `candidate ${short(candidate.sha)} is ahead of the last successful D2 ${short(deployedSha)}`
  if (age >= ALARM_AFTER) {
    const mins = Math.floor(age / MIN)
    return alarm(`${behind}, ${mins} min after the slot (limit ${ALARM_AFTER / MIN})`)
  }
  // Suspended or unreadable: Cheese must lift it. Alarm now, dispatch never.
  if (LIFT_SKIPS.includes(skipReason)) {
    return alarm(`${behind}; the D2 gate skipped (${skipReason}): Cheese must lift the marker, no dispatch`, {
      markerSuspended: skipReason === 'suspended',
    })
  }
  if (age < DISPATCH_AFTER) return idle('the slot is not 45 min old yet')
  if (WAIT_SKIPS.includes(skipReason)) {
    // The skipped run is finished. Wait while another D2 run is active; once it has ended, send exactly one dispatch.
    if (d2RunActive) return idle(`${behind}; a D2 run is still active (${skipReason} skip)`)
    if (followUpD2) return idle(`${behind}; the one dispatch after the ${skipReason} skip already went out`)
    return {
      action: 'dispatch',
      rerunD1,
      reason: `${behind}; the ${skipReason} run has ended and the slot is undelivered`,
    }
  }
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
  if (deployed.state === 'pending') {
    // Only the SHA comparison waits for the run; the health check above never does.
    return { ok: true, reason: `${deployed.reason}: live ${short(live)} is healthy, the comparison waits for the run` }
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

// The last successful D2 SHA, by CONFIRMATION TIME, never by run ID: runs queue independently, so an older run can
// confirm after a newer one, and a run can be rerun days later. `recorded` is the newest successful deployment
// record `{ sha, runId, confirmedAt (ms) }` (runId may be null), or null. A record alone is not the answer: a
// later confirmed deploy whose record write failed would leave it stale. So every run that could have confirmed at or
// after the record's confirmation is checked (newest created first):
//   - unfinished: `pending` while it is young (it may confirm any minute), `unknown` once it is stuck;
//   - last activity (`updated_at`, which a rerun moves) earlier than the record's confirmation: it finished before, skipped;
//   - no evidence: unknown, whatever its conclusion (a deploy can confirm and then fail before the evidence upload),
//     unless `deploySkipped(id)` proves the `deploy` job was skipped in every attempt: it never touched C00, so it is a clean skip;
//   - confirmed with a different SHA confirmed after the record: unknown (its record write failed); before it: older.
// Runs created more than 30 days (GitHub's rerun limit) before the record's confirmation cannot be active; reaching one
// ends the scan. With no record, the first confirmed evidence found takes the record's place (a later confirmation
// replaces it). With every run readable and none confirmed, and no record, "none" is proven. At most `maxScan`
// evidence reads. `listRuns(page)` gives D2 runs of any status, newest created first, an empty page at the end;
// `read(id)` gives a run's deploy-evidence, or null when it has none. `deploySkipped(id)` (optional) says whether the
// run's `deploy` job was skipped in every attempt.
export async function lastDeployed({ recorded, listRuns, read, deploySkipped, maxScan = 100, nowMs = Date.now() }) {
  let best =
    SHA40.test(recorded?.sha ?? '') && Number.isFinite(recorded?.confirmedAt)
      ? {
          sha: recorded.sha,
          confirmedAt: recorded.confirmedAt,
          runId: recorded.runId ?? null,
          source: 'deployment record',
        }
      : null
  const unknown = (reason) => ({ state: 'unknown', reason })
  const answer = () => (best ? { state: 'known', sha: best.sha, source: best.source } : { state: 'none' })
  const when = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')
  let reads = 0
  for (let page = 1; ; page++) {
    const runs = await listRuns(page)
    if (runs.length === 0) return answer()
    for (const run of runs) {
      if (best && run.id === best.runId) continue
      const created = Date.parse(run.created_at)
      const updated = Date.parse(run.updated_at)
      if (best && created < best.confirmedAt - RERUN_WINDOW) return answer()
      if (run.status && run.status !== 'completed') {
        if (nowMs - created > STUCK_AFTER) {
          return unknown(
            `D2 run ${run.id} has been ${run.status} for over ${STUCK_AFTER / MIN / 60} h: it could confirm a deploy at any time`,
          )
        }
        return { state: 'pending', reason: `D2 run ${run.id} is ${run.status}: it may confirm a deploy` }
      }
      if (best && updated < best.confirmedAt - SKEW) continue
      if (reads++ >= maxScan) {
        const what = best ? `the record of ${short(best.sha)} is not reached` : 'no deployment record'
        return unknown(`${what}, and the newest ${maxScan} runs were read without proof`)
      }
      const evidence = await read(run.id)
      if (evidence === null || evidence === undefined) {
        // A run whose deploy job never ran touched nothing, so the missing evidence is not a gap (CHE-9479). Any other
        // run without evidence is unproven, whatever its conclusion: a deploy can confirm and then fail (or be
        // cancelled) before the evidence upload.
        if (deploySkipped && (await deploySkipped(run.id))) continue
        return unknown(
          `D2 run ${run.id} (${run.conclusion ?? 'unfinished'}) has no evidence: it could have confirmed a deploy after the last record`,
        )
      }
      if (evidence.outcome !== 'confirmed') continue
      const confirmedAt = Date.parse(evidence.times?.confirmed?.utc ?? '')
      if (!SHA40.test(evidence.candidate_sha ?? '') || !Number.isFinite(confirmedAt)) {
        return unknown(
          `D2 run ${run.id} is confirmed but its evidence has no usable candidate SHA or confirmation time`,
        )
      }
      if (!best) {
        best = { sha: evidence.candidate_sha, confirmedAt, runId: run.id, source: `evidence of D2 run ${run.id}` }
      } else if (evidence.candidate_sha === best.sha) {
        best.confirmedAt = Math.max(best.confirmedAt, confirmedAt)
      } else if (confirmedAt > best.confirmedAt) {
        if (best.source === 'deployment record') {
          return unknown(
            `D2 run ${run.id} confirmed ${short(evidence.candidate_sha)} at ${when(confirmedAt)}, after the newest record ` +
              `(${short(best.sha)}, ${when(best.confirmedAt)}), but there is no deployment record of it: its record write failed`,
          )
        }
        best = { sha: evidence.candidate_sha, confirmedAt, runId: run.id, source: `evidence of D2 run ${run.id}` }
      }
    }
  }
}

// What D2 records durably after a confirmed deploy: a GitHub deployment of the candidate SHA. Null for anything else.
export function deploymentRecord(evidence) {
  if (evidence?.outcome !== 'confirmed' || !SHA40.test(evidence.candidate_sha ?? '')) return null
  const confirmedAt = Date.parse(evidence.times?.confirmed?.utc ?? '')
  return {
    ref: evidence.candidate_sha,
    environment: RECORD_ENV,
    confirmedAt: Number.isFinite(confirmedAt) ? new Date(confirmedAt).toISOString().replace(/\.\d{3}Z$/, 'Z') : null,
  }
}

// ---------------------------------------------------------------------------------------------
// CLI: node scripts/cd-watch.mjs freshness | live | record <deploy-evidence.json>. Inputs come from env. Any error fails the run.
const gh = (args, input) => {
  const r = spawnSync('gh', args, { encoding: 'utf8', env: process.env, input })
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

// True when the run has `deploy` jobs and EVERY attempt's `deploy` job was skipped. A deploy may confirm in one attempt,
// lose its evidence and record, and a full rerun may then skip `deploy`: the newest attempt alone would hide that
// confirmation. So the jobs of all attempts are read (`filter=all`); a missing or non-skipped `deploy` job is no proof.
export function deployJobsAllSkipped(jobs) {
  const deploys = (jobs ?? []).filter((j) => j.name === 'deploy')
  return deploys.length > 0 && deploys.every((j) => j.conclusion === 'skipped')
}

// live-evidence.json of one cd-live-revision run, or null when it has none.
function liveEvidenceOf(repo, id) {
  const dir = mkdtempSync(path.join(tmpdir(), 'cd-watch-live-'))
  try {
    const r = spawnSync(
      'gh',
      ['run', 'download', String(id), '--repo', repo, '--name', 'live-evidence', '--dir', dir],
      {
        encoding: 'utf8',
      },
    )
    if (r.status !== 0) {
      if (/no artifact|not found|expired|no valid artifacts/i.test(r.stderr)) return null
      throw new Error(`gh run download ${id} (live-evidence) failed: ${r.stderr.trim()}`)
    }
    return JSON.parse(readFileSync(path.join(dir, 'live-evidence.json'), 'utf8'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function deployJobSkipped(repo, id) {
  const { jobs } = api(repo, `actions/runs/${id}/jobs?per_page=100&filter=all`)
  return deployJobsAllSkipped(jobs)
}

// The newest deployment record whose newest status is success, from the newest 30 records, as `{ sha, runId,
// confirmedAt }` (both from the description `... (D2 run <id>, confirmed <UTC time>)`; null when absent); or null.
function recordedSha(repo) {
  const found = api(repo, `deployments?environment=${RECORD_ENV}&per_page=30`)
  for (const d of found) {
    const [status] = api(repo, `deployments/${d.id}/statuses?per_page=1`)
    if (status?.state === 'success') {
      const runId = Number(/D2 run (\d+)/.exec(d.description ?? '')?.[1])
      const confirmedAt = Date.parse(/confirmed (\d{4}-\d\d-\d\dT[\d:]+Z)/.exec(d.description ?? '')?.[1] ?? '')
      return { sha: d.sha, runId: Number.isInteger(runId) ? runId : null, confirmedAt }
    }
  }
  return null
}

const deployedSha = (repo) =>
  lastDeployed({
    recorded: recordedSha(repo),
    listRuns: async (page) => api(repo, `actions/workflows/cd-deploy.yml/runs?per_page=100&page=${page}`).workflow_runs,
    read: async (id) => evidenceOf(repo, id),
    deploySkipped: async (id) => deployJobSkipped(repo, id),
  })

// The picked candidate with the time its D1 run was created (FP-05), or null.
function withCreated(hit, runs) {
  const run = hit && runs.find((r) => r.id === hit.runId)
  return hit && { ...hit, createdMs: Date.parse(run?.created_at ?? '') }
}

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

// `gh api -X POST` with a JSON body on stdin: -f/-F cannot send an empty array.
export const ghPostJsonArgs = (repo, route) => ['api', '-X', 'POST', `repos/${repo}/${route}`, '--input', '-']

// D2's evidence job: record a confirmed deploy as a successful deployment of the candidate SHA, then read it back.
// Throws when GitHub refuses a write or the record is not what was written, which turns the D2 run red.
export function recordDeployment({ repo, evidence, runId, gh, recordedSha }) {
  const payload = deploymentRecord(evidence)
  if (!payload) return 'cd-watch record: this run did not confirm a deploy; nothing to record'
  // The watchers order deploys by confirmation time: a record without it would be unusable, so the run goes red.
  if (!payload.confirmedAt) throw new Error('the confirmed evidence has no confirmation time; cannot record the deploy')
  const post = (route, fields) => JSON.parse(gh(ghPostArgs(repo, route, fields)))
  // required_contexts: [] (CHE-10262): a confirmed deploy is a fact. Without it GitHub answers 409 "Commit status
  // checks failed" when any check-run of the commit is red, and the record is lost.
  const body = {
    ref: payload.ref,
    environment: payload.environment,
    description: `doop deploy train: confirmed on C00 (D2 run ${runId}, confirmed ${payload.confirmedAt})`,
    auto_merge: false,
    production_environment: true,
    required_contexts: [],
  }
  const created = JSON.parse(gh(ghPostJsonArgs(repo, 'deployments'), JSON.stringify(body)))
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
    const slotMs = lastSlot(nowMs)
    const d1Success = d1('status=success&')
    const newest = d1('')[0]
    const sinceIso = new Date(slotMs).toISOString().replace(/\.\d{3}Z$/, 'Z')
    const d2 = api(repo, `actions/workflows/cd-deploy.yml/runs?created=>=${sinceIso}&per_page=50`)
    const deployed = await deployedSha(repo)
    // FP-05: the slot's candidate is the newest one on cheese/main at the slot. With none (a first slot), the newest one
    // stands, and freshness reads it as merged after the slot.
    const candidate =
      slotCandidate(d1Success, slotMs, deployed.state === 'known' ? deployed.sha : null) ??
      withCreated(pickCandidate(d1Success), d1Success)
    // The newest finished D2 run since the slot is the one that skipped (or deployed); its evidence says why.
    const skipped = d2.workflow_runs.find((r) => r.status === 'completed')
    const skipReason = skipped ? ((await evidenceOf(repo, skipped.id))?.skip_reason ?? null) : null
    // Quiet slot: candidate already deployed. The live check's evidence since the slot is the only proof.
    let quiet = null
    let runnerSeen = true
    if (candidate && deployed.state === 'known' && candidate.sha === deployed.sha) {
      const live = api(repo, `actions/workflows/cd-live-revision.yml/runs?created=>=${sinceIso}&per_page=10`)
      runnerSeen = live.workflow_runs.length > 0
      quiet = { delivered: false, reason: 'no live evidence since the slot' }
      for (const run of live.workflow_runs) {
        const proof = quietSlotProof({
          evidence: await liveEvidenceOf(repo, run.id),
          slotMs,
          sha: candidate.sha,
        })
        quiet = proof
        if (proof.delivered) break
      }
    }
    const active = d2.workflow_runs.find((r) => r.status !== 'completed')
    const queued = active
      ? c00QueuedMinutes(api(repo, `actions/runs/${active.id}/jobs?per_page=100`).jobs, nowMs)
      : null
    const out = freshness({
      trainOn,
      nowMs,
      candidate,
      deployed,
      d2RunsSinceSlot: d2.total_count,
      head: newest && { conclusion: newest.conclusion, attempt: newest.run_attempt },
      skipReason,
      d2RunActive: d2.workflow_runs.some((r) => r.status !== 'completed'),
      followUpD2: Boolean(skipped) && d2.workflow_runs[0]?.id !== skipped.id,
      quiet,
      runnerSeen,
      c00QueuedMinutes: queued,
    })
    if (out.diagnosis) console.log(`diagnosis: ${JSON.stringify(out.diagnosis)}`)
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
    let body = null
    let timer
    try {
      // A host that does not answer is a failed read, not a hung job.
      const read = fetch(`https://${c00Host(env)}/healthz`).then((res) => res.json())
      const late = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('no answer in 15 s')), 15_000)
      })
      body = await Promise.race([read, late])
    } catch (err) {
      console.log(`/healthz could not be read: ${err.message}`)
    } finally {
      clearTimeout(timer)
    }
    const observedMs = Date.now()
    const out = await liveVerdict({ body, deployed: await deployedSha(repo), isAncestor: gitIsAncestor })
    console.log(`cd-watch live: ${out.ok ? 'ok' : 'fail'}: ${out.reason}`)
    if (env.LIVE_EVIDENCE_OUT) {
      // Evidence the freshness watcher binds to a quiet slot (quietSlotProof). The full revision as C00 served it.
      const evidence = liveEvidence({
        body,
        observedMs,
        runId: env.GITHUB_RUN_ID,
        runAttempt: env.GITHUB_RUN_ATTEMPT,
      })
      writeFileSync(env.LIVE_EVIDENCE_OUT, `${JSON.stringify(evidence, null, 2)}\n`)
    }
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
