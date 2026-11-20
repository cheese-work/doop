// Deploy evidence of the doop train (CHE-5549, plan CHE-5474 C-12). The last job of D2 runs it on every run,
// whatever happened: it writes deploy-evidence.json and appends the same facts to the run summary.
// Tofu or c00-hermes-devops copies the read-back values to CHE-2752.
// Inputs come from env (job results and outputs of D2), never from the command line; any value that is not the
// exact shape it should be is dropped, so nothing from a job output reaches the summary raw.
//   node scripts/deploy-evidence.mjs <path of deploy-evidence.json>
import { appendFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const ICT_OFFSET = 7 * 3600
const SHA40 = /^[0-9a-f]{40}$/
const DIGEST = /^sha256:[0-9a-f]{64}$/
const RESULTS = ['success', 'failure', 'cancelled', 'skipped']
const MODES = ['train', 'recovery', 'drill']

const pick = (re, v) => (typeof v === 'string' && re.test(v) ? v : null)
const num = (v) => (typeof v === 'string' && /^\d{1,12}$/.test(v) ? Number(v) : null)
const result = (v) => (RESULTS.includes(v) ? v : 'skipped')
const pad = (n) => String(n).padStart(2, '0')

/** "2026-11-20 14:17:05 ICT" for an epoch in seconds. */
export function ict(epoch) {
  const d = new Date((epoch + ICT_OFFSET) * 1000)
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} ICT`
}
const utc = (epoch) => new Date(epoch * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
const stamp = (epoch) => (epoch === null ? null : { ict: ict(epoch), utc: utc(epoch) })

function outcomeOf(j, action, applied) {
  if (j.confirm === 'success') return 'confirmed'
  if (j.rollback !== 'skipped') {
    if (action === 'rollback') return applied === 'success' ? 'rolled_back' : 'rollback_failed'
    if (action === 'none') return 'predecessor_running'
    if (action === 'superseded') return 'superseded'
    return 'rollback_refused'
  }
  if (j.deploy === 'success') return 'failed'
  return j.deploy === 'failure' ? 'failed_before_change' : 'not_deployed'
}

export function buildEvidence(env) {
  const jobs = {
    resolve: result(env.RESOLVE_RESULT),
    admit: result(env.ADMIT_RESULT),
    deploy: result(env.DEPLOY_RESULT),
    readback_delay: result(env.DELAY_RESULT),
    confirm: result(env.CONFIRM_RESULT),
    rollback: result(env.ROLLBACK_RESULT),
  }
  const action = ['rollback', 'none', 'superseded'].includes(env.ROLLBACK_ACTION) ? env.ROLLBACK_ACTION : null
  const t0 = num(env.T0_EPOCH)
  const confirmed = num(env.CONFIRMED_EPOCH)
  const now = num(env.NOW_EPOCH) ?? Math.floor(Date.now() / 1000)
  return {
    schema: 1,
    run_id: pick(/^\d+$/, env.RUN_ID),
    run_attempt: pick(/^\d+$/, env.RUN_ATTEMPT),
    mode: MODES.includes(env.MODE) ? env.MODE : null,
    outcome: outcomeOf(
      { deploy: jobs.deploy, confirm: jobs.confirm, rollback: jobs.rollback },
      action,
      env.ROLLBACK_APPLIED,
    ),
    candidate_sha: pick(SHA40, env.CANDIDATE),
    digest: pick(DIGEST, env.DIGEST),
    predecessor_sha: pick(SHA40, env.PREDECESSOR_SHA),
    predecessor_digest: pick(DIGEST, env.PREDECESSOR_DIGEST),
    health: pick(/^(healthy|unhealthy|starting|none)$/, env.HEALTH),
    readback: {
      restart_count_t0: num(env.RESTART_COUNT),
      restart_count_confirm: num(env.RESTART_COUNT_CONFIRM),
      delay_seconds: t0 !== null && confirmed !== null ? confirmed - t0 : null,
    },
    lock_wait_seconds: num(env.LOCK_WAIT_SECONDS),
    rollback_action: action,
    jobs,
    times: { readback_t0: stamp(t0), confirmed: stamp(confirmed), written: stamp(now) },
  }
}

const at = (s) => (s ? `${s.ict} (${s.utc})` : 'n/a')
const val = (v) => (v === null || v === undefined ? 'n/a' : String(v))

export function summaryOf(e) {
  const rows = [
    ['Outcome', e.outcome],
    ['Mode', val(e.mode)],
    ['Candidate SHA', val(e.candidate_sha)],
    ['Image digest', val(e.digest)],
    ['Predecessor', `${val(e.predecessor_sha)} ${val(e.predecessor_digest)}`],
    ['Health at read-back', val(e.health)],
    ['Restart count T0 / confirm', `${val(e.readback.restart_count_t0)} / ${val(e.readback.restart_count_confirm)}`],
    ['Delay T0 to confirm (s)', val(e.readback.delay_seconds)],
    ['Lock wait (s)', val(e.lock_wait_seconds)],
    ['Rollback action', val(e.rollback_action)],
    ['Read-back T0', at(e.times.readback_t0)],
    ['Confirmed', at(e.times.confirmed)],
    ['Written', at(e.times.written)],
    [
      'Jobs',
      Object.entries(e.jobs)
        .map(([k, v]) => `${k}=${v}`)
        .join(', '),
    ],
  ]
  return [
    `### Deploy evidence, run ${val(e.run_id)}`,
    '',
    '| Field | Value |',
    '| --- | --- |',
    ...rows.map(([k, v]) => `| ${k} | \`${v}\` |`),
    '',
    'Copy the read-back values to CHE-2752 (Tofu or c00-hermes-devops).',
    '',
  ].join('\n')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const out = process.argv[2]
  if (!out) {
    console.error('deploy evidence failed: no output path')
    process.exit(1)
  }
  const e = buildEvidence(process.env)
  writeFileSync(out, `${JSON.stringify(e, null, 2)}\n`)
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summaryOf(e))
  console.log(`deploy evidence: ${e.outcome}, candidate ${e.candidate_sha ?? 'none'}`)
}
