// Merge proof (CHE-7207 S2a, plan "Merge proof" rules 1 to 6). `node scripts/ci/merge-proof.mjs <pr>` reads one
// CI run attempt of the PR head and binds all migration evidence to it. Prints `merge-proof PASS` or
// `merge-proof FAIL <reason>`; exit 0 on PASS, 1 otherwise. Used by the S4 merge-ask block and by P5 later.
// The `tests` aggregate job stays unchanged (CHE-5543 makes it a required context).
//
// FAIL reasons, in the order they are checked: missing marker, 2 replay markers, job not success, partial
// rerun, mismatched value, stale base; `evidence unreadable` when GitHub cannot be read (fail closed).
import { execFile } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { parseBaseMarkers, parseReplayMarkers } from './migration-marker.mjs'

const REPO = 'cheese-work/doop'
const CI_PATH = '.github/workflows/ci.yml'
const SHA = /^[0-9a-f]{40}$/
const SHARD = /^test \(\d+\)$/

class Fail extends Error {}
const fail = (reason) => {
  throw new Fail(reason)
}

// All markers of one kind in a log must agree; returns that marker, or fails when there is none.
function only(markers, missing, field) {
  if (markers.length === 0) fail(`missing marker: ${missing}`)
  for (const m of markers.slice(1))
    if (JSON.stringify(m) !== JSON.stringify(markers[0]))
      fail(`mismatched value: two ${field} markers in one log differ`)
  return markers[0]
}

// `api` is injectable: { branchTip(), prHead(pr), runs(head), jobs(runId, attempt), log(jobId) }; runs and jobs
// return the raw GitHub JSON (`{ workflow_runs }`, `{ jobs }`), log returns text.
export async function mergeProof({ pr, api }) {
  try {
    await prove(pr, api)
    return { ok: true, line: 'merge-proof PASS' }
  } catch (e) {
    if (e instanceof Fail) return { ok: false, line: `merge-proof FAIL ${e.message}` }
    return { ok: false, line: `merge-proof FAIL evidence unreadable: ${e.message}` }
  }
}

async function prove(pr, api) {
  // 1. tip T and PR head H
  const T = await api.branchTip()
  const H = await api.prHead(pr)
  if (!SHA.test(T ?? '') || !SHA.test(H ?? '')) throw new Error('cheese/main tip or PR head is not a commit sha')

  // 2. newest ci.yml pull_request run for H; its latest attempt A
  const runs = ((await api.runs(H)).workflow_runs ?? [])
    .filter((r) => r.path === CI_PATH && r.event === 'pull_request' && r.head_sha === H)
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)) || b.id - a.id)
  if (runs.length === 0) fail(`missing marker: no ci run for head ${H}`)
  const A = String(runs[0].run_attempt)

  // 3. jobs of attempt A
  const jobs = (await api.jobs(runs[0].id, runs[0].run_attempt)).jobs ?? []
  const lint = jobs.find((j) => j.name === 'lint')
  const tests = jobs.find((j) => j.name === 'tests')
  const shards = jobs.filter((j) => SHARD.test(j.name))
  if (!lint) fail('missing marker: no lint job in the attempt')
  if (!tests) fail('job not success: no tests job in the attempt')
  for (const j of [lint, tests])
    if (j.conclusion !== 'success') fail(`job not success: ${j.name} is ${j.conclusion ?? 'not finished'}`)

  // 4. evidence: lint log, the one replay shard, the tests aggregate
  const lintLog = await api.log(lint.id)
  const lintBase = only(parseBaseMarkers(lintLog), 'migration-base in the lint log', 'migration-base')
  if (!lintLog.includes('migration-ledger-check OK')) fail('missing marker: migration-ledger-check OK in the lint log')

  const withReplay = []
  for (const s of shards) {
    const log = await api.log(s.id)
    const replay = parseReplayMarkers(log)
    if (replay.length > 0) withReplay.push({ job: s, log, replay })
  }
  if (withReplay.length === 0) fail('missing marker: migration-replay OK in no test (N) log')
  if (withReplay.length > 1)
    fail(`${withReplay.length} replay markers: ${withReplay.map((w) => w.job.name).join(', ')}`)
  const { job: shard, log: shardLog, replay } = withReplay[0]
  const shardBase = only(
    parseBaseMarkers(shardLog),
    `migration-base in the replay shard ${shard.name}`,
    'migration-base',
  )
  const replayMarker = only(replay, 'migration-replay OK', 'migration-replay')
  if (shard.conclusion !== 'success') fail(`job not success: ${shard.name} is ${shard.conclusion ?? 'not finished'}`)

  // every evidence job and marker must come from attempt A
  const attempts = [
    ['lint job', lint.run_attempt],
    ['replay shard job', shard.run_attempt],
    ['tests job', tests.run_attempt],
    ['lint marker', lintBase.runAttempt],
    ['replay shard marker', shardBase.runAttempt],
    ['replay marker', replayMarker.runAttempt],
  ]
  const off = attempts.filter(([, a]) => String(a) !== A)
  if (off.length > 0)
    fail(`partial rerun: ${off.map(([n, a]) => `${n} attempt ${a}`).join(', ')}, expected attempt ${A}`)

  // 5. all markers agree, and agree with T and H
  for (const field of ['candidate', 'base', 'prHead']) {
    const values = [lintBase[field], shardBase[field], replayMarker[field]]
    if (new Set(values).size > 1)
      fail(`mismatched value: ${field} differs (lint ${values[0]}, replay shard ${values[1]}, replay ${values[2]})`)
  }
  if (lintBase.prHead !== H) fail(`mismatched value: pr_head ${lintBase.prHead} is not the current head ${H}`)
  for (const [name, m] of [
    ['lint', lintBase],
    ['replay shard', shardBase],
  ]) {
    if (m.event !== 'pull_request')
      fail(`mismatched value: event in the ${name} marker is ${m.event}, expected pull_request`)
    if (m.mergedHead !== H)
      fail(`mismatched value: merged_head in the ${name} marker is ${m.mergedHead}, expected ${H}`)
  }
  if (lintBase.base !== T) fail(`stale base: markers carry base ${lintBase.base}, cheese/main tip is ${T}`)
}

// ---- CLI ----
const run = promisify(execFile)
const gh = async (args) => (await run('gh', args, { maxBuffer: 256 * 1024 * 1024 })).stdout
const ghJson = async (path) => JSON.parse(await gh(['api', path]))

const realApi = {
  branchTip: async () => (await gh(['api', `repos/${REPO}/branches/cheese%2Fmain`, '--jq', '.commit.sha'])).trim(),
  prHead: async (pr) =>
    (await gh(['pr', 'view', String(pr), '--repo', REPO, '--json', 'headRefOid', '--jq', '.headRefOid'])).trim(),
  runs: (head) => ghJson(`repos/${REPO}/actions/runs?event=pull_request&head_sha=${head}&per_page=100`),
  jobs: (runId, attempt) => ghJson(`repos/${REPO}/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100`),
  log: (jobId) => gh(['api', `repos/${REPO}/actions/jobs/${jobId}/logs`]),
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const pr = process.argv[2]
  if (!/^[1-9]\d*$/.test(pr ?? '')) {
    console.log('merge-proof FAIL evidence unreadable: usage: merge-proof.mjs <pr number>')
    process.exit(1)
  }
  mergeProof({ pr, api: realApi }).then(({ ok, line }) => {
    console.log(line)
    process.exit(ok ? 0 : 1)
  })
}
