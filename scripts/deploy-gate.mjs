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
// The CLI at the bottom serves D2 (cd-deploy.yml, CHE-5544); the exports `decide` and `recheck` are the
// retired image.yml gate's, kept only until S3a replaces their history walk.
import { spawnSync } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { inventorySha } from './migration-inventory.mjs'

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

// ---------------------------------------------------------------------------------------------
// Deploy train (CHE-5544, plan CHE-5474 C-2, C-4, C-5, C-6). `decideRun` runs at the top of a D2 run
// (cd-deploy.yml): entry rules and the cheap gates. `recheckOp` runs inside the C00 jobs, once per
// operation, and re-reads every fact that can change. `admit` pins the candidate. Results are
// { go, skip, reason }: `skip` is a clean "not now" (the run ends green); a result with go=false and
// skip=false is a refusal, and the CLI exits non-zero so the job fails. Every unknown fails closed.
// The legacy decide/recheck above serve the retired image.yml deploy job and go when S3a removes
// their history walk.
const MERGERS = new Set([OWNER, 'congvc-bot-x99'])
const BOT_LOGIN = 'github-actions[bot]'
const MODES = {
  // The switch and the pause each: required value, or null when the mode ignores it.
  train: { sw: 'on', pause: '' },
  recovery: { sw: null, pause: null },
  drill: { sw: 'off', pause: '' },
}
const OPS = ['pre-arm', 'pre-apply', 'confirm', 'rollback']
const SHA40 = /^[0-9a-f]{40}$/
const DIGEST = /^sha256:[0-9a-f]{64}$/

const go = (extra = {}) => ({ go: true, skip: false, reason: 'ok', ...extra })
const skip = (reason) => ({ go: false, skip: true, reason })
const refuse = (reason) => ({ go: false, skip: false, reason })

// One repo variable: its value, null when it does not exist, undefined when it cannot be read.
async function readVar(ghApi, repo, name) {
  try {
    return String((await ghApi(`repos/${repo}/actions/variables/${name}`)).value ?? '')
  } catch (err) {
    return err?.status === 404 ? null : undefined
  }
}

async function readState(ghApi, repo) {
  const [sw, paused, marker] = await Promise.all(
    ['DOOP_DEPLOY_TRAIN', 'MAIN_RED_PAUSED', 'DOOP_DEPLOY_SUSPENDED'].map((n) => readVar(ghApi, repo, n)),
  )
  return { sw, paused, marker }
}

// The switch and the pause for a mode. Unreadable is never "off", never "clear".
function switchProblem(mode, { sw, paused }) {
  const want = MODES[mode]
  if (want.sw !== null && sw !== want.sw)
    return `DOOP_DEPLOY_TRAIN is ${sw === undefined ? 'unreadable' : `'${sw ?? ''}'`}, ${mode} needs '${want.sw}'`
  if (want.pause !== null && paused !== null && paused !== want.pause) {
    return paused === undefined ? 'MAIN_RED_PAUSED is unreadable' : `MAIN_RED_PAUSED is set: ${paused}`
  }
  return null
}

// Who started this run, and which mode it asks for. Throws nothing: a refusal is a result.
export async function decideRun({ event, actor, trigger, attempt, inputs = {}, extra, repo, ghApi }) {
  const who = lower(trigger || actor)
  let mode
  if (event === 'schedule') mode = 'train'
  else if (event === 'workflow_dispatch') mode = inputs.mode
  else return refuse(`event ${event} may not deploy`)
  if (!(mode in MODES)) return refuse(`unknown mode '${mode}'`)

  if (mode === 'train') {
    if (Number(attempt) !== 1) return refuse('a train run is never rerun: attempt must be 1')
    if (event === 'workflow_dispatch' && !(inputs.schedule_backup === 'true' && who === BOT_LOGIN)) {
      return refuse('a train dispatch needs schedule_backup=true from github-actions[bot]')
    }
  } else {
    if (event !== 'workflow_dispatch') return refuse(`${mode} runs only by dispatch`)
    if (who.endsWith('[bot]') || !logins(extra).has(who))
      return refuse(`${who || 'an unknown login'} may not dispatch ${mode}`)
    if (mode === 'drill') return refuse('drill mode lands in slice S6')
  }

  const state = await readState(ghApi, repo)
  const problem = switchProblem(mode, state)
  if (problem) return skip(problem)
  if (mode === 'train' && !state.marker?.startsWith('clear:')) return skip(markerWords(state.marker))
  return go({ mode })
}

const markerWords = (m) =>
  m === undefined
    ? 'the suspension marker is unreadable'
    : m === null
      ? 'the suspension marker is absent'
      : `the marker is ${m.split(':')[0]}, not clear`

// Pins the candidate (C-6): the manifest, the D1 run, the image label and the migration inventory
// all name the same commit. A red D1 run skips a train run; every other mismatch is a refusal.
export function admit({ mode, candidate, manifest, run, label, inventorySha }) {
  if (!SHA40.test(candidate ?? '')) return refuse(`candidate is not a full SHA: '${candidate}'`)
  if (manifest?.sha !== candidate) return refuse(`manifest names ${manifest?.sha}, not ${candidate}`)
  if (!DIGEST.test(manifest.digest ?? '')) return refuse(`manifest digest is not a sha256 digest: '${manifest.digest}'`)
  if (run?.head_sha !== candidate) return refuse(`the D1 run is for ${run?.head_sha}, not ${candidate}`)
  if (run.conclusion !== 'success') {
    const why = `D1 run concluded '${run.conclusion}' on ${candidate.slice(0, 7)}`
    return mode === 'train' ? skip(why) : refuse(why)
  }
  if (label !== candidate) return refuse(`image label is '${label}', not ${candidate}`)
  if (!inventorySha || manifest.migration_inventory_sha !== inventorySha)
    return refuse('migration inventory differs from the manifest')
  return go({ digest: manifest.digest })
}

// The newest cheese/main commit with a successful D1 push run. `runs` is newest first.
export function pickCandidate(runs) {
  const hit = runs.find((r) => r.event === 'push' && r.conclusion === 'success')
  return hit ? { sha: hit.head_sha, runId: hit.id } : null
}

// One operation of the C-5 table. `expect` is this run's own marker value. Before the arm write
// (`pre-arm`) a "no" is a skip; after it every "no" is a refusal, because the marker already reads
// as suspended and the run must fail loudly.
export async function recheckOp({
  mode,
  op,
  expect,
  repo,
  extra,
  ghApi,
  candidate,
  predecessorDigest,
  running,
  isAncestor,
  firstParent,
  quiescent,
}) {
  if (!(mode in MODES)) throw new Error(`unknown mode '${mode}'`)
  if (!OPS.includes(op)) throw new Error(`unknown operation '${op}'`)
  const armed = op !== 'pre-arm'
  const no = armed ? refuse : skip

  const q = await quiescent()
  if (!q.ok) return refuse(`migration quiescence not proven: ${q.reason ?? 'unknown'}`)

  const state = await readState(ghApi, repo)
  if (armed) {
    if (!expect) return refuse('no --expect marker value for a post-arm operation')
    if (state.marker !== expect)
      return refuse(
        `the marker is not this run's own value (${state.marker === undefined ? 'unreadable' : state.marker === null ? 'absent' : 'changed'})`,
      )
  } else if (mode === 'train' && !state.marker?.startsWith('clear:')) {
    return skip(markerWords(state.marker))
  }

  if (op === 'pre-arm' || op === 'pre-apply') {
    const problem = switchProblem(mode, state)
    if (problem) return no(problem)
  }

  const now = await running()
  if (op === 'confirm') {
    if (now?.digest !== candidate.digest || now.label !== candidate.sha)
      return refuse('C00 does not run the candidate digest and label')
    return go()
  }
  if (op === 'rollback') {
    if (!now?.digest) return refuse('no running container to decide a rollback from')
    const action =
      now.digest === candidate.digest ? 'rollback' : now.digest === predecessorDigest ? 'none' : 'superseded'
    return go({ action })
  }

  // pre-arm and pre-apply: the candidate must be strictly ahead of what C00 runs.
  if (!SHA40.test(now?.label ?? '')) return refuse('the running container has no revision label')
  if (now.label === candidate.sha) return no('the candidate is already the running revision')
  if (!(await isAncestor(now.label, candidate.sha)))
    return refuse(`running ${now.label.slice(0, 7)} is not an ancestor of the candidate`)
  if (op === 'pre-arm') {
    for (const sha of await firstParent(now.label, candidate.sha)) {
      const merger = await mergerOf({ repo, sha, ghApi })
      if (merger.error) return skip(merger.error)
      if (!MERGERS.has(lower(merger.login)) && !logins(extra).has(lower(merger.login))) {
        return skip(`${sha.slice(0, 7)} was merged by ${merger.login}, who is not on the deploy allowlist`)
      }
    }
  }
  return go({ predecessorDigest: now.digest, predecessorSha: now.label })
}

// C00 and git facts for the CLI.
const sh = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts })
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed: ${r.stderr.trim()}`)
  return r.stdout.trim()
}
export const gitIsAncestor = async (a, b, cwd = '.') =>
  spawnSync('git', ['merge-base', '--is-ancestor', a, b], { cwd }).status === 0
export const gitFirstParent = async (from, to, cwd = '.') =>
  sh('git', ['rev-list', '--first-parent', `${from}..${to}`], { cwd })
    .split('\n')
    .filter(Boolean)
// The doop container's image digest and revision label, or null when there is no container.
export async function dockerRunning(container = process.env.C00_CONTAINER || 'doop') {
  const id = spawnSync('docker', ['inspect', '--format', '{{.Image}}', container], { encoding: 'utf8' })
  if (id.status !== 0 || !id.stdout.trim()) return null
  const image = id.stdout.trim()
  const digests = sh('docker', ['image', 'inspect', '--format', '{{range .RepoDigests}}{{println .}}{{end}}', image])
  const label = sh('docker', [
    'image',
    'inspect',
    '--format',
    '{{index .Config.Labels "org.opencontainers.image.revision"}}',
    image,
  ])
  return { digest: /@(sha256:[0-9a-f]{64})$/m.exec(digests)?.[1] ?? '', label }
}

// ---------------------------------------------------------------------------------------------
// CLI for D2: node scripts/deploy-gate.mjs decide | resolve | admit | recheck <mode> --op <op> --expect <v>
// Inputs come from env (never from the command line, never inlined into a workflow script). Results go to
// $GITHUB_OUTPUT. A skip exits 0 with go=false; a refusal, an unreadable fact or any error exits 1.
const gh = async (path) => {
  const res = await fetch(`${process.env.GITHUB_API_URL || 'https://api.github.com'}/${path}`, {
    headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/vnd.github+json' },
  })
  if (!res.ok) throw Object.assign(new Error(`GitHub ${res.status} for ${path}`), { status: res.status })
  return res.json()
}

const emit = (fields) => {
  const flat = Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, String(v ?? '').replace(/[\r\n]+/g, ' ')]))
  console.log(`deploy gate: ${JSON.stringify(flat)}`)
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      Object.entries(flat)
        .map(([k, v]) => `${k}=${v}\n`)
        .join(''),
    )
  }
}
// A refusal throws after its output is written, so the job fails and the reason is in the log.
const settle = (out, fields = {}) => {
  emit({ go: out.go, skip: out.skip, reason: out.reason, ...fields })
  if (!out.go && !out.skip) throw new Error(out.reason)
}

const flag = (args, name) => {
  const i = args.indexOf(name)
  return i < 0 ? undefined : args[i + 1]
}

async function cli(argv, env) {
  const [command, ...rest] = argv
  const repo = env.REPO
  if (command === 'decide') {
    const out = await decideRun({
      event: env.EVENT,
      actor: env.ACTOR,
      trigger: env.TRIGGER,
      attempt: env.ATTEMPT,
      inputs: { mode: env.INPUT_MODE, schedule_backup: env.INPUT_SCHEDULE_BACKUP },
      extra: env.EXTRA,
      repo,
      ghApi: gh,
    })
    return settle(out, { mode: out.mode ?? '' })
  }
  if (command === 'resolve') {
    const runs = (q) =>
      gh(`repos/${repo}/actions/workflows/image.yml/runs?${q}&per_page=50`).then((r) => r.workflow_runs)
    let hit
    if (env.MODE === 'train') hit = pickCandidate(await runs(`branch=${BRANCH}&event=push&status=success`))
    else {
      const sha = env.CANDIDATE_SHA ?? ''
      if (!SHA40.test(sha)) throw new Error(`candidate_sha must be a full SHA, got '${sha}'`)
      const run = (await runs(`branch=${BRANCH}&event=push&head_sha=${sha}`)).find((r) => r.head_sha === sha)
      hit = run ? { sha, runId: run.id } : null
    }
    if (!hit)
      return settle(
        env.MODE === 'train' ? skip('no successful D1 push run on cheese/main') : refuse('no D1 run for the candidate'),
        { candidate: '', run_id: '' },
      )
    return settle(go(), { candidate: hit.sha, run_id: hit.runId })
  }
  if (command === 'admit') {
    const manifest = JSON.parse(readFileSync(env.MANIFEST, 'utf8'))
    // The artifact must come from the run that resolve picked, not from another run.
    if (env.RUN_ID && String(manifest.d1_run_id) !== env.RUN_ID) {
      return settle(refuse(`manifest is from D1 run ${manifest.d1_run_id}, not ${env.RUN_ID}`))
    }
    const run = await gh(`repos/${repo}/actions/runs/${manifest.d1_run_id}`)
    const label = dockerLabel(manifest.ref)
    return settle(
      admit({
        mode: env.MODE,
        candidate: env.CANDIDATE,
        manifest,
        run,
        label,
        inventorySha: env.INVENTORY_SHA ?? inventorySha('.'),
      }),
      {
        digest: manifest.digest,
      },
    )
  }
  if (command === 'recheck') {
    const [mode] = rest
    const op = flag(rest, '--op')
    const out = await recheckOp({
      mode,
      op,
      expect: flag(rest, '--expect'),
      repo,
      extra: env.EXTRA,
      ghApi: gh,
      candidate: { sha: env.DEPLOY_SHA, digest: String(env.DEPLOY_REF ?? '').split('@')[1] },
      predecessorDigest: env.PREDECESSOR_DIGEST,
      running: () => dockerRunning(),
      isAncestor: gitIsAncestor,
      firstParent: gitFirstParent,
      // S4b wires the real proof (container exited, no sessions, advisory lock free). Until then no apply can
      // leave an unproven migration behind, so there is nothing to refuse on.
      quiescent: async () => ({ ok: true }),
    })
    return settle(out, {
      action: out.action ?? '',
      predecessor_digest: out.predecessorDigest ?? '',
      predecessor_sha: out.predecessorSha ?? '',
    })
  }
  throw new Error(`unknown command '${command}'`)
}

// The image's revision label, read by pulling the digest on the hosted runner (D2's admit job has docker).
function dockerLabel(ref) {
  sh('docker', ['pull', '--quiet', ref])
  return sh('docker', [
    'image',
    'inspect',
    '--format',
    '{{index .Config.Labels "org.opencontainers.image.revision"}}',
    ref,
  ])
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  cli(process.argv.slice(2), process.env).catch((err) => {
    console.error(`deploy gate failed closed: ${err.message}`)
    process.exit(1)
  })
}
