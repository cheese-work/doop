import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error plain .mjs script, no type declarations
import { admit, c00Quiescent, decideRun, pickCandidate, recheckOp } from '../scripts/deploy-gate.mjs'
// @ts-expect-error plain .mjs script, no type declarations
import { inventory } from '../scripts/migration-inventory.mjs'

/* CHE-5544 (train S2, plan CHE-5474 C-2, C-5, C-6). The decider runs in two places: `decideRun` at the
   top of a D2 run (entry rules and the cheap gates) and `recheckOp` inside the C00 jobs, once per
   operation. Every GitHub read goes through an injected `ghApi`, every C00 or git fact through an
   injected function, so each rule is pinned without a network. */
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
/* `marker` is a getter-friendly object so a test can change it between operations. */
function api(
  vars: Vars,
  mergers: Record<string, string | null> = { [MID]: 'congvc-dev', [CAND]: 'congvc-bot-x99[bot]' },
) {
  const routes: Record<string, unknown> = {
    [`repos/${REPO}/actions/variables/DOOP_DEPLOY_TRAIN`]: () => val(vars.sw, 'on')(),
    [`repos/${REPO}/actions/variables/MAIN_RED_PAUSED`]: () => val(vars.paused, null)(),
    [`repos/${REPO}/actions/variables/DOOP_DEPLOY_SUSPENDED`]: () => val(vars.marker, CLEAR)(),
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
    ['marker absent', { marker: null }],
    ['marker armed', { marker: 'armed:n:1:' + CAND }],
    ['marker suspended', { marker: 'suspended:n:1:' + CAND + ':migrated' }],
    ['marker garbage', { marker: 'ok' }],
    ['marker with the clear prefix but no nonce', { marker: 'clear:n0:restore' }],
    ['marker clear with a short nonce', { marker: 'clear:abc:restore' }],
    ['marker clear with a trailing line', { marker: CLEAR + '\nx' }],
  ])('%s', async (_n, vars) => {
    expect(await decideRun(entry({ ghApi: api(vars) }))).toMatchObject({ go: false, skip: true })
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
const ENV_VARS = { DOOP_DEPLOY_TRAIN: 'on', MAIN_RED_PAUSED: '', DOOP_DEPLOY_SUSPENDED: CLEAR }

describe('decideRun: switches come from env, not the variables API (CHE-9181)', () => {
  it('DOOP_DEPLOY_TRAIN=on in env is a go while the variables API answers 403', async () => {
    const r = await decideRun(entry({ ghApi: forbidden, vars: ENV_VARS }))
    expect(r).toMatchObject({ go: true, mode: 'train' })
  })

  it('does not call the variables API at all when env supplies the switches', async () => {
    const reads: string[] = []
    const ghApi = async (path: string) => {
      reads.push(path)
      throw httpError(403)
    }
    await decideRun(entry({ ghApi, vars: ENV_VARS }))
    expect(reads).toEqual([])
  })

  it.each([
    ['unset switch', { ...ENV_VARS, DOOP_DEPLOY_TRAIN: '' }, 'needs'],
    ['switch off', { ...ENV_VARS, DOOP_DEPLOY_TRAIN: 'off' }, 'needs'],
    ['pause set', { ...ENV_VARS, MAIN_RED_PAUSED: 'main red' }, 'MAIN_RED_PAUSED is set'],
    ['marker unset', { ...ENV_VARS, DOOP_DEPLOY_SUSPENDED: '' }, 'absent'],
    ['marker armed', { ...ENV_VARS, DOOP_DEPLOY_SUSPENDED: ARMED }, 'not clear'],
  ])('%s in env is still a clean skip', async (_n, vars, words) => {
    const r = await decideRun(entry({ ghApi: forbidden, vars }))
    expect(r).toMatchObject({ go: false, skip: true })
    expect(r.reason).toContain(words)
  })

  it.each([['DOOP_DEPLOY_TRAIN'], ['MAIN_RED_PAUSED'], ['DOOP_DEPLOY_SUSPENDED']])(
    '%s missing from env fails red, never a skip',
    async (name) => {
      const { [name]: _gone, ...vars } = ENV_VARS as Record<string, string>
      const r = await decideRun(entry({ ghApi: forbidden, vars }))
      expect(r).toMatchObject({ go: false, skip: false })
      expect(r.reason).toContain(name)
    },
  )

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
    ['marker', { marker: httpError(500) }, 'DOOP_DEPLOY_SUSPENDED'],
  ])('an unreadable %s through the API fails red and names the status', async (_n, vars, name) => {
    const r = await decideRun(entry({ ghApi: api(vars) }))
    expect(r).toMatchObject({ go: false, skip: false })
    expect(r.reason).toContain(name)
    expect(r.reason).toMatch(/GitHub (403|500)/)
  })
})

describe('recheckOp: an unreadable variable fails red, and the variables token is separate (CHE-9181)', () => {
  it('pre-arm reads variables with varsApi, pulls with ghApi', async () => {
    const reads: string[] = []
    const varsApi = async (path: string) => {
      reads.push(path)
      return api({})(path)
    }
    const r = await ops({}, { ghApi: api({}), varsApi })('pre-arm')
    expect(r).toMatchObject({ go: true })
    expect(reads.length).toBeGreaterThan(0)
    expect(reads.every((p) => p.includes('/actions/variables/'))).toBe(true)
  })

  it('pre-arm: variables 403 refuses instead of skipping', async () => {
    const r = await ops({}, { ghApi: api({}), varsApi: forbidden })('pre-arm')
    expect(r).toMatchObject({ go: false, skip: false })
    expect(r.reason).toContain('GitHub 403')
  })

  it.each([['pre-apply'], ['confirm']])('%s: variables 403 refuses', async (op) => {
    const r = await ops({}, { ghApi: api({}), varsApi: forbidden })(op, ARMED, {
      running: async () => ({ digest: D_CAND, label: CAND }),
    })
    expect(r).toMatchObject({ go: false, skip: false })
    expect(r.reason).toContain('GitHub 403')
  })

  it('rollback with the variables token refuses a marker that changed while the candidate digest still runs', async () => {
    const run = { running: async () => ({ digest: D_CAND, label: CAND }) }
    for (const marker of ['armed:n9:2:' + CAND, CLEAR, CLEAR_LIFT, null, httpError(500)]) {
      const r = await ops({ marker })('rollback', ARMED, run)
      expect(r, String(marker)).toMatchObject({ go: false, skip: false })
    }
  })

  it('rollback without a token (the mint failed) still rolls back from what C00 runs', async () => {
    const r = await ops({}, { varsApi: null })('rollback', ARMED, {
      running: async () => ({ digest: D_CAND, label: CAND }),
    })
    expect(r).toMatchObject({ go: true, action: 'rollback' })
  })

  it('rollback still needs this run’s own --expect value', async () => {
    expect(await ops({})('rollback', undefined)).toMatchObject({ go: false, skip: false })
  })
})

describe('deploy-gate CLI decide (CHE-9181)', () => {
  const run = async (env: Record<string, string>, status: number) => {
    const server = createServer((_req, res) => {
      res.statusCode = status
      res.setHeader('content-type', 'application/json')
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

  it('a train run never reads a workflow run to decide', async () => {
    const reads: string[] = []
    const inner = api({})
    const ghApi = async (path: string) => {
      reads.push(path)
      return inner(path)
    }
    expect(await decideRun(entry({ ghApi }))).toMatchObject({ go: true })
    expect(await ops({}, { ghApi })('pre-arm')).toMatchObject({ go: true })
    expect(reads.filter((p) => p.includes('/actions/runs'))).toEqual([])
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
    ghApi: api(vars),
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
      httpError(500),
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
