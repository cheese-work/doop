import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/* Fake `multica` CLI (tests/fixtures/fake-multica) used by the upstream-watch tests (CHE-7207 S1a). */

const BIN = path.resolve('tests/fixtures/fake-multica/multica.mjs')
let dir: string
let state: string
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'fake-multica-'))
  state = path.join(dir, 'state.json')
})
afterEach(() => rm(dir, { recursive: true, force: true }))

const seed = (s: Record<string, unknown>) => writeFile(state, JSON.stringify(s))
const read = async () => JSON.parse(await readFile(state, 'utf8'))
const fake = (args: string[], env: Record<string, string> = {}) => {
  const r = spawnSync('node', [BIN, ...args], {
    env: { ...process.env, FAKE_MULTICA_STATE: state, ...env },
    encoding: 'utf8',
  })
  return { code: r.status, out: r.stdout, err: r.stderr, json: r.stdout.trim() ? safe(r.stdout) : null }
}
const safe = (s: string) => {
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}
const ledger = { id: 'ledger-1', identifier: 'CHE-9000', number: 9000, title: 'ledger', status: 'backlog', revision: 1 }
const child = (n: number, o: Record<string, unknown> = {}) => ({
  id: `c-${n}`,
  identifier: `CHE-${n}`,
  number: n,
  title: `child ${n}`,
  description: '',
  status: 'backlog',
  revision: 1,
  parent_issue_id: 'ledger-1',
  stage: 0,
  metadata: {},
  ...o,
})
const sha = (s: string) => createHash('sha256').update(s).digest('hex')

describe('fake multica: issues', () => {
  it('lists children of a parent, with revision and status', async () => {
    await seed({
      issues: [ledger, child(9001), child(9002, { status: 'done' }), child(9003, { parent_issue_id: 'other' })],
    })
    const r = fake(['issue', 'children', 'ledger-1', '--output', 'json'])
    expect(r.code).toBe(0)
    const issues = [...r.json.stages.flatMap((s: { issues: unknown[] }) => s.issues), ...r.json.unstaged]
    expect(issues.map((i: { identifier: string }) => i.identifier)).toEqual(['CHE-9001', 'CHE-9002'])
    expect(issues[0]).toMatchObject({ revision: 1, status: 'backlog' })
  })

  it('creates a child atomically with parent, status, assignee, project and property', async () => {
    await seed({ issues: [ledger] })
    const r = fake([
      'issue',
      'create',
      '--title',
      'T',
      '--description',
      'first line\nrest',
      '--parent',
      'ledger-1',
      '--status',
      'backlog',
      '--assignee-id',
      'sq-1',
      '--project',
      'p-1',
      '--priority',
      'high',
      '--property',
      'Readiness=ready',
      '--output',
      'json',
    ])
    expect(r.code).toBe(0)
    expect(r.json).toMatchObject({
      title: 'T',
      parent_issue_id: 'ledger-1',
      status: 'backlog',
      assignee_id: 'sq-1',
      revision: 1,
    })
    const kids = fake(['issue', 'children', 'ledger-1']).json.unstaged
    expect(kids).toHaveLength(1)
    expect(kids[0].properties).toMatchObject({ Readiness: 'ready' })
  })

  it('update with --expected-revision: match bumps revision, mismatch is a conflict with no write', async () => {
    await seed({ issues: [ledger, child(9001, { revision: 4 })] })
    const ok = fake(['issue', 'update', 'CHE-9001', '--status', 'todo', '--expected-revision', '4'])
    expect(ok.code).toBe(0)
    expect((await read()).issues.find((i: { id: string }) => i.id === 'c-9001')).toMatchObject({
      status: 'todo',
      revision: 5,
    })
    const stale = fake(['issue', 'update', 'CHE-9001', '--status', 'in_progress', '--expected-revision', '4'])
    expect(stale.code).not.toBe(0)
    expect(stale.err).toMatch(/conflict/i)
    expect((await read()).issues.find((i: { id: string }) => i.id === 'c-9001')).toMatchObject({
      status: 'todo',
      revision: 5,
    })
  })

  it('status cancelled --duplicate-of records the original; the flag needs cancelled', async () => {
    await seed({ issues: [ledger, child(9001), child(9002)] })
    expect(fake(['issue', 'status', 'CHE-9002', 'todo', '--duplicate-of', 'CHE-9001']).code).not.toBe(0)
    expect(fake(['issue', 'status', 'CHE-9002', 'cancelled', '--duplicate-of', 'CHE-9001']).code).toBe(0)
    expect((await read()).issues.find((i: { id: string }) => i.id === 'c-9002')).toMatchObject({
      status: 'cancelled',
      duplicate_of: 'CHE-9001',
    })
  })

  it('records comments, metadata and wakeups', async () => {
    await seed({ issues: [ledger] })
    await writeFile(path.join(dir, 'c.md'), 'hello body')
    expect(fake(['issue', 'comment', 'add', 'CHE-9000', '--content-file', path.join(dir, 'c.md')]).code).toBe(0)
    expect(
      fake([
        'issue',
        'metadata',
        'set',
        'CHE-9000',
        '--key',
        'seen_tags',
        '--value',
        '{"v0.16.0":1}',
        '--type',
        'string',
      ]).code,
    ).toBe(0)
    expect(
      fake(['issue', 'wakeup', 'create', 'CHE-9000', '--until-issue', 'CHE-7205', '--expires-in', '504h']).code,
    ).toBe(0)
    const s = await read()
    const l = s.issues.find((i: { id: string }) => i.id === 'ledger-1')
    expect(l.comments).toMatchObject([{ content: 'hello body' }])
    expect(l.metadata.seen_tags).toBe('{"v0.16.0":1}')
    expect(s.wakeups).toMatchObject([{ issue: 'ledger-1', flags: { 'until-issue': 'CHE-7205', 'expires-in': '504h' } }])
  })
})

describe('fake multica: autopilots', () => {
  const AP = {
    id: 'ap-1',
    title: 'old',
    description: 'before-text',
    status: 'active',
    updated_at: '2026-11-18T04:15:51Z',
    triggers: [],
    runs: [],
  }

  it('get returns updated_at; update is guarded by --if-description-sha256 and moves updated_at', async () => {
    await seed({ autopilots: { 'ap-1': AP } })
    expect(fake(['autopilot', 'get', 'ap-1']).json.autopilot.updated_at).toBe('2026-11-18T04:15:51Z')
    const bad = fake(['autopilot', 'update', 'ap-1', '--description', 'after', '--if-description-sha256', sha('nope')])
    expect(bad.code).not.toBe(0)
    expect(bad.err).toMatch(/conflict/i)
    expect(fake(['autopilot', 'get', 'ap-1']).json.autopilot.description).toBe('before-text')
    const ok = fake([
      'autopilot',
      'update',
      'ap-1',
      '--title',
      'new',
      '--description',
      'after',
      '--if-description-sha256',
      sha('before-text'),
    ])
    expect(ok.code).toBe(0)
    const got = fake(['autopilot', 'get', 'ap-1']).json.autopilot
    expect(got).toMatchObject({ title: 'new', description: 'after' })
    expect(Date.parse(got.updated_at)).toBeGreaterThan(Date.parse('2026-11-18T04:15:51Z'))
  })

  it('update --status paused, create, trigger-add', async () => {
    await seed({ autopilots: { 'ap-1': AP } })
    expect(fake(['autopilot', 'update', 'ap-1', '--status', 'paused']).code).toBe(0)
    expect(fake(['autopilot', 'get', 'ap-1']).json.autopilot.status).toBe('paused')
    const c = fake([
      'autopilot',
      'create',
      '--title',
      'Upstream release watch: doop',
      '--mode',
      'run_only',
      '--agent',
      'x99',
      '--project',
      'p',
      '--description',
      'd',
    ])
    expect(c.code).toBe(0)
    const id = c.json.autopilot.id
    expect(
      fake(['autopilot', 'trigger-add', id, '--cron', '30 4,10,16,22 * * *', '--timezone', 'Asia/Ho_Chi_Minh']).code,
    ).toBe(0)
    expect(fake(['autopilot', 'get', id]).json.autopilot).toMatchObject({
      status: 'active',
      triggers: [{ cron: '30 4,10,16,22 * * *', timezone: 'Asia/Ho_Chi_Minh' }],
    })
  })

  it('runs pages with --limit and --offset', async () => {
    const runs = Array.from({ length: 5 }, (_, i) => ({ id: `r${i}`, status: 'completed' }))
    await seed({ autopilots: { 'ap-1': { ...AP, runs } } })
    const page = (o: number) =>
      fake(['autopilot', 'runs', 'ap-1', '--limit', '2', '--offset', String(o)]).json.runs.map(
        (r: { id: string }) => r.id,
      )
    expect([page(0), page(2), page(4), page(6)]).toEqual([['r0', 'r1'], ['r2', 'r3'], ['r4'], []])
  })
})

describe('fake multica: faults, lock and kill', () => {
  const mk = (n: number) => ['issue', 'create', '--title', `t${n}`, '--parent', 'ledger-1', '--status', 'backlog']

  it('serializes concurrent callers with a file lock (distinct numbers, exact call count)', async () => {
    await seed({ issues: [ledger] })
    const run = (n: number) =>
      new Promise<number>((res) => {
        const p = spawn('node', [BIN, ...mk(n)], { env: { ...process.env, FAKE_MULTICA_STATE: state } })
        p.on('close', (c) => res(c ?? -1))
      })
    expect(await Promise.all(Array.from({ length: 8 }, (_, i) => run(i)))).toEqual(Array(8).fill(0))
    const s = await read()
    expect(new Set(s.issues.map((i: { number: number }) => i.number)).size).toBe(9)
    expect(s.calls).toBe(8)
  })

  it('crash at call N fails before the write; crash-after applies it, then fails', async () => {
    await seed({ issues: [ledger] })
    expect(fake(mk(1)).code).toBe(0)
    const before = fake(mk(2), { FAKE_MULTICA_FAULT: '2:crash' })
    expect(before.code).not.toBe(0)
    expect((await read()).issues).toHaveLength(2) // ledger + call 1 only
    const after = fake(mk(3), { FAKE_MULTICA_FAULT: '3:crash-after' })
    expect(after.code).not.toBe(0)
    expect((await read()).issues).toHaveLength(3)
  })

  it('conflict at call N: a concurrent writer bumps the revision first', async () => {
    await seed({ issues: [ledger, child(9001, { revision: 2 })] })
    const r = fake(['issue', 'update', 'CHE-9001', '--status', 'todo', '--expected-revision', '2'], {
      FAKE_MULTICA_FAULT: '1:conflict',
    })
    expect(r.code).not.toBe(0)
    expect(r.err).toMatch(/conflict/i)
    expect((await read()).issues.find((i: { id: string }) => i.id === 'c-9001')).toMatchObject({
      status: 'backlog',
      revision: 3,
    })
  })

  it('kill at call N: the caller dies with SIGKILL; a new process continues on the same state', async () => {
    await seed({ issues: [ledger] })
    const caller = `
      const { spawnSync } = require('node:child_process')
      for (const n of [1, 2, 3]) spawnSync('node', [${JSON.stringify(BIN)}, 'issue', 'create', '--title', 't' + n, '--parent', 'ledger-1', '--status', 'backlog'], { stdio: 'inherit' })
      console.log('survived')`
    const dead = spawnSync('node', ['-e', caller], {
      env: { ...process.env, FAKE_MULTICA_STATE: state, FAKE_MULTICA_FAULT: '2:kill-after' },
      encoding: 'utf8',
    })
    expect(dead.signal).toBe('SIGKILL')
    expect(dead.stdout).not.toContain('survived')
    expect((await read()).issues.map((i: { title: string }) => i.title)).toEqual(['ledger', 't1', 't2']) // t2 applied, t3 never ran
    expect(fake(mk(4)).code).toBe(0) // the fault fires once; a fresh process works
    expect((await read()).issues).toHaveLength(4)
  })
})
