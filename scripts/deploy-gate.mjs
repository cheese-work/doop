// The deploy gate of the doop train (CHE-5544, CHE-5545; plan CHE-5474 C-2, C-4, C-5, C-6, C-10). Called by D2
// (cd-deploy.yml). The switch and the pause are repo variables, passed in env as `${{ vars.X }}`; the suspension
// marker is a file on the C00 host (CHE-9877), so only the C00 jobs read it. Every error path fails closed. Results are { go, skip, reason }: a `skip` is a clean "not now"
// and the run ends green; a result with go=false and skip=false is a refusal, and the CLI exits non-zero so the
// job fails. The CLI at the bottom reads its inputs from env and writes the result to $GITHUB_OUTPUT.
//   decideRun   top of a run, hosted: entry rules, the switch, the pause (it cannot see the host marker)
//   admit       pins the candidate: manifest, D1 run, image label and migration inventory
//   recheckOp   once per C00 operation, on the C00 runner: reads the host marker, checks every fact that can change
// The marker itself is written only by deploy-marker.mjs.
import { spawnSync } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { fileStore, markerFile } from './deploy-marker.mjs'
import { fetchWithRateLimit } from './gh-rate-limit.mjs'
import { inventory } from './migration-inventory.mjs'

const OWNER = 'congvc-dev'
const BRANCH = 'cheese/main'
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

// ---------------------------------------------------------------------------------------------
// A marker that reads clear: the exact shape, so a prefix or a trailing newline is not enough.
const isClear = (m) => typeof m === 'string' && /^clear:[0-9a-f]{32}:[A-Za-z0-9_-]+$/.test(m)
// An App's merge shows as `<slug>[bot]` in merged_by.login (CHE-9781). Each login is matched exactly; `[bot]` is
// never stripped, so another App named like a user stays refused.
const MERGERS = new Set([OWNER, 'congvc-bot-x99', 'congvc-bot-x99[bot]'])
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

// One repo variable: its value, null when it does not exist, undefined when it cannot be read. The reason a
// read failed (status and message) goes to `errors`, so a refusal can say why (CHE-9181).
async function readVar(ghApi, repo, name, errors) {
  try {
    return String((await ghApi(`repos/${repo}/actions/variables/${name}`)).value ?? '')
  } catch (err) {
    if (err?.status === 404) return null
    errors[name] = err?.message ?? String(err)
    return undefined
  }
}

// The switch and the pause through the API: only a token with the Variables permission can do this, and
// `github.token` cannot (CHE-9181). Kept for a caller that has such a token; the workflow passes `vars` in env.
async function readState(ghApi, repo) {
  const errors = {}
  const [sw, paused] = await Promise.all(
    ['DOOP_DEPLOY_TRAIN', 'MAIN_RED_PAUSED'].map((n) => readVar(ghApi, repo, n, errors)),
  )
  return { sw, paused, errors }
}

// The same two facts from env, where the workflow put `${{ vars.X }}`. An unset repo variable reads as an
// empty string, which is "absent" (unset = off). A name the workflow did not pass at all is unreadable.
function stateFromEnv(env) {
  const errors = {}
  const one = (name) => {
    const v = env[name]
    if (v === undefined) {
      errors[name] = `${name} was not passed to the gate in env`
      return undefined
    }
    return v === '' ? null : String(v)
  }
  return { sw: one('DOOP_DEPLOY_TRAIN'), paused: one('MAIN_RED_PAUSED'), errors }
}

// The host marker: its value, null when there is no file, undefined when it cannot be read (the cause goes to
// `errors`). Unreadable is never "clear" and never "absent": the caller refuses.
async function readHostMarker(store, errors) {
  try {
    return await store.read()
  } catch (err) {
    errors[NAMES.marker] = err?.message ?? String(err)
    return undefined
  }
}

// A fact this decision needs that could not be read is a refusal, never a skip: a skip ends the run green and
// hid a broken read for four days (CHE-9181). `need` names the facts: 'sw', 'paused' and, on C00 only, 'marker'.
const NAMES = { sw: 'DOOP_DEPLOY_TRAIN', paused: 'MAIN_RED_PAUSED', marker: 'the deploy marker on the C00 host' }
function unreadable(state, need) {
  const bad = need.filter((k) => state[k] === undefined).map((k) => NAMES[k])
  if (!bad.length) return null
  return refuse(`cannot read ${bad.join(', ')}: ${bad.map((n) => state.errors?.[n] ?? 'unreadable').join('; ')}`)
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

// Who started this attempt, and which mode it asks for: the entry rules, as a mode or a refusal. Used by
// `decideRun` at the top of the run and by `recheckOp` before the arm and the apply, because rerunning
// failed jobs reuses the output of resolve and admit and so skips the first call.
function entryOf({ event, actor, trigger, attempt, inputs = {}, extra }) {
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
  return go({ mode })
}

// `vars` (the switches as the workflow passed them in env) is the normal source at the top of a run;
// `ghApi` is the fallback for a caller that has a token able to read variables. The marker is not read here: this
// runs hosted, and the marker is a file on C00. A train run that finds it not clear skips at `pre-arm` instead.
export async function decideRun({ event, actor, trigger, attempt, inputs = {}, extra, repo, ghApi, vars }) {
  const entered = entryOf({ event, actor, trigger, attempt, inputs, extra })
  if (!entered.go) return entered
  const { mode } = entered

  const state = vars ? stateFromEnv(vars) : await readState(ghApi, repo)
  const want = MODES[mode]
  const blind = unreadable(state, [...(want.sw !== null ? ['sw'] : []), ...(want.pause !== null ? ['paused'] : [])])
  if (blind) return blind
  const problem = switchProblem(mode, state)
  if (problem) return skip(problem)
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
export function admit({ mode, repo, candidate, manifest, run, label, inventorySha }) {
  if (!SHA40.test(candidate ?? '')) return refuse(`candidate is not a full SHA: '${candidate}'`)
  if (manifest?.sha !== candidate) return refuse(`manifest names ${manifest?.sha}, not ${candidate}`)
  if (!DIGEST.test(manifest.digest ?? '')) return refuse(`manifest digest is not a sha256 digest: '${manifest.digest}'`)
  // The image label is read from `manifest.ref`, and D2 deploys `repo@digest`: they must be the same image.
  if (manifest.ref !== `ghcr.io/${repo}@${manifest.digest}`)
    return refuse(`manifest ref '${manifest.ref}' is not ghcr.io/${repo}@${manifest.digest}`)
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
  vars,
  markerStore,
  candidate,
  predecessorDigest,
  running,
  isAncestor,
  firstParent,
  quiescent,
  event,
  actor,
  trigger,
  attempt,
  inputs = {},
}) {
  if (!(mode in MODES)) throw new Error(`unknown mode '${mode}'`)
  if (!OPS.includes(op)) throw new Error(`unknown operation '${op}'`)
  const armed = op !== 'pre-arm'
  const no = armed ? refuse : skip

  // Before a change, this attempt's own entry facts must pass the entry rules again. Confirm and
  // rollback skip this: they must still run on a rerun to undo or confirm what an earlier attempt did.
  if (op === 'pre-arm' || op === 'pre-apply') {
    const entered = entryOf({ event, actor, trigger, attempt, inputs, extra })
    if (!entered.go) return entered
    if (entered.mode !== mode) return refuse(`this run entered as ${entered.mode}, not ${mode}`)
  }

  const q = await quiescent()
  if (!q.ok) return refuse(`migration quiescence not proven: ${q.reason ?? 'unknown'}`)

  // The switch and the pause come from `vars` (env, as the workflow passed `${{ vars.X }}` to this job); the marker
  // is the file on this host. An unreadable marker refuses on every op, rollback included: the run cannot prove
  // it still owns the marker, and the marker it armed is the one thing that keeps the train stopped.
  const state = { ...stateFromEnv(vars ?? {}), marker: undefined }
  state.marker = await readHostMarker(markerStore, state.errors)
  const want = MODES[mode]
  const before = op === 'pre-arm' || op === 'pre-apply'
  const blind = unreadable(state, [
    ...(before && want.sw !== null ? ['sw'] : []),
    ...(before && want.pause !== null ? ['paused'] : []),
    ...(armed || mode === 'train' ? ['marker'] : []),
  ])
  if (blind) return blind
  if (armed) {
    if (!expect) return refuse('no --expect marker value for a post-arm operation')
    if (state.marker !== expect)
      return refuse(`the marker is not this run's own value (${state.marker === null ? 'absent' : 'changed'})`)
  } else if (mode === 'train' && !isClear(state.marker)) {
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
// The real migration quiescence proof (C-8.8): no migrate container running, no doop-migrate session, advisory key
// free, read by `c00.sh quiescence` on this host. Anything but a clean pass (a read that fails, a hang, a missing
// script) is "not proven".
const C00_SH = fileURLToPath(new URL('../deploy/cd/c00.sh', import.meta.url))
export async function c00Quiescent(script = process.env.C00_SH || C00_SH, timeoutMs = 120_000) {
  const r = spawnSync('bash', [script, 'quiescence'], { encoding: 'utf8', timeout: timeoutMs })
  if (r.status === 0) return { ok: true }
  const said = `${r.stderr ?? ''}${r.stdout ?? ''}`.trim().split('\n').filter(Boolean).pop()
  return { ok: false, reason: said || r.error?.message || `c00.sh quiescence exited ${r.status ?? r.signal}` }
}

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
const ghWith = (token) => async (path) => {
  const res = await fetchWithRateLimit(
    () =>
      fetch(`${process.env.GITHUB_API_URL || 'https://api.github.com'}/${path}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
      }),
    { label: path },
  )
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    const why = typeof body?.message === 'string' ? `: ${body.message.slice(0, 200)}` : ''
    throw Object.assign(new Error(`GitHub ${res.status} for ${path}${why}`), { status: res.status })
  }
  return res.json()
}

const gh = (path) => ghWith(process.env.GH_TOKEN)(path)

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
      // `github.token` cannot read Actions variables; the workflow passes them as `${{ vars.X }}`.
      vars: env,
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
    // The label is read from the image the deploy will pull; a manifest ref that differs is refused by admit
    // before the label matters, so it is never pulled.
    const ref = `ghcr.io/${repo}@${manifest.digest}`
    const label = manifest.ref === ref ? dockerLabel(ref) : ''
    return settle(
      admit({
        mode: env.MODE,
        repo,
        candidate: env.CANDIDATE,
        manifest,
        run,
        label,
        inventorySha: env.INVENTORY_SHA ?? (await inventory('server/db/migrations')).sha256,
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
      // The switch and the pause as the workflow passed them; the marker is the file on this C00 host.
      vars: env,
      markerStore: fileStore(markerFile(env)),
      event: env.EVENT,
      actor: env.ACTOR,
      trigger: env.TRIGGER,
      attempt: env.ATTEMPT,
      inputs: { mode: env.INPUT_MODE, schedule_backup: env.INPUT_SCHEDULE_BACKUP },
      candidate: { sha: env.DEPLOY_SHA, digest: String(env.DEPLOY_REF ?? '').split('@')[1] },
      predecessorDigest: env.PREDECESSOR_DIGEST,
      running: () => dockerRunning(),
      isAncestor: gitIsAncestor,
      firstParent: gitFirstParent,
      quiescent: () => c00Quiescent(),
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
