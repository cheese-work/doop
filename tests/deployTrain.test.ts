import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  admit,
  c00Quiescent,
  decideRun,
  liftAdmit,
  pickCandidate,
  recheckOp,
  runCreatedEpoch,
  // @ts-expect-error plain .mjs script, no type declarations
} from '../scripts/deploy-gate.mjs'
// @ts-expect-error plain .mjs script, no type declarations
import { buildEvidence } from '../scripts/deploy-evidence.mjs'
// @ts-expect-error plain .mjs script, no type declarations
import { inventory } from '../scripts/migration-inventory.mjs'

/* CHE-5544 (train S2, plan CHE-5474 C-2, C-5, C-6). The decider runs in two places: `decideRun` at the
   top of a D2 run (entry rules and the switch and pause) and `recheckOp` inside the C00 jobs, once per
   operation. Every GitHub read goes through an injected `ghApi`, every C00 or git fact through an
   injected function, so each rule is pinned without a network. CHE-9877: the suspension marker is a file on
   the C00 host, so only `recheckOp` (which runs there) reads it, through an injected `markerStore`; the hosted
   `decideRun` never sees it. */
const REPO = 'cheese-work/doop'
const RUNNING = 'a'.repeat(40)
const MID = 'b'.repeat(40)
const CAND = 'c'.repeat(40)
const D_PRED = 'sha256:' + 'd'.repeat(64)
const D_CAND = 'sha256:' + 'e'.repeat(64)
const D_THIRD = 'sha256:' + 'f'.repeat(64)
const ARMED = 'armed:n1:99:' + CAND
const CLEAR = 'clear:' + '0'.repeat(32) + ':restore'
const CLEAR_LIFT = 'clear:' + '9'.repeat(32) + ':4242'
const BOT = 'github-actions[bot]'

const httpError = (status: number) => Object.assign(new Error(`GitHub ${status}`), { status })
type Vars = { sw?: string | null | Error; paused?: string | null | Error; marker?: string | null | Error }
const val = (v: string | null | Error | undefined, dflt: string | null) => () => {
  const x = v === undefined ? dflt : v
  if (x instanceof Error) throw x
  if (x === null) throw httpError(404)
  return { value: x }
}
/* CHE-9955. The CD deploy runs that are not finished, as the gate lists them: one read per status. `runs` is the
   list GitHub answers with (an Error is a read that fails); a run shows under the status it has. */
type Listed = { id: number; status: string; run_attempt?: number; display_title?: string }
const BUSY_STATUSES = ['queued', 'in_progress', 'waiting', 'requested', 'pending']
const runsPath = (status: string) => `repos/${REPO}/actions/workflows/cd-deploy.yml/runs?status=${status}&per_page=100`
function api(
  vars: Vars,
  mergers: Record<string, string | null> = { [MID]: 'congvc-dev', [CAND]: 'congvc-bot-x99[bot]' },
  runs: Listed[] | Error = [],
) {
  const routes: Record<string, unknown> = {
    [`repos/${REPO}/actions/variables/DOOP_DEPLOY_TRAIN`]: () => val(vars.sw, 'on')(),
    [`repos/${REPO}/actions/variables/MAIN_RED_PAUSED`]: () => val(vars.paused, null)(),
  }
  for (const status of BUSY_STATUSES) {
    routes[runsPath(status)] = () => {
      if (runs instanceof Error) throw runs
      const hit = runs.filter((r) => r.status === status)
      return { total_count: hit.length, workflow_runs: hit }
    }
  }
  let n = 10
  for (const [sha, login] of Object.entries(mergers)) {
    const num = n++
    routes[`repos/${REPO}/commits/${sha}/pulls`] = [{ number: num, merge_commit_sha: sha }]
    routes[`repos/${REPO}/pulls/${num}`] = {
      number: num,
      merged_at: '2026-11-14T00:00:00Z',
      merge_commit_sha: sha,
      base: { ref: 'cheese/main' },
      merged_by: login ? { login } : null,
    }
  }
  return async (path: string) => {
    const v = routes[path]
    if (v === undefined) throw new Error(`unexpected read ${path}`)
    return typeof v === 'function' ? v() : v
  }
}

const entry = (over: Record<string, unknown> = {}) => ({
  runId: '1000',
  event: 'schedule',
  actor: BOT,
  trigger: BOT,
  attempt: '1',
  inputs: {},
  extra: '',
  repo: REPO,
  ghApi: api({}),
  ...over,
})

describe('decideRun: entry rules (C-4, Done when 1)', () => {
  it('a schedule event is a train run', async () => {
    expect(await decideRun(entry())).toMatchObject({ go: true, mode: 'train' })
  })

  it('a bot backup dispatch with schedule_backup=true is a train run', async () => {
    const r = await decideRun(entry({ event: 'workflow_dispatch', inputs: { mode: 'train', schedule_backup: 'true' } }))
    expect(r).toMatchObject({ go: true, mode: 'train' })
  })

  it.each([
    ['schedule_backup=true from a human', { mode: 'train', schedule_backup: 'true' }, 'congvc-dev'],
    ['mode=train by a human', { mode: 'train', schedule_backup: 'false' }, 'congvc-dev'],
    ['mode=train from the bot without schedule_backup', { mode: 'train', schedule_backup: 'false' }, BOT],
    ['an unknown mode', { mode: 'turbo' }, 'congvc-dev'],
  ])('refuses %s', async (_n, inputs, who) => {
    const r = await decideRun(entry({ event: 'workflow_dispatch', inputs, actor: who, trigger: who }))
    expect(r).toMatchObject({ go: false, skip: false })
  })

  it('refuses a rerun (attempt 2) of a train run', async () => {
    expect(await decideRun(entry({ attempt: '2', trigger: 'congvc-dev' }))).toMatchObject({ go: false, skip: false })
  })

  it('a push event deploys nothing', async () => {
    expect(await decideRun(entry({ event: 'push' }))).toMatchObject({ go: false, skip: false })
  })

  it('recovery: an allowlisted login passes, a bot or a stranger is refused', async () => {
    const inputs = { mode: 'recovery' }
    const d = (who: string, extra = '') =>
      decideRun(
        entry({
          event: 'workflow_dispatch',
          inputs,
          actor: who,
          trigger: who,
          extra,
          ghApi: api({ sw: 'off', marker: 'suspended:x' }),
        }),
      )
    expect(await d('congvc-dev')).toMatchObject({ go: true, mode: 'recovery' })
    expect(await d('congvc-bot-x99', 'congvc-bot-x99')).toMatchObject({ go: true, mode: 'recovery' })
    expect(await d(BOT, BOT)).toMatchObject({ go: false, skip: false })
    expect(await d('someone')).toMatchObject({ go: false, skip: false })
  })

  it('recovery rerun: allowed only when the rerun’s triggering actor is allowlisted (C-4)', async () => {
    const rerun = (trigger: string, extra = '') =>
      decideRun(
        entry({
          event: 'workflow_dispatch',
          inputs: { mode: 'recovery' },
          actor: 'congvc-dev',
          trigger,
          attempt: '2',
          extra,
          ghApi: api({ sw: 'off', marker: null }),
        }),
      )
    expect(await rerun('congvc-dev')).toMatchObject({ go: true, mode: 'recovery' })
    expect(await rerun('congvc-bot-x99', 'congvc-bot-x99')).toMatchObject({ go: true })
    expect(await rerun('someone')).toMatchObject({ go: false, skip: false })
    expect(await rerun(BOT)).toMatchObject({ go: false, skip: false })
  })

  it('drill mode is refused until S6', async () => {
    const r = await decideRun(
      entry({ event: 'workflow_dispatch', inputs: { mode: 'drill' }, actor: 'congvc-dev', trigger: 'congvc-dev' }),
    )
    expect(r).toMatchObject({ go: false, skip: false })
  })
})

describe('decideRun: train gates skip (Done when 2)', () => {
  it.each([
    ['switch off', { sw: 'off' }],
    ['switch absent', { sw: null }],
    ['pause set', { paused: 'main red' }],
  ])('%s', async (_n, vars) => {
    expect(await decideRun(entry({ ghApi: api(vars) }))).toMatchObject({ go: false, skip: true })
  })

  // The hosted `resolve` cannot read a file on C00. It never reads the marker; the pre-arm check on C00 does.
  it('never reads the marker', async () => {
    const reads: string[] = []
    const inner = api({})
    const ghApi = async (path: string) => {
      reads.push(path)
      return inner(path)
    }
    expect(await decideRun(entry({ ghApi }))).toMatchObject({ go: true, mode: 'train' })
    expect(reads.some((p) => p.includes('DOOP_DEPLOY_SUSPENDED'))).toBe(false)
  })

  it('recovery ignores the switch, the pause and any marker', async () => {
    const r = await decideRun(
      entry({
        event: 'workflow_dispatch',
        inputs: { mode: 'recovery' },
        actor: 'congvc-dev',
        trigger: 'congvc-dev',
        ghApi: api({ sw: 'off', paused: 'x', marker: null }),
      }),
    )
    expect(r).toMatchObject({ go: true })
  })
})

/* CHE-9181. `github.token` cannot read Actions variables, so the first read of a run takes the switches from env
   (`${{ vars.X }}`). A fact that cannot be read is a refusal, never a skip: a skip ends the run green and hid a
   broken read for four days. */
const forbidden = async () => {
  throw httpError(403)
}
const ENV_VARS = { DOOP_DEPLOY_TRAIN: 'on', MAIN_RED_PAUSED: '' }
// The variables API answers 403 (as `github.token` gets); the run list (`actions: read`) still answers.
const runsOnly = (runs: Listed[] = []) => {
  const inner = api({}, undefined, runs)
  return async (path: string) => (path.includes('/actions/variables/') ? forbidden() : inner(path))
}

describe('decideRun: switches come from env, not the variables API (CHE-9181)', () => {
  it('DOOP_DEPLOY_TRAIN=on in env is a go while the variables API answers 403', async () => {
    const r = await decideRun(entry({ ghApi: runsOnly(), vars: ENV_VARS }))
    expect(r).toMatchObject({ go: true, mode: 'train' })
  })

  it('does not call the variables API at all when env supplies the switches', async () => {
    const reads: string[] = []
    const inner = runsOnly()
    const ghApi = async (path: string) => {
      reads.push(path)
      return inner(path)
    }
    await decideRun(entry({ ghApi, vars: ENV_VARS }))
    expect(reads.filter((p) => p.includes('/actions/variables/'))).toEqual([])
  })

  it.each([
    ['unset switch', { ...ENV_VARS, DOOP_DEPLOY_TRAIN: '' }, 'needs'],
    ['switch off', { ...ENV_VARS, DOOP_DEPLOY_TRAIN: 'off' }, 'needs'],
    ['pause set', { ...ENV_VARS, MAIN_RED_PAUSED: 'main red' }, 'MAIN_RED_PAUSED is set'],
  ])('%s in env is still a clean skip', async (_n, vars, words) => {
    const r = await decideRun(entry({ ghApi: forbidden, vars }))
    expect(r).toMatchObject({ go: false, skip: true })
    expect(r.reason).toContain(words)
  })

  it.each([['DOOP_DEPLOY_TRAIN'], ['MAIN_RED_PAUSED']])('%s missing from env fails red, never a skip', async (name) => {
    const { [name]: _gone, ...vars } = ENV_VARS as Record<string, string>
    const r = await decideRun(entry({ ghApi: forbidden, vars }))
    expect(r).toMatchObject({ go: false, skip: false })
    expect(r.reason).toContain(name)
  })

  it('recovery needs no switch: it is not blocked by a missing one', async () => {
    const r = await decideRun(
      entry({
        event: 'workflow_dispatch',
        inputs: { mode: 'recovery' },
        actor: 'congvc-dev',
        trigger: 'congvc-dev',
        vars: {},
      }),
    )
    expect(r).toMatchObject({ go: true, mode: 'recovery' })
  })

  it.each([
    ['switch', { sw: httpError(403) }, 'DOOP_DEPLOY_TRAIN'],
    ['pause', { paused: httpError(500) }, 'MAIN_RED_PAUSED'],
  ])('an unreadable %s through the API fails red and names the status', async (_n, vars, name) => {
    const r = await decideRun(entry({ ghApi: api(vars) }))
    expect(r).toMatchObject({ go: false, skip: false })
    expect(r.reason).toContain(name)
    expect(r.reason).toMatch(/GitHub (403|500)/)
  })
})

describe('recheckOp: the switch and pause come from env, the marker from the host (CHE-9181, CHE-9877)', () => {
  it('pre-arm reads no repo variable at all: the switch and pause from env, the marker from the host store', async () => {
    const reads: string[] = []
    const inner = api({})
    const ghApi = async (path: string) => {
      reads.push(path)
      return inner(path)
    }
    const r = await ops({}, { ghApi })('pre-arm')
    expect(r).toMatchObject({ go: true })
    expect(reads.length).toBeGreaterThan(0)
    expect(reads.some((p) => p.includes('/actions/variables/'))).toBe(false)
  })

  it.each([['DOOP_DEPLOY_TRAIN'], ['MAIN_RED_PAUSED']])(
    'pre-arm: %s missing from env refuses, never skips',
    async (name) => {
      const { [name]: _gone, ...vars } = { DOOP_DEPLOY_TRAIN: 'on', MAIN_RED_PAUSED: '' } as Record<string, string>
      const r = await ops({}, { vars })('pre-arm')
      expect(r).toMatchObject({ go: false, skip: false })
      expect(r.reason).toContain(name)
    },
  )

  // Unreadable means suspended: the train stops, and the run says why instead of ending green.
  it.each([['pre-arm'], ['pre-apply'], ['confirm'], ['rollback']])(
    '%s: an unreadable host marker refuses and names the cause',
    async (op) => {
      const r = await ops({ marker: new Error('EACCES: permission denied') }, {})(op, ARMED, {
        running: async () => ({ digest: D_CAND, label: CAND }),
      })
      expect(r).toMatchObject({ go: false, skip: false })
      expect(r.reason).toContain('EACCES')
    },
  )

  it.each([
    ['absent', null],
    ['suspended', 'suspended:n2:1:' + CAND + ':x'],
    ['armed by another run', 'armed:n2:1:' + CAND],
    ['garbage', 'ok'],
    ['clear without a nonce', 'clear:n0:restore'],
    ['clear with a trailing line', CLEAR + '\nx'],
  ])('pre-arm: a %s host marker is a clean skip, the run does not change C00', async (_n, marker) => {
    expect(await ops({ marker })('pre-arm')).toMatchObject({ go: false, skip: true })
  })

  it('pre-arm: a clear host marker (restore or lift) lets the train go', async () => {
    expect(await ops({ marker: CLEAR })('pre-arm')).toMatchObject({ go: true })
    expect(await ops({ marker: CLEAR_LIFT })('pre-arm')).toMatchObject({ go: true })
  })

  it('rollback still needs this run’s own --expect value', async () => {
    expect(await ops({})('rollback', undefined)).toMatchObject({ go: false, skip: false })
  })
})

describe('deploy-gate CLI decide (CHE-9181)', () => {
  const run = async (env: Record<string, string>, status: number) => {
    const server = createServer((req, res) => {
      res.setHeader('content-type', 'application/json')
      // `github.token` lists the workflow's runs (`actions: read`); only the variables answer `status`.
      if (req.url?.includes('/actions/workflows/'))
        return void res.end(JSON.stringify({ total_count: 0, workflow_runs: [] }))
      res.statusCode = status
      res.end(JSON.stringify({ message: 'Resource not accessible by integration' }))
    })
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok))
    const { port } = server.address() as { port: number }
    try {
      return await new Promise<{ code: number | null; out: string }>((done) => {
        const child = spawn('node', ['scripts/deploy-gate.mjs', 'decide'], {
          env: {
            PATH: process.env.PATH ?? '',
            GITHUB_API_URL: `http://127.0.0.1:${port}`,
            GH_TOKEN: 'github-token-without-variables',
            REPO,
            EVENT: 'schedule',
            ACTOR: BOT,
            TRIGGER: BOT,
            ATTEMPT: '1',
            RUN_ID: '1000',
            ...env,
          },
        })
        let out = ''
        child.stdout.on('data', (d) => (out += d))
        child.stderr.on('data', (d) => (out += d))
        child.on('close', (code) => done({ code, out }))
      })
    } finally {
      server.close()
    }
  }

  it('DOOP_DEPLOY_TRAIN=on in env with the variables API returning 403: go', async () => {
    const r = await run(ENV_VARS, 403)
    expect(r.code).toBe(0)
    expect(r.out).toContain('"go":"true"')
  })

  it('a switch the workflow did not pass exits non-zero', async () => {
    const { DOOP_DEPLOY_TRAIN: _t, ...rest } = ENV_VARS
    const r = await run(rest, 403)
    expect(r.code).not.toBe(0)
    expect(r.out).toContain('DOOP_DEPLOY_TRAIN')
  })
})

describe('train reads the marker only, no run history (C-10.4, S3a)', () => {
  it('the gate script carries no history walk and no legacy decider', async () => {
    // @ts-expect-error plain .mjs script, no type declarations
    const gate = (await import('../scripts/deploy-gate.mjs')) as Record<string, unknown>
    expect(Object.keys(gate)).not.toContain('decide')
    expect(Object.keys(gate)).not.toContain('recheck')
    const { readFileSync } = await import('node:fs')
    const text = readFileSync('scripts/deploy-gate.mjs', 'utf8')
    for (const gone of [
      'MAX_AGE',
      'MAX_PAGES',
      'LAG',
      'suspendedBy',
      'workflows/image.yml/runs?branch=${BRANCH}&per_page',
    ]) {
      expect(text, gone).not.toContain(gone)
    }
  })

  // CHE-9955: the one run read is the busy check's list of unfinished CD deploy runs, in `decideRun`. No run of D1 or
  // of an earlier D2 decides anything, and `recheckOp` reads no run at all.
  it('a train run reads no run history to decide, only the unfinished CD deploy runs', async () => {
    const reads: string[] = []
    const inner = api({})
    const ghApi = async (path: string) => {
      reads.push(path)
      return inner(path)
    }
    expect(await decideRun(entry({ ghApi }))).toMatchObject({ go: true })
    const decided = reads.splice(0)
    expect(await ops({}, { ghApi })('pre-arm')).toMatchObject({ go: true })
    expect(reads.filter((p) => p.includes('/runs'))).toEqual([])
    expect(decided.filter((p) => p.includes('/runs'))).toEqual(BUSY_STATUSES.map(runsPath))
    expect(decided.filter((p) => p.includes('/actions/runs'))).toEqual([])
  })
})

describe('pickCandidate (C-2 resolve)', () => {
  const run = (id: number, sha: string, conclusion: string | null, event = 'push') => ({
    id,
    head_sha: sha,
    conclusion,
    event,
  })
  it('takes the newest commit with a successful D1 push run', () => {
    expect(pickCandidate([run(3, CAND, 'failure'), run(2, MID, 'success'), run(1, RUNNING, 'success')])).toEqual({
      sha: MID,
      runId: 2,
    })
  })
  it('ignores runs still going and non-push runs; none means null', () => {
    expect(pickCandidate([run(3, CAND, null), run(2, MID, 'success', 'workflow_dispatch')])).toBeNull()
    expect(pickCandidate([])).toBeNull()
  })
})

const goodAdmit = (over: Record<string, unknown> = {}) => ({
  mode: 'train',
  repo: REPO,
  candidate: CAND,
  manifest: {
    sha: CAND,
    digest: D_CAND,
    ref: `ghcr.io/${REPO}@${D_CAND}`,
    migration_inventory_sha: 'i'.repeat(64),
    d1_run_id: '5',
  },
  run: { conclusion: 'success', head_sha: CAND },
  label: CAND,
  inventorySha: 'i'.repeat(64),
  ...over,
})

describe('admit: the pin (C-6, Done when 11)', () => {
  it('passes when manifest, run, label and inventory all name the candidate', () => {
    expect(admit(goodAdmit())).toMatchObject({ go: true, digest: D_CAND })
  })
  it.each([
    ['manifest SHA', { manifest: { sha: MID, digest: D_CAND, migration_inventory_sha: 'i'.repeat(64) } }],
    ['manifest digest', { manifest: { sha: CAND, digest: 'latest', migration_inventory_sha: 'i'.repeat(64) } }],
    [
      'manifest ref digest (the label would be read from another image)',
      {
        manifest: {
          sha: CAND,
          digest: D_CAND,
          ref: `ghcr.io/${REPO}@${D_PRED}`,
          migration_inventory_sha: 'i'.repeat(64),
        },
      },
    ],
    [
      'manifest ref repository',
      {
        manifest: {
          sha: CAND,
          digest: D_CAND,
          ref: `ghcr.io/other/doop@${D_CAND}`,
          migration_inventory_sha: 'i'.repeat(64),
        },
      },
    ],
    ['manifest ref missing', { manifest: { sha: CAND, digest: D_CAND, migration_inventory_sha: 'i'.repeat(64) } }],
    ['inventory sha', { inventorySha: 'j'.repeat(64) }],
    ['image label', { label: MID }],
    ['run head sha', { run: { conclusion: 'success', head_sha: MID } }],
  ])('refuses a %s mismatch', (_n, over) => {
    expect(admit(goodAdmit(over))).toMatchObject({ go: false, skip: false })
  })
  it('red CI on the candidate skips a train run and refuses recovery', () => {
    const run = { conclusion: 'failure', head_sha: CAND }
    expect(admit(goodAdmit({ run }))).toMatchObject({ go: false, skip: true })
    expect(admit(goodAdmit({ run, mode: 'recovery' }))).toMatchObject({ go: false, skip: false })
  })
})

const cand = { sha: CAND, digest: D_CAND }
/* A recovery or drill run enters by dispatch from an allowlisted human. */
const dispatched = (mode: string) => ({
  event: 'workflow_dispatch',
  actor: 'congvc-dev',
  trigger: 'congvc-dev',
  inputs: { mode },
})
function ops(vars: Vars = {}, over: Record<string, unknown> = {}) {
  const base = {
    mode: 'train',
    repo: REPO,
    extra: '',
    candidate: cand,
    predecessorDigest: D_PRED,
    // The run's entry facts, revalidated on this attempt (a rerun reuses resolve and admit).
    event: 'schedule',
    actor: BOT,
    trigger: BOT,
    attempt: '1',
    inputs: {},
    ghApi: api({}),
    // Seconds since the job took its `vars` snapshot (the first step stamps VARS_READ_EPOCH).
    varsAgeSeconds: 5,
    // `${{ vars.X }}` as the workflow passes them; an Error means the workflow did not pass the name at all.
    vars: {
      ...(vars.sw instanceof Error ? {} : { DOOP_DEPLOY_TRAIN: vars.sw === undefined ? 'on' : (vars.sw ?? '') }),
      ...(vars.paused instanceof Error ? {} : { MAIN_RED_PAUSED: vars.paused ?? '' }),
    },
    // The host file, read lazily so a test can change `vars.marker` between operations.
    markerStore: {
      read: async () => {
        const m = vars.marker === undefined ? CLEAR : vars.marker
        if (m instanceof Error) throw m
        return m
      },
    },
    running: async () => ({ digest: D_PRED, label: RUNNING }),
    isAncestor: async (a: string, b: string) => a === RUNNING && b === CAND,
    firstParent: async () => [MID, CAND],
    quiescent: async () => ({ ok: true }),
  }
  return (op: string, expect_?: string, more: Record<string, unknown> = {}) =>
    recheckOp({ ...base, ...over, ...more, op, expect: expect_ })
}

describe('recheckOp pre-arm (deploy step 1)', () => {
  it('passes on clear with the candidate strictly ahead and allowed mergers', async () => {
    expect(await ops()('pre-arm')).toMatchObject({ go: true })
  })
  it('reports the running digest and label for the later jobs', async () => {
    expect(await ops()('pre-arm')).toMatchObject({ predecessorDigest: D_PRED, predecessorSha: RUNNING })
  })
  it('skips the same revision', async () => {
    const r = await ops()('pre-arm', undefined, { running: async () => ({ digest: D_CAND, label: CAND }) })
    expect(r).toMatchObject({ go: false, skip: true })
  })
  it('skips when a non-allowed login merged a commit in running..candidate', async () => {
    const r = await ops({}, { ghApi: api({}, { [MID]: 'stranger', [CAND]: 'congvc-dev' }) })('pre-arm')
    expect(r).toMatchObject({ go: false, skip: true })
  })
  // GitHub reports an App's merge as `<slug>[bot]` (CHE-9781). Only the exact trusted login is admitted.
  it('admits the agent merger congvc-bot-x99[bot]', async () => {
    const r = await ops(
      {},
      { ghApi: api({}, { [MID]: 'congvc-bot-x99[bot]', [CAND]: 'congvc-bot-x99[bot]' }) },
    )('pre-arm')
    expect(r).toMatchObject({ go: true })
  })
  it.each(['other-app[bot]', 'congvc-bot-x99-evil[bot]', 'congvc-dev[bot]'])('skips a merge by %s', async (login) => {
    const r = await ops({}, { ghApi: api({}, { [MID]: 'congvc-dev', [CAND]: login }) })('pre-arm')
    expect(r).toMatchObject({ go: false, skip: true })
  })
  it.each([
    ['armed by another run', { marker: 'armed:n2:1:' + CAND }],
    ['suspended', { marker: 'suspended:n2:1:' + CAND + ':x' }],
    ['absent', { marker: null }],
    ['switch off', { sw: 'off' }],
    ['pause set', { paused: 'red' }],
  ])('skips when the marker/switch says no: %s (a run queued before a suspension stops here)', async (_n, vars) => {
    expect(await ops(vars)('pre-arm')).toMatchObject({ go: false, skip: true })
  })
  it('refuses a missing or non-ancestor running label', async () => {
    expect(await ops()('pre-arm', undefined, { running: async () => ({ digest: D_PRED, label: '' }) })).toMatchObject({
      go: false,
      skip: false,
    })
    expect(await ops()('pre-arm', undefined, { isAncestor: async () => false })).toMatchObject({
      go: false,
      skip: false,
    })
  })
  it('recovery pre-arm ignores marker, switch and pause', async () => {
    const r = await ops(
      { sw: 'off', paused: 'x', marker: 'suspended:z' },
      { mode: 'recovery', ...dispatched('recovery') },
    )('pre-arm')
    expect(r).toMatchObject({ go: true })
  })
})

describe('recheckOp revalidates the entry on this attempt (Done when 1, rerun of failed jobs)', () => {
  it.each(['pre-arm', 'pre-apply'])(
    '%s refuses a train rerun (attempt 2) that reuses resolve and admit',
    async (op) => {
      const vars: Vars = { marker: op === 'pre-arm' ? 'clear:n0:restore' : ARMED }
      const r = await ops(vars)(op, ARMED, { attempt: '2', trigger: 'congvc-dev' })
      expect(r).toMatchObject({ go: false, skip: false })
    },
  )
  it.each(['pre-arm', 'pre-apply'])('%s refuses a push event', async (op) => {
    const vars: Vars = { marker: op === 'pre-arm' ? 'clear:n0:restore' : ARMED }
    expect(await ops(vars)(op, ARMED, { event: 'push' })).toMatchObject({ go: false, skip: false })
  })
  it('pre-arm refuses a train dispatch by a human, and recovery by a stranger or a bot', async () => {
    const d = { event: 'workflow_dispatch', actor: 'congvc-dev', trigger: 'congvc-dev' }
    const op = ops({ marker: 'clear:n0:restore' })
    expect(await op('pre-arm', undefined, { ...d, inputs: { mode: 'train' } })).toMatchObject({
      go: false,
      skip: false,
    })
    const rec = { ...d, inputs: { mode: 'recovery' } }
    expect(await op('pre-arm', undefined, { ...rec, mode: 'recovery', trigger: 'someone' })).toMatchObject({
      go: false,
      skip: false,
    })
    expect(await op('pre-arm', undefined, { ...rec, mode: 'recovery' })).toMatchObject({ go: true })
  })
  it('the mode the run entered with must be the mode being checked', async () => {
    const r = await ops({ marker: 'clear:n0:restore' })('pre-arm', undefined, {
      event: 'workflow_dispatch',
      actor: 'congvc-dev',
      trigger: 'congvc-dev',
      inputs: { mode: 'recovery' },
    })
    expect(r).toMatchObject({ go: false, skip: false })
  })
  it('confirm and rollback do not need the entry (they must still run on a rerun)', async () => {
    expect(await ops({ marker: ARMED })('rollback', ARMED, { attempt: '2' })).toMatchObject({ go: true })
  })
})

describe('recheckOp: the switch and pause snapshot is bounded in age (CHE-9877 review P1-2)', () => {
  // `vars.*` is taken when the job starts. A job that waited for the host lock past the bound must not act on it.
  it('pre-apply refuses a snapshot older than the bound, so a switch-off or pause set after job start stops it', async () => {
    const r = await ops({ marker: ARMED })('pre-apply', ARMED, { varsAgeSeconds: 600 })
    expect(r).toMatchObject({ go: false, skip: false })
    expect(r.reason).toMatch(/snapshot/)
  })
  it('pre-arm: a stale snapshot is a clean skip (nothing was changed yet)', async () => {
    expect(await ops()('pre-arm', undefined, { varsAgeSeconds: 600 })).toMatchObject({ go: false, skip: true })
  })
  it('the bound is configurable and inclusive', async () => {
    const at = { varsAgeSeconds: 60, varsMaxAgeSeconds: 60 }
    expect(await ops({ marker: ARMED })('pre-apply', ARMED, at)).toMatchObject({ go: true })
    expect(await ops({ marker: ARMED })('pre-apply', ARMED, { ...at, varsAgeSeconds: 61 })).toMatchObject({ go: false })
  })
  it.each([[undefined], [NaN], [-1], ['soon']])('an unknown or invalid age (%s) fails closed', async (age) => {
    const r = await ops({ marker: ARMED })('pre-apply', ARMED, { varsAgeSeconds: age })
    expect(r).toMatchObject({ go: false, skip: false })
    expect(r.reason).toMatch(/snapshot/)
    expect(await ops()('pre-arm', undefined, { varsAgeSeconds: age })).toMatchObject({ go: false, skip: true })
  })
  describe('the age is read again after the blocking reads (sol re-review P1)', () => {
    // A fake clock: the snapshot is 179 s old when the check starts, and each blocking read below spends time.
    const clocked = (spend: 'quiescent' | 'running' | 'firstParent' | 'isAncestor', by: number, start = 179) => {
      let age = start
      const tick =
        <T>(v: T) =>
        async () => {
          age += by
          return v
        }
      const over: Record<string, unknown> = { varsAgeSeconds: () => age }
      if (spend === 'quiescent') over.quiescent = tick({ ok: true })
      if (spend === 'running') over.running = tick({ digest: D_PRED, label: RUNNING })
      if (spend === 'firstParent') over.firstParent = tick([MID, CAND])
      if (spend === 'isAncestor')
        over.isAncestor = async (a: string, b: string) => ((age += by), a === RUNNING && b === CAND)
      return { over, now: () => age }
    }
    it.each(['quiescent', 'running', 'isAncestor'] as const)(
      'pre-apply refuses when %s pushes a 179 s snapshot past 180 s',
      async (spend) => {
        const { over } = clocked(spend, 2)
        const r = await ops({ marker: ARMED })('pre-apply', ARMED, over)
        expect(r).toMatchObject({ go: false, skip: false })
        expect(r.reason).toMatch(/snapshot is 181s old/)
      },
    )
    it.each(['quiescent', 'running', 'firstParent', 'isAncestor'] as const)(
      'pre-arm skips when %s pushes a 179 s snapshot past 180 s (nothing was armed)',
      async (spend) => {
        const { over } = clocked(spend, 2)
        expect(await ops()('pre-arm', undefined, over)).toMatchObject({ go: false, skip: true })
      },
    )
    it('a 120 s quiescence on a 179 s snapshot refuses (the quiescence timeout is longer than the headroom)', async () => {
      const { over } = clocked('quiescent', 120)
      expect(await ops({ marker: ARMED })('pre-apply', ARMED, over)).toMatchObject({ go: false, skip: false })
    })
    it('still passes when the reads stay inside the bound (the age at the go is 180 s, inclusive)', async () => {
      const { over, now } = clocked('quiescent', 1)
      expect(await ops({ marker: ARMED })('pre-apply', ARMED, over)).toMatchObject({ go: true })
      expect(now()).toBe(180)
    })
    it('the age is read after the last blocking read, not before', async () => {
      const seen: string[] = []
      const over = {
        varsAgeSeconds: () => (seen.push('age'), 1),
        quiescent: async () => (seen.push('quiescent'), { ok: true }),
        running: async () => (seen.push('running'), { digest: D_PRED, label: RUNNING }),
        isAncestor: async () => (seen.push('isAncestor'), true),
      }
      await ops({ marker: ARMED })('pre-apply', ARMED, over)
      expect(seen[seen.length - 1]).toBe('age')
      expect(seen.lastIndexOf('age')).toBeGreaterThan(seen.indexOf('isAncestor'))
    })
  })
  it('recovery does not read the switch or pause, so its snapshot age is ignored', async () => {
    const own = 'suspended:n5:7:' + CAND + ':recovery'
    const rec = { mode: 'recovery', ...dispatched('recovery'), varsAgeSeconds: undefined }
    expect(await ops({ marker: own }, rec)('pre-apply', own)).toMatchObject({ go: true })
  })
  it('confirm and rollback ignore the snapshot age (they must still run after a long wait)', async () => {
    const run = { running: async () => ({ digest: D_CAND, label: CAND }), varsAgeSeconds: 99999 }
    expect(await ops({ marker: ARMED })('confirm', ARMED, run)).toMatchObject({ go: true })
    expect(await ops({ marker: ARMED })('rollback', ARMED, run)).toMatchObject({ go: true })
  })
  it('a switch turned off or a pause set while the job waited stops pre-apply (fresh snapshot after a rerun)', async () => {
    expect(await ops({ marker: ARMED, sw: 'off' })('pre-apply', ARMED, { varsAgeSeconds: 1 })).toMatchObject({
      go: false,
      skip: false,
    })
    expect(await ops({ marker: ARMED, paused: 'red' })('pre-apply', ARMED, { varsAgeSeconds: 1 })).toMatchObject({
      go: false,
      skip: false,
    })
  })
})

describe('runCreatedEpoch: the snapshot age starts at the original run record (CHE-9877)', () => {
  const RUN = '2026-11-25T12:28:42Z'
  const run = (over: Record<string, unknown> = {}) => ({
    id: 45614119755,
    created_at: RUN,
    run_started_at: RUN,
    run_attempt: 1,
    ...over,
  })
  const epoch = (t: string) => Date.parse(t) / 1000
  it('returns the run created_at in epoch seconds', () => {
    expect(runCreatedEpoch(run(), '45614119755')).toBe(epoch(RUN))
  })
  it('a rerun keeps the original epoch: only run_started_at moves, not created_at', () => {
    const rerun = run({ run_attempt: 2, run_started_at: '2026-11-25T12:43:00Z' })
    expect(runCreatedEpoch(rerun, '45614119755')).toBe(epoch(RUN))
  })
  it.each([
    ['no created_at', { created_at: undefined }],
    ['an unparseable created_at', { created_at: 'soon' }],
    ['a numeric created_at', { created_at: 1764073722 }],
    ['an empty created_at', { created_at: '' }],
    ['the record of another run', { id: 1 }],
  ])('fails closed on %s', (_n, over) => {
    expect(() => runCreatedEpoch(run(over), '45614119755')).toThrow(/run/)
  })
  it('fails closed on no record at all', () => {
    expect(() => runCreatedEpoch(undefined as never, '1')).toThrow(/run/)
  })
  it('a 400 s delay in resolve and admit, then a new deploy job, is refused by pre-apply and skipped by pre-arm', async () => {
    const created = epoch(RUN)
    const deployJobCreated = created + 400 // resolve + admit took 400 s; the deploy job record is new and fresh
    const stepRuns = deployJobCreated + 9 // the deploy job's first step, 9 s after its own record
    const age = stepRuns + 1 - runCreatedEpoch(run(), '45614119755')
    expect(age).toBeGreaterThan(180)
    const r = await ops({ marker: ARMED })('pre-apply', ARMED, { varsAgeSeconds: () => age })
    expect(r).toMatchObject({ go: false, skip: false })
    expect(r.reason).toMatch(/snapshot is 410s old/)
    expect(await ops()('pre-arm', undefined, { varsAgeSeconds: () => age })).toMatchObject({ go: false, skip: true })
  })
  it('a normal run (deploy job 52 s after the run, as measured) has room for the gate reads', async () => {
    const age = 52 + 9 + 30
    expect(await ops({ marker: ARMED })('pre-apply', ARMED, { varsAgeSeconds: () => age })).toMatchObject({ go: true })
  })
})

describe('recheckOp after the arm write (Done when 3)', () => {
  it('success sequence: clear, pre-arm, arm, pre-apply, apply, confirm with the candidate running', async () => {
    const vars: Vars = { marker: CLEAR }
    let running = { digest: D_PRED, label: RUNNING }
    const op = ops(vars, { running: async () => running })
    expect(await op('pre-arm')).toMatchObject({ go: true })
    vars.marker = ARMED
    expect(await op('pre-apply', ARMED)).toMatchObject({ go: true })
    running = { digest: D_CAND, label: CAND } // apply and readback passed
    expect(await op('confirm', ARMED)).toMatchObject({ go: true })
  })

  it('pre-apply refuses once the candidate is already running', async () => {
    const r = await ops({ marker: ARMED })('pre-apply', ARMED, {
      running: async () => ({ digest: D_CAND, label: CAND }),
    })
    expect(r).toMatchObject({ go: false, skip: false })
  })

  it('failed readback with the candidate running: rollback check passes and says roll back', async () => {
    const r = await ops({ marker: ARMED })('rollback', ARMED, {
      running: async () => ({ digest: D_CAND, label: CAND }),
    })
    expect(r).toMatchObject({ go: true, action: 'rollback' })
  })
  it('rollback when C00 already runs the predecessor changes nothing', async () => {
    expect(await ops({ marker: ARMED })('rollback', ARMED)).toMatchObject({ go: true, action: 'none' })
  })
  it('rollback when C00 runs a third digest is superseded', async () => {
    const r = await ops({ marker: ARMED })('rollback', ARMED, {
      running: async () => ({ digest: D_THIRD, label: MID }),
    })
    expect(r).toMatchObject({ go: true, action: 'superseded' })
  })
  it('rollback with no running container is refused', async () => {
    expect(await ops({ marker: ARMED })('rollback', ARMED, { running: async () => null })).toMatchObject({
      go: false,
      skip: false,
    })
  })

  it.each([
    ['another digest', { digest: D_THIRD, label: CAND }],
    ['another label', { digest: D_CAND, label: MID }],
  ])('confirm refuses when C00 runs %s', async (_n, r) => {
    expect(await ops({ marker: ARMED })('confirm', ARMED, { running: async () => r })).toMatchObject({
      go: false,
      skip: false,
    })
  })

  it('confirm and rollback still run with the pause set or the switch off', async () => {
    const run = { running: async () => ({ digest: D_CAND, label: CAND }) }
    const vars = { marker: ARMED, sw: 'off', paused: 'red' }
    expect(await ops(vars)('confirm', ARMED, run)).toMatchObject({ go: true })
    expect(await ops(vars)('rollback', ARMED, run)).toMatchObject({ go: true })
  })

  it('pre-apply stops when the pause is set or the switch is off after step 1', async () => {
    expect(await ops({ marker: ARMED, paused: 'red' })('pre-apply', ARMED)).toMatchObject({ go: false, skip: false })
    expect(await ops({ marker: ARMED, sw: 'off' })('pre-apply', ARMED)).toMatchObject({ go: false, skip: false })
  })

  it.each(['pre-apply', 'confirm', 'rollback'])("%s refuses any marker that is not this run's own", async (op) => {
    const run = { running: async () => ({ digest: D_CAND, label: CAND }) }
    for (const marker of [
      'armed:n9:2:' + CAND,
      'suspended:n9:2:' + CAND + ':x',
      CLEAR_LIFT,
      ARMED + 'x',
      null,
      new Error('EIO'),
    ]) {
      const r = await ops({ marker }, run)(op, ARMED)
      expect(r, String(marker)).toMatchObject({ go: false, skip: false })
    }
  })

  it('an empty --expect never matches', async () => {
    expect(await ops({ marker: '' })('confirm', '')).toMatchObject({ go: false, skip: false })
    expect(await ops({ marker: ARMED })('confirm', undefined)).toMatchObject({ go: false, skip: false })
  })

  // Drill cannot enter until S6 (the entry rules refuse it), so only recovery reaches these checks now.
  it('recovery passes only with its own suspended value', async () => {
    const own = 'suspended:n5:7:' + CAND + ':recovery'
    for (const mode of ['recovery']) {
      const base = { mode, ...dispatched(mode), running: async () => ({ digest: D_PRED, label: RUNNING }) }
      const sw = mode === 'drill' ? 'off' : 'on'
      expect(await ops({ marker: own, sw }, base)('pre-apply', own)).toMatchObject({ go: true })
      expect(await ops({ marker: 'suspended:n6:8:' + CAND + ':recovery', sw }, base)('pre-apply', own)).toMatchObject({
        go: false,
        skip: false,
      })
      expect(await ops({ marker: CLEAR_LIFT, sw }, base)('pre-apply', own)).toMatchObject({
        go: false,
        skip: false,
      })
    }
  })

  it.each(['pre-arm', 'pre-apply', 'confirm', 'rollback'])('%s refuses when quiescence is not proven', async (op) => {
    const r = await ops(
      { marker: op === 'pre-arm' ? CLEAR : ARMED },
      { quiescent: async () => ({ ok: false, reason: 'session left' }) },
    )(op, ARMED)
    expect(r).toMatchObject({ go: false, skip: false })
  })

  it('an unknown operation is refused', async () => {
    await expect(ops()('explode', ARMED)).rejects.toThrow()
  })
})

describe('migration inventory sha (C-8.1, used by the manifest)', () => {
  const make = (files: Record<string, string>) => {
    const root = mkdtempSync(join(tmpdir(), 'inv-'))
    mkdirSync(join(root, 'server/db/migrations/meta'), { recursive: true })
    for (const [name, text] of Object.entries(files)) writeFileSync(join(root, 'server/db/migrations', name), text)
    return root
  }
  it('is stable, and changes with a migration byte, a name or the journal', async () => {
    const a = make({ '0001_a.sql': 'select 1', 'meta/_journal.json': '{}' })
    const same = make({ 'meta/_journal.json': '{}', '0001_a.sql': 'select 1' })
    const byte = make({ '0001_a.sql': 'select 2', 'meta/_journal.json': '{}' })
    const name = make({ '0001_b.sql': 'select 1', 'meta/_journal.json': '{}' })
    const journal = make({ '0001_a.sql': 'select 1', 'meta/_journal.json': '{"v":1}' })
    try {
      const sha = async (root: string) => (await inventory(join(root, 'server/db/migrations'))).sha256
      expect(await sha(a)).toMatch(/^[0-9a-f]{64}$/)
      expect(await sha(same)).toBe(await sha(a))
      for (const other of [byte, name, journal]) expect(await sha(other)).not.toBe(await sha(a))
    } finally {
      for (const d of [a, same, byte, name, journal]) rmSync(d, { recursive: true, force: true })
    }
  })
  it('fails when the journal is missing', async () => {
    const root = make({ '0001_a.sql': 'select 1' })
    try {
      await expect(inventory(join(root, 'server/db/migrations'))).rejects.toThrow()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

/* CHE-5549 review round 1: the gate's quiescence proof is the real one (c00.sh quiescence), not a stub. */
describe('c00Quiescent: the real migration quiescence proof (C-5, C-8.8)', () => {
  const fake = (body: string) => {
    const root = mkdtempSync(join(tmpdir(), 'q-'))
    const sh = join(root, 'c00.sh')
    writeFileSync(sh, `#!/usr/bin/env bash\n${body}\n`)
    chmodSync(sh, 0o755)
    return { root, sh }
  }
  it('is ok when `c00.sh quiescence` passes, and runs exactly that command', async () => {
    const { root, sh } = fake('echo "$1" > "$(dirname "$0")/arg"; exit 0')
    try {
      expect(await c00Quiescent(sh)).toEqual({ ok: true })
      expect(spawnSync('cat', [join(root, 'arg')], { encoding: 'utf8' }).stdout.trim()).toBe('quiescence')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
  it('is not ok, with the reason, when it refuses', async () => {
    const { root, sh } = fake(
      'echo "c00.sh: migration quiescence not proven: live migrate sessions: (5, t)" >&2; exit 1',
    )
    try {
      const q = await c00Quiescent(sh)
      expect(q.ok).toBe(false)
      expect(q.reason).toContain('live migrate sessions')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
  it('is not ok when the script cannot be run', async () => {
    expect((await c00Quiescent('/nonexistent/c00.sh')).ok).toBe(false)
  })
  it('is not ok when it hangs past the bound', async () => {
    const { root, sh } = fake('sleep 5')
    try {
      expect((await c00Quiescent(sh, 200)).ok).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('deploy-gate CLI', () => {
  it('recheck refuses on unproven quiescence before it reads anything else', () => {
    const { root, sh } = (() => {
      const root = mkdtempSync(join(tmpdir(), 'q-'))
      const sh = join(root, 'c00.sh')
      writeFileSync(sh, '#!/usr/bin/env bash\necho "live migrate sessions" >&2\nexit 1\n')
      chmodSync(sh, 0o755)
      return { root, sh }
    })()
    try {
      const r = spawnSync('node', ['scripts/deploy-gate.mjs', 'recheck', 'train', '--op', 'confirm', '--expect', 'x'], {
        encoding: 'utf8',
        env: { PATH: process.env.PATH, C00_SH: sh, REPO: 'cheese-work/doop' },
      })
      expect(r.status).not.toBe(0)
      expect(r.stderr + r.stdout).toMatch(/quiescence not proven: .*live migrate sessions/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
  it('refuses an unknown operation with a non-zero exit', () => {
    const r = spawnSync('node', ['scripts/deploy-gate.mjs', 'recheck', 'train', '--op', 'explode'], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH },
    })
    expect(r.status).not.toBe(0)
  })
})

/* CHE-9955 (CHE-9850 S1). One C00 job runs at a time, and a CD deploy run is one unit of work: a train, a recovery or
   a lift (a run with mode lift). `decideRun` skips a train run while an older CD deploy run is unfinished, so the
   later run never joins the C00 group behind it; `liftAdmit` is the same check for a lift. The order is the run id:
   of two runs, the older goes first, so the two never wait on each other. A list that cannot be read is a refusal,
   never "not busy". A rerun is refused as before (attempt must be 1), before any list is read. */
const train = (over: Record<string, unknown> = {}) => entry({ vars: ENV_VARS, ...over })
const reading = (runs: Listed[] | Error) => {
  const reads: string[] = []
  const inner = api({}, undefined, runs)
  const ghApi = async (path: string) => {
    reads.push(path)
    return inner(path)
  }
  return { ghApi, reads }
}

describe('decideRun: busy check across CD deploy and CD lift (CHE-9955)', () => {
  it.each(BUSY_STATUSES)('skips as busy while an older CD deploy run is %s', async (status) => {
    const r = await decideRun(train({ ghApi: api({}, undefined, [{ id: 900, status }]) }))
    expect(r).toMatchObject({ go: false, skip: true, skipReason: 'busy' })
    expect(r.reason).toContain('900')
  })

  it('an older run still in its readback delay is busy (the environment wait shows as waiting)', async () => {
    const r = await decideRun(train({ ghApi: api({}, undefined, [{ id: 999, status: 'waiting' }]) }))
    expect(r).toMatchObject({ go: false, skip: true, skipReason: 'busy' })
  })

  it('an older CD deploy run with mode lift, queued or running, is busy too', async () => {
    for (const status of ['queued', 'in_progress']) {
      const lift = { id: 950, status, run_attempt: 1, display_title: 'CD deploy' }
      const r = await decideRun(train({ ghApi: api({}, undefined, [lift]) }))
      expect(r).toMatchObject({ go: false, skip: true, skipReason: 'busy' })
    }
  })

  it('goes when nothing older is unfinished: no run, this run itself, and only newer runs', async () => {
    expect(await decideRun(train({ ghApi: api({}) }))).toMatchObject({ go: true, mode: 'train' })
    const self = { id: 1000, status: 'in_progress' }
    expect(await decideRun(train({ ghApi: api({}, undefined, [self]) }))).toMatchObject({ go: true })
    const newer = [
      { id: 1001, status: 'queued' },
      { id: 1100, status: 'in_progress' },
    ]
    expect(await decideRun(train({ ghApi: api({}, undefined, [self, ...newer]) }))).toMatchObject({ go: true })
  })

  it('compares run ids as numbers, not as text (9 < 10)', async () => {
    const r = await decideRun(train({ runId: '10', ghApi: api({}, undefined, [{ id: 9, status: 'queued' }]) }))
    expect(r).toMatchObject({ go: false, skip: true, skipReason: 'busy' })
  })

  it.each([
    ['a read that fails', new Error('boom')],
    ['a 403', httpError(403)],
    ['a 500', httpError(500)],
  ])('an unreadable list (%s) is a refusal, never "not busy"', async (_n, err) => {
    const r = await decideRun(train({ ghApi: api({}, undefined, err) }))
    expect(r).toMatchObject({ go: false, skip: false, skipReason: 'unreadable' })
    expect(r.reason).toContain('CD deploy')
  })

  it('a full page (100 runs) whose total_count is larger is cut short: unreadable, not "not busy"', async () => {
    const full = Array.from({ length: 100 }, (_, i) => ({ id: 1 + i, status: 'completed' }))
    const ghApi = async (path: string) =>
      path.includes('/runs?') ? { total_count: 101, workflow_runs: full } : api({})(path)
    expect(await decideRun(train({ ghApi }))).toMatchObject({ go: false, skip: false, skipReason: 'unreadable' })
  })

  it('a short page is the complete list, even when total_count says more: not refused (CHE-10505)', async () => {
    const ghApi = async (path: string) =>
      path.includes('/runs?') ? { total_count: 1, workflow_runs: [] } : api({})(path)
    expect(await decideRun(train({ ghApi }))).toMatchObject({ go: true, mode: 'train' })
  })

  it('a missing workflow_runs list is refused even when total_count is 0', async () => {
    const ghApi = async (path: string) => (path.includes('/runs?') ? { total_count: 0 } : api({})(path))
    expect(await decideRun(train({ ghApi }))).toMatchObject({ go: false, skip: false, skipReason: 'unreadable' })
  })

  it.each([undefined, '', 'abc', '0', '-3'])(
    'a run id of %j cannot be compared: refused as unreadable',
    async (runId) => {
      const r = await decideRun(train({ runId }))
      expect(r).toMatchObject({ go: false, skip: false, skipReason: 'unreadable' })
    },
  )

  it('a rerun stays refused, and no list is read for it', async () => {
    const { ghApi, reads } = reading([])
    const r = await decideRun(train({ attempt: '2', ghApi }))
    expect(r).toMatchObject({ go: false, skip: false })
    expect(r.reason).toContain('never rerun')
    expect(reads).toEqual([])
  })

  it('the switch and the pause come first: an off train skips as off, busy or not, without reading the list', async () => {
    const { ghApi, reads } = reading([{ id: 900, status: 'queued' }])
    const r = await decideRun(train({ ghApi, vars: { ...ENV_VARS, DOOP_DEPLOY_TRAIN: 'off' } }))
    expect(r).toMatchObject({ go: false, skip: true, skipReason: 'off' })
    expect(reads).toEqual([])
  })

  describe('entry rules unchanged: schedule, backup and recovery', () => {
    const busy = [{ id: 900, status: 'in_progress' }]
    it('a schedule run is checked', async () => {
      expect(await decideRun(train({ ghApi: api({}, undefined, busy) }))).toMatchObject({ skipReason: 'busy' })
      expect(await decideRun(train({ ghApi: api({}) }))).toMatchObject({ go: true, mode: 'train' })
    })
    it('a schedule backup dispatch (train by github-actions[bot]) is checked the same way', async () => {
      const backup = { event: 'workflow_dispatch', inputs: { mode: 'train', schedule_backup: 'true' } }
      expect(await decideRun(train({ ...backup, ghApi: api({}, undefined, busy) }))).toMatchObject({
        skipReason: 'busy',
      })
      expect(await decideRun(train({ ...backup, ghApi: api({}) }))).toMatchObject({ go: true, mode: 'train' })
    })
    it('a train dispatch by a human is still refused', async () => {
      const r = await decideRun(
        train({ event: 'workflow_dispatch', inputs: { mode: 'train' }, actor: 'congvc-dev', trigger: 'congvc-dev' }),
      )
      expect(r).toMatchObject({ go: false, skip: false })
    })
    it('recovery is a human override: busy or not, it goes and reads no list', async () => {
      const { ghApi, reads } = reading(busy)
      const r = await decideRun(train({ ...dispatched('recovery'), ghApi }))
      expect(r).toMatchObject({ go: true, mode: 'recovery' })
      expect(reads).toEqual([])
    })
    it('recovery by a stranger is still refused', async () => {
      const r = await decideRun(train({ ...dispatched('recovery'), actor: 'someone', trigger: 'someone' }))
      expect(r).toMatchObject({ go: false, skip: false })
    })
  })
})

/* FP-04 (P1, CHE-9850). Run 45664851732: a lift joined group `c00-deploy-doop` while a deploy was pending, and the
   group, which keeps one pending job, cancelled the deploy; its readback-confirm was skipped. Both admission paths
   must close it: a train run does not enter behind an older run (`decide`), and a lift does not enter while an older
   CD deploy run is unfinished (`lift-admit`, a hosted job ahead of the C00 `lift` job, so it never joins the group). */
const wf = readFileSync('.github/workflows/cd-deploy.yml', 'utf8')
function jobText(name: string): string {
  const m = new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [a-z][a-z0-9-]*:\\n|(?![\\s\\S]))`, 'm').exec(wf)
  if (!m?.[1]) throw new Error(`no job ${name}`)
  return m[1]
}

describe('FP-04: a lift never cancels a pending deploy or readback-confirm (CHE-9955)', () => {
  const lifting = (runs: Listed[] | Error, over: Record<string, unknown> = {}) =>
    liftAdmit({ repo: REPO, runId: '2000', attempt: '1', ghApi: api({}, undefined, runs), ...over })

  describe('path 1: the lift job is admitted by lift-admit', () => {
    it.each([
      ['a train deploy queued', 'queued'],
      ['a train deploy running', 'in_progress'],
      ['a train in its readback delay, readback-confirm still to come', 'waiting'],
    ])('refuses while %s', async (_n, status) => {
      const r = await lifting([{ id: 1999, status }])
      expect(r).toMatchObject({ go: false, skip: false })
      expect(r.reason).toContain('1999')
    })

    it('refuses while an older lift is unfinished too (two lifts never queue behind each other)', async () => {
      expect(await lifting([{ id: 1500, status: 'in_progress' }])).toMatchObject({ go: false, skip: false })
    })

    it('goes with no unfinished CD deploy run, and with only newer ones (they skip behind this lift)', async () => {
      expect(await lifting([])).toMatchObject({ go: true })
      expect(await lifting([{ id: 2000, status: 'in_progress' }])).toMatchObject({ go: true })
      expect(await lifting([{ id: 2001, status: 'queued' }])).toMatchObject({ go: true })
    })

    it('an unreadable list refuses, never admits', async () => {
      expect(await lifting(httpError(403))).toMatchObject({ go: false, skip: false })
      expect(await lifting([], { runId: undefined })).toMatchObject({ go: false, skip: false })
      expect(await lifting([], { runId: 'x' })).toMatchObject({ go: false, skip: false })
    })

    // A rerun keeps its run id, so the id order cannot tell it from the first attempt: an older lift rerun while a newer
    // deploy or readback-confirm is pending would pass the id check and join the group behind it.
    it('refuses a rerun (attempt 2) before reading the list, with nothing else unfinished', async () => {
      const read = vi.fn(async () => ({ workflow_runs: [], total_count: 0 }))
      for (const attempt of ['2', '3', '0', '', undefined]) {
        read.mockClear()
        const r = await liftAdmit({ repo: REPO, runId: '2000', attempt, ghApi: read as never })
        expect(r).toMatchObject({ go: false, skip: false })
        expect(r.reason).toMatch(/rerun|attempt/)
        expect(read).not.toHaveBeenCalled()
      }
    })

    it('refuses a rerun of an older lift while a newer deploy is pending (the cancel in run 45664851732)', async () => {
      const r = await lifting([{ id: 2001, status: 'queued' }], { attempt: '2' })
      expect(r).toMatchObject({ go: false, skip: false })
    })

    it('a rerun of failed jobs reuses a green lift-admit, so the lift job itself runs only on attempt 1', () => {
      const lift = jobText('lift')
      expect(lift).toMatch(/^ {4}if: .*github\.run_attempt == 1/m)
      expect(lift).toMatch(/^ {4}if: .*inputs\.mode == 'lift'/m)
      // It is the job's own `if`, so it is evaluated before the job can join group c00-deploy-doop.
      expect(lift.indexOf('run_attempt == 1')).toBeLessThan(lift.indexOf('concurrency:'))
    })

    it('lift-admit tells the gate which attempt it is', () => {
      expect(jobText('lift-admit')).toMatch(/ATTEMPT: \$\{\{ github\.run_attempt \}\}/)
    })

    it('lift-admit is a hosted job ahead of the C00 lift job: it never joins the C00 group', () => {
      // Comments of the next job trail this one's text.
      const admission = jobText('lift-admit').replace(/^\s*#.*$/gm, '')
      expect(admission).toMatch(/runs-on: ubuntu-latest/)
      expect(admission).not.toMatch(/concurrency:|c00-deploy-doop|self-hosted|environment:|secrets\./)
      expect(admission).toMatch(/actions: read/)
      expect(admission).toContain('node scripts/deploy-gate.mjs lift-admit')
      expect(admission).toMatch(/RUN_ID: \$\{\{ github\.run_id \}\}/)
      expect(admission).toMatch(/^ {4}if: .*inputs\.mode == 'lift'/m)
      expect(jobText('lift')).toMatch(/^ {4}needs: lift-admit$/m)
    })

    it('the lift keeps its own gates: group, environment, dispatcher admission, no token, no marker bypass', () => {
      const lift = jobText('lift')
      expect(lift).toMatch(/group: c00-deploy-doop\n\s+cancel-in-progress: false/)
      expect(lift).toMatch(/environment: doop-lift/)
      expect(lift).toContain('node scripts/deploy-lift.mjs admit')
      expect(lift).not.toMatch(/GH_TOKEN|github\.token/)
      expect(lift).not.toMatch(/deploy-marker/)
    })
  })

  describe('path 2: a train run is admitted by decide', () => {
    it('skips behind an older deploy, so its deploy and readback-confirm never join the group behind it', async () => {
      const r = await decideRun(train({ runId: '2000', ghApi: api({}, undefined, [{ id: 1999, status: 'queued' }]) }))
      expect(r).toMatchObject({ go: false, skip: true, skipReason: 'busy' })
    })

    it('skips behind an older lift (a CD deploy run with mode lift)', async () => {
      const r = await decideRun(
        train({ runId: '2000', ghApi: api({}, undefined, [{ id: 1999, status: 'in_progress' }]) }),
      )
      expect(r).toMatchObject({ go: false, skip: true, skipReason: 'busy' })
    })

    it('the resolve job gives decide a token that reads Actions and this run id', () => {
      const resolve = jobText('resolve')
      const decide = /- id: decide\n([\s\S]*?)(?=\n {6}- id: pick)/.exec(resolve)?.[1] ?? ''
      expect(decide).toMatch(/GH_TOKEN: \$\{\{ github\.token \}\}/)
      expect(decide).toMatch(/RUN_ID: \$\{\{ github\.run_id \}\}/)
      expect(resolve).toMatch(/permissions:\n\s+contents: read\n\s+actions: read/)
    })
  })
})

/* The skip reason: `busy`, `armed`, `suspended`, `unreadable`, `current`, `off`, `other`. It is a step output of
   `decide` and of `recheck --op pre-arm`, a job output of `resolve` and `deploy`, and a field of the evidence JSON. */
describe('skip_reason: each reason from the gate to the evidence JSON (CHE-9955)', () => {
  const evidenceOf = (out: { skipReason?: string }) => buildEvidence({ SKIP_REASON: out.skipReason ?? '' })
  const busyRun = [{ id: 900, status: 'queued' }]
  const cases: [string, () => Promise<{ skipReason?: string }>][] = [
    ['busy', () => decideRun(train({ ghApi: api({}, undefined, busyRun) }))],
    ['off', () => decideRun(train({ ghApi: api({}), vars: { ...ENV_VARS, DOOP_DEPLOY_TRAIN: 'off' } }))],
    ['other', () => decideRun(train({ ghApi: api({}), vars: { ...ENV_VARS, MAIN_RED_PAUSED: 'red' } }))],
    ['unreadable', () => decideRun(train({ ghApi: api({}, undefined, httpError(500)) }))],
    ['armed', () => ops({ marker: 'armed:n2:1:' + CAND })('pre-arm')],
    ['suspended', () => ops({ marker: 'suspended:n2:1:' + CAND + ':x' })('pre-arm')],
    ['suspended', () => ops({ marker: null })('pre-arm')],
    ['unreadable', () => ops({ marker: new Error('EACCES') })('pre-arm')],
    ['current', () => ops()('pre-arm', undefined, { running: async () => ({ digest: D_CAND, label: CAND }) })],
    ['off', () => ops({ sw: 'off' })('pre-arm')],
    ['other', () => ops({ paused: 'red' })('pre-arm')],
    ['other', () => ops({}, { ghApi: api({}, { [MID]: 'stranger', [CAND]: 'congvc-dev' }) })('pre-arm')],
    ['other', () => ops({}, { varsAgeSeconds: 900 })('pre-arm')],
    ['other', () => ops({ marker: 'garbage' })('pre-arm')],
  ]
  it.each(cases.map((c, i) => [`${c[0]} (#${i + 1})`, ...c] as const))('%s', async (_n, reason, run) => {
    const out = await run()
    expect(out.skipReason).toBe(reason)
    expect(evidenceOf(out).skip_reason).toBe(reason)
  })

  it('a go carries no skip reason, and the evidence of a run that did not skip has none', async () => {
    expect(((await ops()('pre-arm')) as { skipReason?: string }).skipReason ?? '').toBe('')
    expect(((await decideRun(train({ ghApi: api({}) }))) as { skipReason?: string }).skipReason ?? '').toBe('')
    expect(buildEvidence({}).skip_reason).toBeNull()
  })

  it('a refusal that is not about an unreadable fact carries no reason', async () => {
    const r = (await ops()('pre-arm', undefined, { isAncestor: async () => false })) as { skipReason?: string }
    expect(r.skipReason ?? '').toBe('')
  })
})

describe('deploy-gate CLI: skip_reason and RUN_ID reach $GITHUB_OUTPUT (CHE-9955)', () => {
  const call = async (env: Record<string, string>, runs: Listed[] | number) => {
    const server = createServer((req, res) => {
      res.setHeader('content-type', 'application/json')
      if (typeof runs === 'number') {
        res.statusCode = runs
        res.end(JSON.stringify({ message: 'nope' }))
        return
      }
      const status = new URL(req.url ?? '', 'http://x').searchParams.get('status')
      const hit = runs.filter((r) => r.status === status)
      res.end(JSON.stringify({ total_count: hit.length, workflow_runs: hit }))
    })
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok))
    const { port } = server.address() as { port: number }
    const dir = mkdtempSync(join(tmpdir(), 'gate-out-'))
    const output = join(dir, 'out')
    writeFileSync(output, '')
    try {
      const command = env.COMMAND ?? 'decide'
      const code = await new Promise<number | null>((done) => {
        const child = spawn('node', ['scripts/deploy-gate.mjs', command], {
          env: {
            PATH: process.env.PATH ?? '',
            GITHUB_API_URL: `http://127.0.0.1:${port}`,
            GITHUB_OUTPUT: output,
            GH_TOKEN: 'actions-read-token',
            REPO,
            EVENT: 'schedule',
            ACTOR: BOT,
            TRIGGER: BOT,
            ATTEMPT: '1',
            RUN_ID: '1000',
            ...ENV_VARS,
            ...env,
          },
        })
        child.on('close', done)
      })
      return { code, written: readFileSync(output, 'utf8') }
    } finally {
      server.close()
      rmSync(dir, { recursive: true, force: true })
    }
  }

  it('a busy decide exits 0 (a clean skip) and writes skip_reason=busy', async () => {
    const r = await call({}, [{ id: 900, status: 'queued' }])
    expect(r.code).toBe(0)
    expect(r.written).toContain('go=false')
    expect(r.written).toContain('skip=true')
    expect(r.written).toContain('skip_reason=busy')
  })

  it('a decide that goes writes an empty skip_reason', async () => {
    const r = await call({}, [])
    expect(r.code).toBe(0)
    expect(r.written).toContain('go=true')
    expect(r.written).toMatch(/^skip_reason=$/m)
  })

  it('an unreadable list exits non-zero and writes skip_reason=unreadable', async () => {
    const r = await call({}, 500)
    expect(r.code).not.toBe(0)
    expect(r.written).toContain('skip_reason=unreadable')
  })

  it('a missing RUN_ID exits non-zero', async () => {
    const r = await call({ RUN_ID: '' }, [])
    expect(r.code).not.toBe(0)
  })

  it('lift-admit exits non-zero while an older CD deploy run is unfinished, and 0 when none is', async () => {
    const busy = await call({ COMMAND: 'lift-admit', RUN_ID: '2000' }, [{ id: 1999, status: 'queued' }])
    expect(busy.code).not.toBe(0)
    expect(busy.written).toContain('go=false')
    const free = await call({ COMMAND: 'lift-admit', RUN_ID: '2000' }, [])
    expect(free.code).toBe(0)
    expect(free.written).toContain('go=true')
  })

  it('lift-admit exits non-zero on a rerun (ATTEMPT 2) even when nothing else is unfinished', async () => {
    const rerun = await call({ COMMAND: 'lift-admit', RUN_ID: '2000', ATTEMPT: '2' }, [])
    expect(rerun.code).not.toBe(0)
    expect(rerun.written).toContain('go=false')
  })
})
