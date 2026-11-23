import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
// @ts-expect-error plain .mjs fixture, no type declarations
import { LEGACY_AUTOPILOT_ID as LEGACY, runLegacyPartC } from './fixtures/fake-legacy-route.mjs'
// @ts-expect-error plain .mjs fixture, no type declarations
import { fakeCli } from './fixtures/fake-multica/client.mjs'

/* cutover.mjs against the fake CLI (CHE-7207 S1d): intent rules, live-state table, forward steps,
   resume, rollback and handover. Every run is a real child process, so a kill is a real kill. */

vi.setConfig({ testTimeout: 180_000 })

const CUT = path.resolve('scripts/upstream-watch/cutover.mjs')
const FAKE = path.resolve('tests/fixtures/fake-multica/multica.mjs')
const ADMIT = path.resolve('tests/fixtures/fake-admit.mjs')
const GIT = path.resolve('tests/fixtures/fake-git.mjs')
const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const BEFORE_SHA = '07eebc9c95970144acee792d5f2cd8e04c76af9e0a4dfe13bc00f0a5efc0cc83'
const SQUAD = 'a1073a68-4965-44ff-a8fb-244341935110'
const LEDGER_TITLE = 'chore(doop): upstream sync ledger (CHE-7207)'
const NEW_AP_TITLE = 'Upstream release watch: doop'
const OLD_TITLE = 'Upstream release watch: sub2api, doop, hindsight-api'
const RETIRED_TITLE = 'Upstream release watch: sub2api, hindsight-api'
const SERVER = '2026-11-18T04:15:51Z'
const NOW = '2026-11-19T02:00:00Z'
const H = 3600_000

let dir: string
let state: string
let BEFORE: string
let AFTER: string
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'cutover-'))
  state = path.join(dir, 'state.json')
  BEFORE = await readFile('scripts/upstream-watch/legacy-before.md', 'utf8')
  AFTER = await readFile('scripts/upstream-watch/legacy-after.md', 'utf8')
})
afterEach(() => rm(dir, { recursive: true, force: true }))

/* ---- world ---- */
// eslint-disable-next-line typescript/no-explicit-any -- seed objects mirror the CLI's loose JSON
type Obj = Record<string, any>
const issue = (n: number, o: Obj = {}): Obj => ({
  id: `i-${n}`,
  identifier: `CHE-${n}`,
  number: n,
  title: `issue ${n}`,
  description: '',
  status: 'todo',
  revision: 1,
  parent_issue_id: null,
  assignee_id: SQUAD,
  metadata: {},
  comments: [],
  duplicate_of: null,
  ...o,
})
const S1B = issue(7302, { id: 's1b', status: 'in_progress', title: 'S1b' })
const LEDGER = (intent?: string | null, meta: Obj = {}) =>
  issue(9000, {
    id: 'ledger-1',
    title: LEDGER_TITLE,
    status: 'backlog',
    metadata: { ...(intent ? { cutover_intent: intent } : {}), ...meta },
  })
const CHE7205 = (o: Obj = {}) =>
  issue(7205, {
    title: 'task(doop): merge upstream doop 0.15.0 into cheese/main and redeploy on C00',
    status: 'in_progress',
    ...o,
  })
const ADOPTED = {
  parent_issue_id: 'ledger-1',
  metadata: { upstream_sync_sha: '9a4fb9ec442a982772b752004761eda3aca2633d' },
}
const W = (o: Obj = {}) =>
  issue(9101, {
    title: 'task(doop): merge upstream doop 0.16.0 into cheese/main',
    description: `Upstream: kgoedecke/doop v0.16.0 commit ${'b'.repeat(40)}\nWaits for: CHE-7205`,
    status: 'backlog',
    revision: 3,
    parent_issue_id: 'ledger-1',
    ...o,
  })
const run = (id: string, status: string, o: Obj = {}) => ({
  id,
  status,
  created_at: '2026-11-18T04:00:00Z',
  task_id: `task-${id}`,
  ...o,
})
const manyRuns = (n: number, special: Obj = {}) =>
  Array.from({ length: n }, (_, i) => ({
    ...run(`r-${i}`, 'completed', { created_at: new Date(Date.parse('2026-11-01T00:00:00Z') + i * H).toISOString() }),
    ...(special[i] ?? {}),
  }))

type World = {
  ledger?: boolean
  intent?: string | null
  meta?: Obj
  adopted?: boolean
  legacy?: 'before' | 'after' | string
  legacyRuns?: Obj[]
  newAp?: null | { status?: string; trigger?: boolean; runs?: Obj[] }
  issues?: Obj[]
}
const world = (w: World = {}) => {
  const ledger = w.ledger ?? (w.intent !== undefined || w.adopted !== undefined || !!w.meta)
  const desc = w.legacy === 'after' ? AFTER : w.legacy === 'before' || !w.legacy ? BEFORE : w.legacy
  const autopilots: Obj = {
    [LEGACY]: {
      id: LEGACY,
      title: w.legacy === 'after' ? RETIRED_TITLE : OLD_TITLE,
      description: desc,
      status: 'active',
      updated_at: SERVER,
      triggers: [],
      runs: w.legacyRuns ?? [],
    },
  }
  if (w.newAp)
    autopilots['ap-new'] = {
      id: 'ap-new',
      title: NEW_AP_TITLE,
      description: 'new',
      status: w.newAp.status ?? 'active',
      mode: 'run_only',
      updated_at: SERVER,
      triggers:
        w.newAp.trigger === false
          ? []
          : [
              {
                id: 'tr-1',
                cron: '30 4,10,16,22 * * *',
                cron_expression: '30 4,10,16,22 * * *',
                timezone: 'Asia/Ho_Chi_Minh',
              },
            ],
      runs: w.newAp.runs ?? [],
    }
  return {
    issues: [
      S1B,
      ...(ledger ? [LEDGER(w.intent, w.meta)] : []),
      CHE7205(w.adopted ? ADOPTED : {}),
      ...(w.issues ?? []),
    ],
    autopilots,
  }
}
const seed = (w: World | Obj, raw = false) => writeFile(state, JSON.stringify(raw ? w : world(w as World)))
const read = async () => JSON.parse(await readFile(state, 'utf8'))
const issueOf = (s: Obj, id: string) => s.issues.find((i: Obj) => i.id === id || i.identifier === id)
const legacyOf = (s: Obj) => s.autopilots[LEGACY]
const newApsOf = (s: Obj) => Object.values<Obj>(s.autopilots).filter((a) => a.title === NEW_AP_TITLE)
const DONE_WORLD: World = {
  intent: 'forward',
  adopted: true,
  legacy: 'after',
  newAp: { status: 'active', trigger: true },
}

/* ---- running the script ---- */
const WRITE = new Set([
  'issue.create',
  'issue.update',
  'issue.status',
  'issue.assign',
  'issue.comment',
  'issue.metadata',
  'issue.wakeup',
  'autopilot.update',
  'autopilot.create',
  'autopilot.trigger-add',
])
const isWrite = (a: string[]) => WRITE.has(`${a[0]}.${a[1]}`) && !(a[1] === 'wakeup' && a[2] === 'get')
const isIntent = (a: string[] | undefined, v?: string) =>
  !!a && a[1] === 'metadata' && a.includes('cutover_intent') && (v === undefined || a[a.indexOf('--value') + 1] === v)
const isLegacyWrite = (a: string[]) => a[0] === 'autopilot' && a[1] === 'update' && a[2] === LEGACY
const isRestore = (a: string[]) =>
  isLegacyWrite(a) && a.includes('--description') && a[a.indexOf('--title') + 1] === OLD_TITLE
const isRetire = (a: string[]) =>
  isLegacyWrite(a) && a.includes('--description') && a[a.indexOf('--title') + 1] === RETIRED_TITLE

type Out = {
  code: number | null
  signal: string | null
  json: Obj
  log: string[][]
  writes: string[][]
  stderr: string
}
async function cut(args: string[], env: Obj = {}): Promise<Out> {
  const base = (await read()).log?.length ?? 0
  const r = spawnSync('node', [CUT, ...args, '--s1b', 'CHE-7302'], {
    env: {
      ...process.env,
      MULTICA_CLI_PATH: FAKE,
      FAKE_MULTICA_STATE: state,
      CUTOVER_ADMIT: ADMIT,
      CUTOVER_GIT: GIT,
      CUTOVER_NOW: NOW,
      ...env,
    },
    encoding: 'utf8',
    timeout: 170_000,
  })
  let json: Obj = {}
  try {
    json = JSON.parse(r.stdout.trim().split('\n').pop() ?? '{}')
  } catch {
    // not JSON: the assertions below fail with stderr in the message
  }
  const log: string[][] = ((await read()).log ?? []).slice(base).map((l: Obj) => l.argv)
  return { code: r.status, signal: r.signal, json, log, writes: log.filter(isWrite), stderr: r.stderr }
}
const admitLog = async () => {
  try {
    return (await readFile(`${state}.admit.log`, 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
  } catch {
    return []
  }
}
/** A rollback never creates, retargets or cancels a child: only status todo with --expected-revision. */
const onlyPromotesChildren = (writes: string[][]) => {
  expect(writes.filter((a) => a[1] === 'create')).toEqual([])
  expect(writes.filter((a) => a[1] === 'status')).toEqual([])
  for (const a of writes.filter((x) => x[0] === 'issue' && x[1] === 'update')) {
    expect(a).toContain('--expected-revision')
    expect(a[a.indexOf('--status') + 1]).toBe('todo')
    expect(a).not.toContain('--title')
    expect(a).not.toContain('--parent')
  }
}
const mutate = async (fn: (s: Obj) => void) => {
  const s = await read()
  fn(s)
  await writeFile(state, JSON.stringify(s))
}

/* ---- files ---- */
describe('legacy-before.md and legacy-after.md', () => {
  it('before-file has the live before-hash; parts A and B are byte-identical in the after-file', () => {
    expect(sha(BEFORE)).toBe(BEFORE_SHA)
    const ab = (t: string) =>
      t.slice(t.indexOf('## Part A'), t.indexOf('## Part C') >= 0 ? t.indexOf('## Part C') : t.indexOf('## Failures'))
    expect(ab(AFTER)).toBe(ab(BEFORE))
    expect(ab(AFTER).length).toBeGreaterThan(1000)
    expect(AFTER.slice(0, AFTER.indexOf('## Part A'))).toBe(BEFORE.slice(0, BEFORE.indexOf('## Part A')))
  })

  it('the after-text drops only part C, the doop half of the gap guard and WATCH FAILED: doop', () => {
    const b = BEFORE.split('\n')
    const a = AFTER.split('\n')
    const c0 = b.findIndex((l) => l.startsWith('## Part C'))
    const c1 = b.findIndex((l) => l.startsWith('## Failures'))
    const removed = b.map((l, i) => [l, i] as const).filter(([l]) => !a.includes(l))
    const added = a.filter((l) => !b.includes(l))
    const inC = removed.filter(([, i]) => i >= c0 && i < c1)
    const rest = removed.filter(([, i]) => i < c0 || i >= c1).map(([l]) => l)
    expect(inC.length).toBeGreaterThan(0)
    // part C is cut whole and nothing else is dropped: the two edited lines are replaced one for one
    expect(a).toHaveLength(b.length - (c1 - c0))
    expect(rest).toHaveLength(2)
    expect(rest.some((l) => l.includes('WATCH FAILED: doop'))).toBe(true)
    expect(rest.some((l) => l.startsWith('Gap guard'))).toBe(true)
    expect(added).toHaveLength(2)
    expect(AFTER).not.toMatch(/Part C|WATCH FAILED: doop|merge upstream/)
    expect(AFTER).toContain('## Part B: hindsight-api')
  })
})

/* ---- live state table ---- */
describe('--state: the live-state table, first matching row wins', () => {
  const rows: [string, World, string][] = [
    ['1 UNKNOWN: neither hash', { intent: 'forward', legacy: 'edited by someone' }, 'UNKNOWN'],
    ['1 UNKNOWN beats rollback', { intent: 'rollback', legacy: 'edited by someone' }, 'UNKNOWN'],
    ['2 ROLLBACK on the after-hash', { intent: 'rollback', legacy: 'after', newAp: { status: 'paused' } }, 'ROLLBACK'],
    ['2 ROLLBACK on the before-hash', { intent: 'rollback', legacy: 'before' }, 'ROLLBACK'],
    ['3 SPLIT: before-hash, active new autopilot', { intent: 'forward', newAp: { status: 'active' } }, 'SPLIT'],
    ['4 FRESH: no ledger', {}, 'FRESH'],
    ['4 FRESH: rolled_back, new paused', { intent: 'rolled_back', newAp: { status: 'paused' } }, 'FRESH'],
    ['5 STARTED', { intent: 'forward', adopted: true }, 'STARTED'],
    ['5 STARTED with a paused new autopilot', { intent: 'forward', newAp: { status: 'paused' } }, 'STARTED'],
    ['6 DONE', DONE_WORLD, 'DONE'],
    ['7 RETIRED: new absent', { intent: 'forward', legacy: 'after' }, 'RETIRED'],
    ['7 RETIRED: new paused', { intent: 'forward', legacy: 'after', newAp: { status: 'paused' } }, 'RETIRED'],
    [
      '7 RETIRED: new active without trigger',
      { intent: 'forward', legacy: 'after', newAp: { status: 'active', trigger: false } },
      'RETIRED',
    ],
    ['8 ORPHAN: no intent', { ledger: true, legacy: 'after' }, 'ORPHAN'],
    ['8 ORPHAN: rolled_back', { intent: 'rolled_back', legacy: 'after' }, 'ORPHAN'],
  ]
  it.each(rows)('%s', async (_n, w, expected) => {
    await seed(w)
    const r = await cut(['--state'])
    expect(r.json.state).toBe(expected)
    expect(r.writes).toEqual([])
  })
})

/* ---- forward cutover ---- */
describe('--start', () => {
  it('runs the 8 steps in order: legacy update before the new autopilot; one ledger child for a tag published meanwhile', async () => {
    await seed({})
    const r = await cut(['--start'], { FAKE_ADMIT_TAG: '0.16.0' })
    expect(r.stderr).toBe('')
    expect(r.code).toBe(0)
    expect(r.json.state).toBe('DONE')
    const s = await read()
    const ledger = s.issues.find((i: Obj) => i.title === LEDGER_TITLE)
    expect(ledger.metadata.cutover_intent).toBe('forward')
    expect(issueOf(s, 'CHE-7205')).toMatchObject({ parent_issue_id: ledger.id })
    expect(issueOf(s, 'CHE-7205').metadata.upstream_sync_sha).toBe('9a4fb9ec442a982772b752004761eda3aca2633d')
    expect(sha(legacyOf(s).description)).toBe(sha(AFTER))
    expect(legacyOf(s).title).toBe(RETIRED_TITLE)
    const [np, ...more] = newApsOf(s)
    expect(more).toEqual([])
    expect(np).toMatchObject({
      status: 'active',
      mode: 'run_only',
      agent: 'x99-claude-sonnet',
      project: '5e621e12-eeb4-40a5-9571-25657d5b0ec5',
    })
    expect(np?.triggers).toMatchObject([{ cron: '30 4,10,16,22 * * *', timezone: 'Asia/Ho_Chi_Minh' }])
    expect(np?.description).toContain(ledger.id)
    const at = (p: (a: string[]) => boolean) => r.log.findIndex(p)
    const intent = at((a) => isIntent(a, 'forward'))
    expect(intent).toBeGreaterThan(at((a) => a[1] === 'update' && a.includes('--parent')))
    expect(intent).toBeLessThan(at((a) => a[0] === 'autopilot' && a[1] === 'runs'))
    expect(at(isRetire)).toBeGreaterThan(at((a) => a[0] === 'autopilot' && a[1] === 'runs'))
    expect(at((a) => a[0] === 'autopilot' && a[1] === 'create')).toBeGreaterThan(at(isRetire))
    expect(at((a) => a[0] === 'autopilot' && a[1] === 'trigger-add')).toBeGreaterThan(
      at((a) => a[0] === 'autopilot' && a[1] === 'create'),
    )
    expect(await admitLog()).toEqual([
      { dry: true, ledger: ledger.id },
      { dry: false, ledger: ledger.id },
    ])
    const kids = s.issues.filter((i: Obj) => i.parent_issue_id === ledger.id)
    expect(kids.filter((k: Obj) => k.title.includes('merge upstream doop 0.16.0'))).toHaveLength(1)
    // the dry run wrote nothing: the only write between the two admit runs is none
    expect(r.writes.filter((a) => a[1] === 'create' && a[0] === 'issue').length).toBe(2) // ledger + the one child
  })

  it('a rerun from DONE writes nothing, with --resume and with --start', async () => {
    await seed(DONE_WORLD)
    for (const flag of ['--resume', '--start']) {
      const r = await cut([flag])
      expect(r.json.state).toBe('DONE')
      expect(r.writes).toEqual([])
    }
    expect(await admitLog()).toEqual([])
  })

  it('--resume in FRESH writes nothing and only --start begins a cutover', async () => {
    await seed({ intent: 'rolled_back' })
    const r = await cut(['--resume'])
    expect(r.json.state).toBe('FRESH')
    expect(r.writes).toEqual([])
  })

  it('--start outside FRESH writes nothing and points at --resume', async () => {
    await seed({ intent: 'forward', adopted: true, legacy: 'after' })
    const r = await cut(['--start'])
    expect(r.writes).toEqual([])
    expect(r.json.stop.reason).toMatch(/--resume/)
  })

  it('UNKNOWN: --start, --resume and --rollback write nothing', async () => {
    await seed({ intent: 'forward', legacy: 'edited by someone' })
    for (const flag of ['--start', '--resume', '--rollback', '--release-waiting']) {
      const r = await cut([flag])
      expect(r.json.state).toBe('UNKNOWN')
      expect(r.json.stop.next).toBe('blocked')
      expect(r.writes).toEqual([])
    }
  })

  it('a legacy update conflict (hash mismatch): stop, no new autopilot, no admission', async () => {
    await seed({})
    const r = await cut(['--start'], {
      FAKE_MULTICA_INJECT: JSON.stringify([
        { when: 'autopilot.update', autopilot: LEGACY, patch: { description: 'edited by someone else' } },
      ]),
    })
    expect(r.code).not.toBe(0)
    expect(r.json.stop.step).toBe('3')
    expect(r.json.stop.readback).toBeTruthy()
    const s = await read()
    expect(legacyOf(s).description).toBe('edited by someone else')
    expect(newApsOf(s)).toEqual([])
    expect(r.log.filter((a) => a[0] === 'autopilot' && a[1] === 'create')).toEqual([])
    expect(await admitLog()).toEqual([])
  })

  it('a legacy run in flight at step 2: stop in STARTED; the only writes after the intent are the stop bookkeeping', async () => {
    await seed({ legacyRuns: [run('r-live', 'running')] })
    const r = await cut(['--start'])
    expect(r.code).not.toBe(0)
    expect(r.json.stop).toMatchObject({ step: '2', next: 'wait' })
    expect(r.json.state).toBe('STARTED')
    const s = await read()
    expect(sha(legacyOf(s).description)).toBe(BEFORE_SHA)
    expect(newApsOf(s)).toEqual([])
    const i = r.writes.findIndex((a) => isIntent(a, 'forward'))
    const after = r.writes.slice(i + 1)
    expect(after.length).toBeGreaterThan(0)
    expect(after.every((a) => (a[1] === 'metadata' && a.includes('cutover_stopped_at')) || a[1] === 'wakeup')).toBe(
      true,
    )
    expect(issueOf(s, 'ledger-1') ?? s.issues.find((x: Obj) => x.title === LEDGER_TITLE)).toBeTruthy()
    expect(s.wakeups).toHaveLength(1)
    expect(s.wakeups[0]).toMatchObject({ issue: 's1b' })
    expect(s.wakeups[0].flags).toMatchObject({
      event: 'task.completed,task.failed,task.cancelled',
      'task-id': 'task-r-live',
      'expires-in': '3h',
      'on-timeout': 'wake',
    })
    expect(s.wakeups[0].flags.instruction).toMatch(/resume wake: run cutover\.mjs --resume/)
    expect(await admitLog()).toEqual([])
  })

  describe.each([
    ['create', 'issue.wakeup#1:crash,issue.wakeup#2:crash'], // the first create falls back to a timed wakeup, so both fail
    ['readback', 'issue.wakeup#2:crash'],
  ])('a wake %s failure at a wait stop (review P1)', (_n, fault) => {
    it('stops blocked with no stop marker, and a later --resume registers the wake', async () => {
      await seed({ legacyRuns: [run('r-live', 'running')] })
      const r = await cut(['--start'], { FAKE_MULTICA_FAULT: fault })
      expect(r.code).not.toBe(0)
      expect(r.json.stop).toMatchObject({ step: '2', next: 'blocked' })
      expect(r.json.stop.reason).toMatch(/wake/i)
      let s = await read()
      const stopped = s.issues.find((x: Obj) => x.title === LEDGER_TITLE).metadata.cutover_stopped_at
      expect(!stopped || stopped === 'none').toBe(true)
      const again = await cut(['--resume'])
      expect(again.json.stop).toMatchObject({ step: '2', next: 'wait' })
      s = await read()
      expect(s.wakeups.length).toBeGreaterThan(0)
      expect(s.issues.find((x: Obj) => x.title === LEDGER_TITLE).metadata.cutover_stopped_at).toMatch(/ 2$/)
    })
  })

  it('a non-terminal legacy run on page 2 of the history (offset 50) is found', async () => {
    await seed({ legacyRuns: manyRuns(60, { 54: { status: 'queued' } }) })
    const r = await cut(['--start'])
    expect(r.json.stop).toMatchObject({ step: '2', next: 'wait' })
    expect(r.log.some((a) => a[1] === 'runs' && a[a.indexOf('--offset') + 1] === '50')).toBe(true)
    expect(r.writes.filter(isLegacyWrite)).toEqual([])
  })

  it('an unknown run status counts as in flight', async () => {
    await seed({ legacyRuns: [run('r-x', 'mystery')] })
    const r = await cut(['--start'])
    expect(r.json.stop.step).toBe('2')
  })

  it('step 2 stop, resumed 3 h later with the run still in flight: blocked with the run id, old route untouched', async () => {
    await seed({ legacyRuns: [run('r-live', 'running')] })
    await cut(['--start'])
    const r = await cut(['--resume'], { CUTOVER_NOW: new Date(Date.parse(NOW) + 3 * H + 60_000).toISOString() })
    expect(r.json.stop).toMatchObject({ step: '2', next: 'blocked' })
    expect(JSON.stringify(r.json.stop)).toContain('r-live')
    expect(r.writes.filter(isLegacyWrite)).toEqual([])
    expect(r.writes.filter((a) => isIntent(a, 'rollback'))).toEqual([])
  })

  it('L1: a legacy run that starts between step 2 and step 3 is included: stop in RETIRED, step 7 never runs', async () => {
    await seed({})
    const inject = JSON.stringify([
      { when: 'autopilot.update', autopilot: LEGACY, run: { status: 'running', offset_ms: 500 } },
    ])
    const r = await cut(['--start'], { FAKE_MULTICA_INJECT: inject })
    expect(r.json.stop).toMatchObject({ step: '4', next: 'wait' })
    expect(r.json.state).toBe('RETIRED')
    expect(sha(legacyOf(await read()).description)).toBe(sha(AFTER))
    expect(await admitLog()).toEqual([])
    expect(r.log.filter((a) => a[0] === 'autopilot' && a[1] === 'create')).toEqual([])
    // it ends; --resume continues at step 4 with no second legacy update
    await mutate((s) => (legacyOf(s).runs[0].status = 'completed'))
    const r2 = await cut(['--resume'])
    expect(r2.json.state).toBe('DONE')
    expect(r2.writes.filter(isLegacyWrite)).toEqual([])
    expect((await admitLog()).map((a) => a.dry)).toEqual([true, false])
  })

  it.each([
    ['ahead', 10 * 60_000],
    ['behind', -10 * 60_000],
  ])('T comes from the server: a local clock 10 min %s gives the same result', async (_n, skew) => {
    const now = new Date(Date.parse(SERVER) + skew).toISOString()
    // a run created at the retirement is waited for; one created later is not
    await seed({})
    const included = await cut(['--start'], {
      CUTOVER_NOW: now,
      FAKE_MULTICA_INJECT: JSON.stringify([
        { when: 'autopilot.update', autopilot: LEGACY, run: { status: 'running', offset_ms: 500 } },
      ]),
    })
    expect(included.json.stop).toMatchObject({ step: '4' })
    await seed({})
    const later = await cut(['--start'], {
      CUTOVER_NOW: now,
      FAKE_MULTICA_INJECT: JSON.stringify([
        { when: 'autopilot.update', autopilot: LEGACY, run: { status: 'running', offset_ms: 5000 } },
      ]),
    })
    expect(later.json.state).toBe('DONE')
  })

  it('partial cutover: killed after step 3, a new process --resume reads T from the live state and ends with one active new autopilot', async () => {
    await seed({})
    const killed = await cut(['--start'], { FAKE_MULTICA_FAULT: 'autopilot.update:kill-after' })
    expect(killed.signal).toBe('SIGKILL')
    const mid = await read()
    expect(sha(legacyOf(mid).description)).toBe(sha(AFTER))
    expect(newApsOf(mid)).toEqual([])
    const r = await cut(['--resume'])
    expect(r.json.state_before).toBe('RETIRED')
    expect(r.json.state).toBe('DONE')
    expect(r.writes.filter(isLegacyWrite)).toEqual([])
    const s = await read()
    expect(newApsOf(s).filter((a) => a.status === 'active')).toHaveLength(1)
  })

  it.each([
    ['5', { stray: true, fault: 'issue.update#2:crash' }],
    ['6', { env: { FAKE_ADMIT_FAIL: 'dry' } }],
    ['7', { env: { FAKE_ADMIT_FAIL: 'live' } }],
    ['8', { fault: 'autopilot.trigger-add:crash' }],
  ])(
    'a failure at step %s after retirement: the same process rolls back, restores the before-hash and leaves no active new autopilot',
    async (step, o: Obj) => {
      await seed({
        issues: o.stray
          ? [issue(7400, { title: 'task(doop): merge upstream doop 0.15.1 into cheese/main', status: 'todo' })]
          : [],
      })
      const git = { FAKE_GIT_TAGS: JSON.stringify({ 'v0.15.1': 'd'.repeat(40) }) }
      const r = await cut(['--start'], {
        ...git,
        ...(o.env ?? {}),
        ...(o.fault ? { FAKE_MULTICA_FAULT: o.fault } : {}),
      })
      expect(r.code).not.toBe(0)
      expect(r.json.stop).toMatchObject({ step, next: 'blocked' })
      const s = await read()
      expect(sha(legacyOf(s).description)).toBe(BEFORE_SHA)
      expect(legacyOf(s).title).toBe(OLD_TITLE)
      expect(newApsOf(s).filter((a) => a.status === 'active')).toEqual([])
      expect(s.issues.find((i: Obj) => i.title === LEDGER_TITLE).metadata.cutover_intent).toBe('rolled_back')
      const ri = r.writes.findIndex((a) => isIntent(a, 'rollback'))
      const ret = r.writes.findIndex(isRetire)
      const res = r.writes.findIndex(isRestore)
      expect(ret).toBeGreaterThanOrEqual(0)
      expect(ri).toBeGreaterThan(ret)
      expect(res).toBeGreaterThan(ri)
      const pause = r.writes.findIndex((a) => a[0] === 'autopilot' && a.includes('paused'))
      if (pause >= 0) expect(pause).toBeGreaterThan(ri)
    },
  )

  it('an unparseable legacy sync issue at step 5: rollback, then stop with an alert', async () => {
    await seed({ issues: [issue(7401, { title: 'task(doop): merge upstream doop soon', status: 'todo' })] })
    const r = await cut(['--start'])
    expect(r.json.stop).toMatchObject({ step: '5', next: 'blocked' })
    expect(JSON.stringify(r.json.alerts)).toContain('CHE-7401')
    const s = await read()
    expect(sha(legacyOf(s).description)).toBe(BEFORE_SHA)
    expect(newApsOf(s)).toEqual([])
    expect(await admitLog()).toEqual([])
    expect(issueOf(s, 'CHE-7401').parent_issue_id).toBeNull()
  })

  it('step 5 adopts a stray sync issue: parent = ledger, upstream_sync_sha from the tag commit', async () => {
    await seed({
      issues: [issue(7400, { title: 'task(doop): merge upstream doop 0.15.1 into cheese/main', status: 'todo' })],
    })
    const r = await cut(['--start'], { FAKE_GIT_TAGS: JSON.stringify({ 'v0.15.1': 'd'.repeat(40) }) })
    expect(r.json.state).toBe('DONE')
    const s = await read()
    const ledger = s.issues.find((i: Obj) => i.title === LEDGER_TITLE)
    expect(issueOf(s, 'CHE-7400')).toMatchObject({ parent_issue_id: ledger.id })
    expect(issueOf(s, 'CHE-7400').metadata.upstream_sync_sha).toBe('d'.repeat(40))
    expect(r.log.some((a) => a[1] === 'update' && a[2] === 'CHE-7400' && a.includes('--no-start'))).toBe(true)
  })

  it('a drain timeout at step 4: --resume 3 h after cutover_stopped_at writes rollback, then restores the old route', async () => {
    await seed({})
    const inject = JSON.stringify([
      { when: 'autopilot.update', autopilot: LEGACY, run: { status: 'running', offset_ms: 500 } },
    ])
    const first = await cut(['--start'], { FAKE_MULTICA_INJECT: inject })
    expect(first.json.stop.step).toBe('4')
    const ledger = (await read()).issues.find((i: Obj) => i.title === LEDGER_TITLE)
    expect(ledger.metadata.cutover_stopped_at).toBeTruthy()
    // 2 h later: still waiting, no writes
    const early = await cut(['--resume'], { CUTOVER_NOW: new Date(Date.parse(NOW) + 2 * H).toISOString() })
    expect(early.json.stop).toMatchObject({ step: '4', next: 'wait' })
    expect(early.writes).toEqual([])
    const late = await cut(['--resume'], { CUTOVER_NOW: new Date(Date.parse(NOW) + 3 * H + 60_000).toISOString() })
    expect(late.json.stop).toMatchObject({ next: 'blocked' })
    expect(isIntent(late.writes[0], 'rollback')).toBe(true)
    const s = await read()
    expect(sha(legacyOf(s).description)).toBe(BEFORE_SHA)
    expect(s.issues.find((i: Obj) => i.title === LEDGER_TITLE).metadata.cutover_intent).toBe('rolled_back')
    expect(await admitLog()).toEqual([])
  })
})

/* ---- rollback ---- */
describe('rollback', () => {
  it('with an in-flight new-route run: the new route is paused and the old text waits until that run is terminal', async () => {
    await seed({ ...DONE_WORLD, newAp: { status: 'active', trigger: true, runs: [run('r-new', 'running')] } })
    const r = await cut(['--rollback'])
    expect(r.json.stop).toMatchObject({ step: 'rollback.3', next: 'wait' })
    expect(isIntent(r.writes[0], 'rollback')).toBe(true)
    let s = await read()
    expect(s.autopilots['ap-new'].status).toBe('paused')
    expect(sha(legacyOf(s).description)).toBe(sha(AFTER))
    expect(r.writes.filter(isRestore)).toEqual([])
    expect(s.wakeups[0]).toMatchObject({ issue: 's1b' })
    expect(s.wakeups[0].flags['task-id']).toBe('task-r-new')
    await mutate((st) => (st.autopilots['ap-new'].runs[0].status = 'completed'))
    const r2 = await cut(['--resume'])
    s = await read()
    expect(sha(legacyOf(s).description)).toBe(BEFORE_SHA)
    expect(s.issues.find((i: Obj) => i.title === LEDGER_TITLE).metadata.cutover_intent).toBe('rolled_back')
    expect(r2.json.state).toBe('FRESH')
    onlyPromotesChildren(
      [...r.writes, ...r2.writes].filter(
        (a) => a[0] === 'issue' && ['create', 'status', 'update'].includes(a[1] ?? ''),
      ),
    )
  })

  describe('K1: a wake during a rollback, after a kill with the new route paused and its last run in flight', () => {
    const killedRollback = async () => {
      await seed({ ...DONE_WORLD, newAp: { status: 'active', trigger: true, runs: [run('r-new', 'running')] } })
      const k = await cut(['--rollback'], { FAKE_MULTICA_FAULT: 'autopilot.update:kill-after' })
      expect(k.signal).toBe('SIGKILL')
      const s = await read()
      expect(s.autopilots['ap-new'].status).toBe('paused')
      expect(sha(legacyOf(s).description)).toBe(sha(AFTER))
    }
    it('after the run completes: restores the old route, never activates the new one, never runs admit', async () => {
      await killedRollback()
      await mutate((s) => (s.autopilots['ap-new'].runs[0].status = 'completed'))
      const before = (await read()).autopilots['ap-new'].triggers.length
      const r = await cut(['--resume'])
      const s = await read()
      expect(r.json.state_before).toBe('ROLLBACK')
      expect(sha(legacyOf(s).description)).toBe(BEFORE_SHA)
      expect(s.autopilots['ap-new'].status).toBe('paused')
      expect(s.autopilots['ap-new'].triggers).toHaveLength(before)
      expect(r.log.filter((a) => a[0] === 'autopilot' && ['create', 'trigger-add'].includes(a[1] ?? ''))).toEqual([])
      expect(await admitLog()).toEqual([])
    })
    it('after the 3 h timeout with the run still in flight: blocked, intent stays rollback, nothing activated', async () => {
      await killedRollback()
      await cut(['--resume'])
      const r = await cut(['--resume'], { CUTOVER_NOW: new Date(Date.parse(NOW) + 3 * H + 60_000).toISOString() })
      const s = await read()
      expect(r.json.stop).toMatchObject({ step: 'rollback.3', next: 'blocked' })
      expect(JSON.stringify(r.json.stop)).toContain('r-new')
      expect(s.issues.find((i: Obj) => i.title === LEDGER_TITLE).metadata.cutover_intent).toBe('rollback')
      expect(s.autopilots['ap-new'].status).toBe('paused')
      expect(r.log.filter((a) => a[0] === 'autopilot' && ['create', 'trigger-add'].includes(a[1] ?? ''))).toEqual([])
      expect(await admitLog()).toEqual([])
    })
  })

  it('intent write fails at rollback step 1: no pause and no other write', async () => {
    await seed(DONE_WORLD)
    const r = await cut(['--rollback'], { FAKE_MULTICA_FAULT: 'issue.metadata:crash' })
    expect(r.code).not.toBe(0)
    expect(r.json.stop.step).toBe('rollback.1')
    expect(r.writes).toHaveLength(1) // the crashed intent write itself; it was not applied
    const s = await read()
    expect(s.autopilots['ap-new'].status).toBe('active')
    expect(sha(legacyOf(s).description)).toBe(sha(AFTER))
    expect(s.issues.find((i: Obj) => i.title === LEDGER_TITLE).metadata.cutover_intent).toBe('forward')
  })

  describe('one older claimed child S and one newer waiting child W (L2, M1)', () => {
    const hold: World = { ...DONE_WORLD, issues: [W()] }
    const holdWorld = async () => {
      await seed(hold)
      const r = await cut(['--rollback'])
      return r
    }

    it('holds, then promotes W once when S ends, restores the old route and writes rolled_back', async () => {
      const files = () => fakeCli(state)
      const r = await holdWorld()
      // 1. after the rollback run
      expect(r.json.stop).toMatchObject({ step: 'rollback.4', next: 'wait' })
      let s = await read()
      expect(sha(legacyOf(s).description)).toBe(sha(AFTER))
      expect(issueOf(s, 'ledger-1').metadata.cutover_intent).toBe('rollback')
      expect(issueOf(s, 'CHE-9101').status).toBe('backlog')
      expect(s.autopilots['ap-new'].status).toBe('paused')
      expect(issueOf(s, 's1b').status).toBe('in_progress')
      expect(s.wakeups).toHaveLength(1)
      expect(s.wakeups[0]).toMatchObject({ issue: 's1b' })
      expect(s.wakeups[0].flags).toMatchObject({
        'until-issue': 'i-7205',
        'until-issue-state': 'ended',
        'expires-in': '504h',
        'on-timeout': 'wake',
      })
      expect(s.wakeups[0].flags.instruction).toMatch(/release wake: run cutover\.mjs --release-waiting/)
      const issuesBefore = s.issues.length
      // 2. a legacy-route run while S is claimed: W stays backlog, nothing filed
      const cli = files()
      const part = runLegacyPartC({ cli, tag: 'v0.16.0', commit: 'b'.repeat(40), inMain: false })
      expect(part.ended).toBe('no-part-c')
      s = await read()
      expect(issueOf(s, 'CHE-9101').status).toBe('backlog')
      expect(s.issues).toHaveLength(issuesBefore)
      // 3. S goes done; the release wake runs --release-waiting
      await mutate((st) => (issueOf(st, 'CHE-7205').status = 'done'))
      const rel = await cut(['--release-waiting'])
      s = await read()
      const promotes = rel.writes.filter((a) => a[0] === 'issue' && a[1] === 'update' && a.includes('todo'))
      expect(promotes).toHaveLength(1)
      expect(promotes[0]).toEqual(expect.arrayContaining(['CHE-9101', '--expected-revision', '3']))
      expect(issueOf(s, 'CHE-9101').status).toBe('todo')
      expect(sha(legacyOf(s).description)).toBe(BEFORE_SHA)
      expect(issueOf(s, 'ledger-1').metadata.cutover_intent).toBe('rolled_back')
      expect(rel.log.findIndex(isRestore)).toBeGreaterThan(
        rel.log.findIndex((a) => a[1] === 'update' && a.includes('todo')),
      )
      onlyPromotesChildren(
        [...r.writes, ...rel.writes].filter(
          (a) => a[0] === 'issue' && ['create', 'status', 'update'].includes(a[1] ?? ''),
        ),
      )
      // 4. a legacy-route run with the restored text: the moving rule finds W in todo, writes nothing
      const n = s.log.filter(isWrite).length
      const again = runLegacyPartC({ cli, tag: 'v0.16.0', commit: 'b'.repeat(40), inMain: false })
      expect(again.ended).toBe('open-for-version')
      s = await read()
      expect(s.log.filter(isWrite).length).toBe(n)
      expect(s.issues).toHaveLength(issuesBefore)
      // 5. the same release wake delivered twice: no second write
      const twice = await cut(['--release-waiting'])
      expect(twice.writes).toEqual([])
    })

    it('control: restoring the before-text while W is still backlog lets the legacy route promote W (why step 5 waits)', async () => {
      await holdWorld()
      await mutate((s) => {
        legacyOf(s).description = BEFORE
        legacyOf(s).title = OLD_TITLE
      })
      runLegacyPartC({ cli: fakeCli(state), tag: 'v0.16.0', commit: 'b'.repeat(40), inMain: false })
      expect(issueOf(await read(), 'CHE-9101').status).toBe('todo')
    })

    it('S cancelled: W is promoted once', async () => {
      await holdWorld()
      await mutate((st) => (issueOf(st, 'CHE-7205').status = 'cancelled'))
      const rel = await cut(['--release-waiting'])
      const s = await read()
      expect(rel.writes.filter((a) => a[1] === 'update' && a.includes('todo'))).toHaveLength(1)
      expect(issueOf(s, 'CHE-9101').status).toBe('todo')
      expect(sha(legacyOf(s).description)).toBe(BEFORE_SHA)
    })

    it('a resume wake during HOLD: no promotion, no restore, and the release wakeup stays', async () => {
      await holdWorld()
      const r = await cut(['--resume'])
      expect(r.json.stop).toMatchObject({ step: 'rollback.4', next: 'wait' })
      expect(r.writes).toEqual([])
      const s = await read()
      expect(s.wakeups).toHaveLength(1)
      expect(issueOf(s, 'CHE-9101').status).toBe('backlog')
      expect(sha(legacyOf(s).description)).toBe(sha(AFTER))
    })

    it('the release wakeup is renewed once at 504 h, then S1b goes blocked naming S and W', async () => {
      await holdWorld()
      const t1 = new Date(Date.parse(NOW) + 505 * H).toISOString()
      const a = await cut(['--release-waiting'], { CUTOVER_NOW: t1 })
      expect(a.json.stop).toMatchObject({ step: 'rollback.4', next: 'wait' })
      expect((await read()).wakeups).toHaveLength(2)
      const t2 = new Date(Date.parse(t1) + 505 * H).toISOString()
      const b = await cut(['--release-waiting'], { CUTOVER_NOW: t2 })
      expect(b.json.stop.next).toBe('blocked')
      expect(JSON.stringify(b.json.stop)).toMatch(/CHE-7205/)
      expect(JSON.stringify(b.json.stop)).toMatch(/CHE-9101/)
      const s = await read()
      expect(s.wakeups).toHaveLength(2)
      expect(issueOf(s, 'CHE-9101').status).toBe('backlog')
      expect(sha(legacyOf(s).description)).toBe(sha(AFTER))
    })
  })

  it('a waiting child with no claimed older child is promoted inside the rollback', async () => {
    await seed({ ...DONE_WORLD, issues: [W()] })
    await mutate((s) => (issueOf(s, 'CHE-7205').status = 'done'))
    const r = await cut(['--rollback'])
    const s = await read()
    expect(issueOf(s, 'CHE-9101').status).toBe('todo')
    expect(sha(legacyOf(s).description)).toBe(BEFORE_SHA)
    expect(issueOf(s, 'ledger-1').metadata.cutover_intent).toBe('rolled_back')
    expect(s.wakeups).toEqual([])
    onlyPromotesChildren(
      r.writes.filter((a) => a[0] === 'issue' && ['create', 'status', 'update'].includes(a[1] ?? '')),
    )
  })

  it('SPLIT (before-hash, active new autopilot): rollback is written, then the new one is paused first', async () => {
    await seed({ intent: 'forward', adopted: true, newAp: { status: 'active', trigger: true } })
    const r = await cut(['--resume'])
    expect(r.json.state_before).toBe('SPLIT')
    expect(isIntent(r.writes[0], 'rollback')).toBe(true)
    expect(r.writes[1]?.slice(0, 2)).toEqual(['autopilot', 'update'])
    expect(r.writes[1]).toContain('paused')
    const s = await read()
    expect(s.autopilots['ap-new'].status).toBe('paused')
    expect(issueOf(s, 'ledger-1').metadata.cutover_intent).toBe('rolled_back')
    expect(r.writes.filter(isLegacyWrite)).toEqual([]) // already the before-text
  })

  it('ORPHAN (after-hash, no forward intent): rolls back', async () => {
    await seed({ ledger: true, legacy: 'after' })
    const r = await cut(['--resume'])
    expect(r.json.state_before).toBe('ORPHAN')
    expect(isIntent(r.writes[0], 'rollback')).toBe(true)
    const s = await read()
    expect(sha(legacyOf(s).description)).toBe(BEFORE_SHA)
    expect(issueOf(s, 'ledger-1').metadata.cutover_intent).toBe('rolled_back')
  })

  it('--rollback from FRESH has nothing to roll back and writes nothing', async () => {
    await seed({ intent: 'rolled_back' })
    const r = await cut(['--rollback'])
    expect(r.writes).toEqual([])
  })
})

/* ---- the fake legacy route and the fake CLI ---- */
describe('control: the fake legacy route', () => {
  it('has no part C with the after-text and acts with the before-text', async () => {
    await seed({ ...DONE_WORLD, legacy: 'after', issues: [W()] })
    const cli = fakeCli(state)
    expect(runLegacyPartC({ cli, tag: 'v0.16.0', commit: 'b'.repeat(40), inMain: false }).ended).toBe('no-part-c')
  })
})
