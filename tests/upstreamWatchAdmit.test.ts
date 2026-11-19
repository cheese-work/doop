import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { chmodSync } from 'node:fs'
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// every test spawns several real processes (node, git, the wrapper scripts); allow for a loaded host
vi.setConfig({ testTimeout: 60_000 })

/* CLI-boundary tests of scripts/upstream-watch/admit.mjs against the fake multica CLI (CHE-7207 S1c). */

const ADMIT = path.resolve('scripts/upstream-watch/admit.mjs')
const FAKE_MULTICA = path.resolve('tests/fixtures/fake-multica/multica.mjs')
const FAKE_GH = path.resolve('tests/fixtures/fake-gh.mjs')
const SQUAD = 'a1073a68-4965-44ff-a8fb-244341935110'
const PROJECT = 'a8809cf1-12d8-4e75-82ce-f398d6004e24'
const S9_AGENT = 'b47e8ae5-be3e-4abb-a91f-b4ac1e414b8c'
const GIT = process.env.GIT_BIN ?? 'git' // admit.mjs reads the same variable
const SHA_7205 = '9a4fb9ec442a982772b752004761eda3aca2633d'

// fake-CLI state and admit.mjs reports are free-form JSON
// eslint-disable-next-line typescript/no-explicit-any
type Json = Record<string, any>
let root: string // shared: wrappers + upstream repo
let upstream: string
let c15: string
let c16: string
let dir: string // per test
let state: string

const sh = (cmd: string, args: string[], cwd: string) =>
  execFileSync(cmd === 'git' ? GIT : cmd, args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' },
  }).trim()

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'admit-root-'))
  upstream = path.join(root, 'upstream')
  await sh('git', ['init', '-q', upstream], root)
  const commit = (m: string) => {
    sh('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', m], upstream)
    return sh('git', ['rev-parse', 'HEAD'], upstream)
  }
  c15 = commit('0.15.0')
  sh('git', ['tag', 'v0.15.0'], upstream)
  c16 = commit('0.16.0')
  sh('git', ['tag', '-a', '-m', 'annotated', 'v0.16.0'], upstream) // annotated: the commit is the peeled one
  sh('git', ['tag', 'v0.16.0-rc.1'], upstream) // pre-release, never stable
  for (const [name, file] of [
    ['multica', FAKE_MULTICA],
    ['gh', FAKE_GH],
  ] as const)
    await writeFile(path.join(root, name), `#!/bin/sh\nexec node ${file} "$@"\n`).then(() =>
      chmodSync(path.join(root, name), 0o755),
    )
})
afterAll(() => rm(root, { recursive: true, force: true }))

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'admit-'))
  state = path.join(dir, 'state.json')
  return async () => rm(dir, { recursive: true, force: true })
})

/* ---- fixtures ---- */
const LEDGER = {
  id: 'ledger-1',
  identifier: 'CHE-9000',
  number: 9000,
  title: 'chore(doop): upstream sync ledger (CHE-7207)',
  description: 'Index only. On any wake, end with a check-in.',
  status: 'backlog',
  revision: 1,
  parent_issue_id: null,
  metadata: {},
}
let seq = 8000
const kid = (o: Json): Json => {
  const number = o.number ?? ++seq
  return {
    id: `id-${number}`,
    identifier: `CHE-${number}`,
    number,
    status: 'backlog',
    revision: 3,
    parent_issue_id: 'ledger-1',
    stage: 0,
    metadata: {},
    comments: [],
    duplicate_of: null,
    ...o,
  }
}
const fresh = (version: string, commit: string, o: Json = {}) =>
  kid({
    title: `task(doop): merge upstream doop ${version} into cheese/main`,
    description: `Upstream: kgoedecke/doop v${version} commit ${commit}\n\nbody`,
    ...o,
  })
const che7205 = () =>
  kid({
    number: 7205,
    title: 'task(doop): merge upstream doop 0.15.0 into cheese/main and redeploy on C00',
    description: 'Readiness: ready\nrepo cheese-work/doop',
    status: 'in_progress',
    metadata: { upstream_sync_sha: SHA_7205 },
  })
const S9 = (o: Json = {}) => ({
  id: 's9-id',
  identifier: 'CHE-9009',
  number: 9009,
  title: 'S9 measure',
  status: 'in_progress',
  revision: 1,
  parent_issue_id: null,
  metadata: {},
  ...o,
})

type World = { children?: Json[]; ledgerMeta?: Json; s9?: Json | null; env?: Record<string, string> }
const FOUND_ALL = JSON.stringify([
  { tag_name: 'v0.16.0', published_at: '2026-11-20T08:00:00Z' },
  { tag_name: 'v0.15.0', published_at: '2026-11-16T08:29:00Z' },
])
async function seedWorld(file: string, w: World) {
  const issues = [{ ...LEDGER, metadata: w.ledgerMeta ?? {} }, ...(w.children ?? []), ...(w.s9 ? [w.s9] : [])]
  await writeFile(file, JSON.stringify({ nextNumber: 9100, issues }))
}
const env = (file: string, w: World, extra: Record<string, string> = {}) => ({
  ...process.env,
  MULTICA_CLI_PATH: path.join(root, 'multica'),
  GH_BIN: path.join(root, 'gh'),
  GIT_BIN: GIT,
  UPSTREAM_REPO_URL: upstream,
  FAKE_MULTICA_STATE: file,
  FAKE_GH_COMPARE: 'diverged',
  FAKE_GH_RELEASES: FOUND_ALL,
  ADMIT_NOW: '2026-11-20T09:00:00Z',
  ...w.env,
  ...extra,
})
const args = (a: string[]) => ['--ledger', 'ledger-1', ...a]

/** Run admit.mjs once against the state file; the tests parse the printed report. */
function admit(w: World, a: string[] = [], extra: Record<string, string> = {}, file = state) {
  const r = spawnSync('node', [ADMIT, ...args(a)], { env: env(file, w, extra), encoding: 'utf8', cwd: dir })
  let json: Json = {}
  try {
    json = JSON.parse(r.stdout)
  } catch {
    // not JSON
  }
  return { code: r.status, out: r.stdout, err: r.stderr, json }
}
const admitAsync = (w: World, extra: Record<string, string> = {}) =>
  new Promise<number | null>((resolve) => {
    const p = spawn('node', [ADMIT, ...args([])], { env: env(state, w, extra), stdio: 'ignore', cwd: dir })
    p.on('close', resolve)
  })

const st = async (file = state): Promise<Json> => JSON.parse(await readFile(file, 'utf8'))
const WRITE = new Set(['create', 'update', 'status', 'assign', 'comment', 'metadata'])
const isWrite = (argv: string[]) =>
  (argv[0] === 'issue' && WRITE.has(argv[1] ?? '') && !(argv[1] === 'comment' && argv[2] !== 'add')) ||
  (argv[0] === 'issue' && argv[1] === 'wakeup' && argv[2] === 'create') ||
  (argv[0] === 'issue' && argv[1] === 'metadata' && argv[2] === 'set')
const writes = (s: Json) => s.log.filter((l: Json) => isWrite(l.argv)).map((l: Json) => l.argv)
const promotes = (s: Json) =>
  s.log.filter((l: Json) => l.argv[1] === 'update' && l.argv.includes('--status') && l.argv.includes('todo'))
const byNumber = (s: Json, n: number) => s.issues.find((i: Json) => i.number === n)
const kids = (s: Json) => s.issues.filter((i: Json) => i.parent_issue_id === 'ledger-1')

/** Learn which call of a full run matches, on a throwaway copy of the same world: robust to call order. */
async function callIndex(w: World, match: (argv: string[]) => boolean, a: string[] = []) {
  const scratch = path.join(dir, 'probe.json')
  await seedWorld(scratch, w)
  admit(w, a, {}, scratch)
  const hits = (await st(scratch)).log.filter((l: Json) => match(l.argv))
  expect(hits.length, 'the probe run never made the call').toBeGreaterThan(0)
  return hits[0].n as number
}
const isCreate = (a: string[]) => a[0] === 'issue' && a[1] === 'create'
const isCancel = (a: string[]) => a[1] === 'status' && a.includes('cancelled')
const isPromote = (a: string[]) => a[1] === 'update' && a.includes('todo')
const isWakeupCreate = (a: string[]) => a[1] === 'wakeup' && a[2] === 'create'
const isSeenSet = (a: string[]) => a[1] === 'metadata' && a.includes('seen_tags')

describe('admit.mjs: admission through the CLI', () => {
  it('creates the child with the atomic identity fields, then promotes it', async () => {
    const w: World = {}
    await seedWorld(state, w)
    const r = admit(w)
    expect(r.code).toBe(0)
    const s = await st()
    const [c] = kids(s)
    expect(kids(s)).toHaveLength(1)
    expect(c).toMatchObject({
      title: 'task(doop): merge upstream doop 0.16.0 into cheese/main',
      status: 'todo',
      parent_issue_id: 'ledger-1',
      project_id: PROJECT,
      assignee_id: SQUAD,
      priority: 'high',
      properties: { Readiness: 'ready' },
    })
    expect(c.description.split('\n')[0]).toBe(`Upstream: kgoedecke/doop v0.16.0 commit ${c16}`)
    expect(c.description).toContain(
      'git fetch https://github.com/kgoedecke/doop.git "refs/tags/v0.16.0:refs/tags/v0.16.0"',
    )
    expect(c.description).toContain(`test "$(git rev-parse 'v0.16.0^{commit}')" = "${c16}"`)
    expect(promotes(s)).toHaveLength(1)
  })

  it('crash after create, then rerun: exactly 1 child, in todo', async () => {
    const w: World = {}
    await seedWorld(state, w)
    const at = await callIndex(w, isCreate)
    await seedWorld(state, w)
    const r1 = admit(w, [], { FAKE_MULTICA_FAULT: `${at}:crash-after` })
    expect(r1.code).not.toBe(0)
    expect(kids(await st())).toHaveLength(1) // the child exists, still in backlog
    expect(kids(await st())[0].status).toBe('backlog')
    admit(w)
    const s = await st()
    expect(kids(s)).toHaveLength(1)
    expect(kids(s)[0].status).toBe('todo')
    expect(promotes(s)).toHaveLength(1)
  })

  it('crash after the duplicate cancel, then rerun: the survivor is promoted once', async () => {
    const w: World = { children: [fresh('0.16.0', c16, { number: 8101 }), fresh('0.16.0', c16, { number: 8102 })] }
    await seedWorld(state, w)
    const at = await callIndex(w, isCancel)
    await seedWorld(state, w)
    admit(w, [], { FAKE_MULTICA_FAULT: `${at}:kill-after` })
    let s = await st()
    expect(byNumber(s, 8102)).toMatchObject({ status: 'cancelled', duplicate_of: 'CHE-8101' })
    expect(promotes(s)).toHaveLength(0)
    admit(w)
    s = await st()
    expect(byNumber(s, 8101).status).toBe('todo')
    expect(promotes(s)).toHaveLength(1)
    expect(s.log.filter((l: Json) => isCancel(l.argv))).toHaveLength(1)
  })

  it('2 concurrent runs: exactly 1 status write to todo', async () => {
    const w: World = {}
    await seedWorld(state, w)
    const codes = await Promise.all([admitAsync(w), admitAsync(w)])
    expect(codes).toEqual([0, 0])
    const s = await st()
    const live = kids(s).filter((i: Json) => i.status !== 'cancelled')
    expect(live).toHaveLength(1)
    expect(live[0].status).toBe('todo')
    // a loser may attempt a stale compare-and-set, but the CLI rejects it: one applied write
    expect(promotes(s).filter((l: Json) => l.ok)).toHaveLength(1)
  })

  it('a revision conflict on promote: one re-read, no second write', async () => {
    const w: World = { children: [fresh('0.16.0', c16, { number: 8201 })] }
    await seedWorld(state, w)
    const at = await callIndex(w, isPromote)
    await seedWorld(state, w)
    const r = admit(w, [], { FAKE_MULTICA_FAULT: `${at}:conflict` })
    const s = await st()
    expect(promotes(s)).toHaveLength(1) // the attempt that conflicted; no retry loop
    const after = s.log.filter((l: Json) => l.n > at && l.argv[1] === 'get' && l.argv.includes('CHE-8201'))
    expect(after.length).toBe(1) // exactly one re-read of the child
    expect(byNumber(s, 8201).status).toBe('backlog')
    expect(r.json.alerts.map((a: Json) => a.code)).toContain('promote-conflict')
  })

  it('crash after promotion and before the hand-off, then rerun: the hand-off is written once', async () => {
    const w: World = { children: [fresh('0.16.0', c16, { number: 8301 })], s9: S9(), ledgerMeta: {} }
    await seedWorld(state, w)
    const at = await callIndex(w, isPromote)
    await seedWorld(state, w)
    admit(w, ['--s9', 's9-id'], { FAKE_MULTICA_FAULT: `${at}:kill-after` })
    let s = await st()
    expect(byNumber(s, 8301).status).toBe('todo')
    expect(s.wakeups).toHaveLength(0)
    admit(w, ['--s9', 's9-id'])
    admit(w, ['--s9', 's9-id']) // and a third run changes nothing
    s = await st()
    expect(s.wakeups).toHaveLength(1)
    expect(s.wakeups[0].flags).toMatchObject({
      'until-issue': 'id-8301',
      'until-issue-state': 'ended',
      'expires-in': '504h',
      'on-timeout': 'wake',
      'agent-id': S9_AGENT,
    })
    expect(s.issues.find((i: Json) => i.id === 's9-id').metadata.measure_sync_issue).toBe('CHE-8301')
  })

  it('crash between the wakeup and the key, then rerun: still one wakeup', async () => {
    const w: World = { children: [fresh('0.16.0', c16, { number: 8302, status: 'todo' })], s9: S9() }
    await seedWorld(state, w)
    const at = await callIndex(w, isWakeupCreate, ['--s9', 's9-id'])
    await seedWorld(state, w)
    admit(w, ['--s9', 's9-id'], { FAKE_MULTICA_FAULT: `${at}:kill-after` })
    expect((await st()).wakeups).toHaveLength(1)
    admit(w, ['--s9', 's9-id'])
    const s = await st()
    expect(s.wakeups).toHaveLength(1)
    expect(s.issues.find((i: Json) => i.id === 's9-id').metadata.measure_sync_issue).toBe('CHE-8302')
  })

  it('no hand-off when S9 is done, has the key, or there is no child after v0.15.0', async () => {
    for (const s9 of [S9({ status: 'done' }), S9({ metadata: { measure_sync_issue: 'CHE-1' } })]) {
      const w: World = { children: [fresh('0.16.0', c16, { number: 8303, status: 'todo' })], s9 }
      await seedWorld(state, w)
      admit(w, ['--s9', 's9-id'])
      expect((await st()).wakeups).toHaveLength(0)
    }
    const w: World = { children: [che7205()], s9: S9(), env: { FAKE_GH_COMPARE: 'ahead' } }
    await seedWorld(state, w)
    admit(w, ['--s9', 's9-id'])
    expect((await st()).wakeups).toHaveLength(0)
  })
})

describe('admit.mjs: repairs', () => {
  it('the seen_tags write fails, then rerun: repaired', async () => {
    const w: World = { env: { FAKE_GH_COMPARE: 'ahead' } } // C is in cheese/main: no admission action
    await seedWorld(state, w)
    const at = await callIndex(w, isSeenSet)
    await seedWorld(state, w)
    const r1 = admit(w, [], { FAKE_MULTICA_FAULT: `${at}:crash` })
    expect(r1.code).not.toBe(0)
    expect((await st()).issues[0].metadata.seen_tags).toBeUndefined()
    admit(w)
    const seen = (await st()).issues[0].metadata.seen_tags
    expect(seen).toEqual({
      'v0.16.0': { commit: c16, published_at: '2026-11-20T08:00:00Z', seen_at: '2026-11-20T09:00:00Z' },
    })
  })

  it('keeps the first seen_at and fills a missing published_at; a no-change run writes nothing', async () => {
    const old = { 'v0.16.0': { commit: c16, published_at: null, seen_at: '2026-11-19T00:00:00Z' } }
    const w: World = { ledgerMeta: { seen_tags: old }, env: { FAKE_GH_COMPARE: 'ahead' } }
    await seedWorld(state, w)
    admit(w)
    let s = await st()
    expect(s.issues[0].metadata.seen_tags['v0.16.0']).toEqual({
      commit: c16,
      published_at: '2026-11-20T08:00:00Z',
      seen_at: '2026-11-19T00:00:00Z',
    })
    const n = writes(s).length
    admit(w, [], { ADMIT_NOW: '2026-11-21T00:00:00Z' })
    s = await st()
    expect(writes(s).length).toBe(n)
  })
})

describe('admit.mjs: fail closed', () => {
  it.each([
    ['gh compare fails', { FAKE_GH_COMPARE: 'ERROR' }],
    ['git ls-remote fails', { UPSTREAM_REPO_URL: '/nonexistent/repo' }],
  ])('lookup failure (%s): 0 writes of any kind', async (_n, extra) => {
    const w: World = { s9: S9(), children: [fresh('0.15.1', c15, { number: 8401, status: 'todo' })] }
    await seedWorld(state, w)
    const r = admit(w, ['--s9', 's9-id'], extra)
    expect(r.json.alerts.map((a: Json) => a.code)).toEqual(['lookup-error'])
    expect(r.code).not.toBe(0)
    expect(writes(await st())).toEqual([])
  })

  it('an unparseable child: alert, 0 writes', async () => {
    const w: World = { children: [kid({ title: 'something else', description: 'x' })] }
    await seedWorld(state, w)
    const r = admit(w)
    expect(r.json.alerts.map((a: Json) => a.code)).toEqual(['unparseable'])
    expect(writes(await st())).toEqual([])
  })

  it('tag moved: alert only', async () => {
    const w: World = { children: [fresh('0.16.0', 'd'.repeat(40), { number: 8501 })] }
    await seedWorld(state, w)
    const r = admit(w)
    expect(r.json.alerts.map((a: Json) => a.code)).toEqual(['tag-moved'])
    expect(r.code).not.toBe(0)
    expect(writes(await st()).filter((a: string[]) => !isSeen(a))).toEqual([])
  })

  it('gh 404 on compare means the commit is not in cheese/main: admission goes on', async () => {
    const w: World = { env: { FAKE_GH_COMPARE: '404' } }
    await seedWorld(state, w)
    expect(admit(w).code).toBe(0)
    expect(kids(await st())[0].status).toBe('todo')
  })
})
const isSeen = (a: string[]) => a[1] === 'metadata' && a.includes('seen_tags')

describe('admit.mjs: the legacy CHE-7205 fixture', () => {
  it('with a v0.16.0 tag: one waiting child, nothing promoted, CHE-7205 untouched', async () => {
    const w: World = { children: [che7205()] }
    await seedWorld(state, w)
    admit(w)
    const s = await st()
    const added = kids(s).filter((i: Json) => i.number !== 7205)
    expect(added).toHaveLength(1)
    expect(added[0].status).toBe('backlog')
    expect(added[0].description.split('\n')[0]).toBe(`Upstream: kgoedecke/doop v0.16.0 commit ${c16}`)
    expect(added[0].description).toContain('Waits for: CHE-7205')
    expect(promotes(s)).toHaveLength(0)
    expect(byNumber(s, 7205)).toMatchObject({ status: 'in_progress', revision: 3 })
    admit(w) // the next run finds it and writes nothing new
    expect(kids(await st()).filter((i: Json) => i.number !== 7205)).toHaveLength(1)
  })

  it('retargets an older backlog child instead of creating a second one', async () => {
    const w: World = { children: [che7205(), fresh('0.15.5', 'e'.repeat(40), { number: 8601 })] }
    await seedWorld(state, w)
    admit(w)
    const s = await st()
    expect(kids(s)).toHaveLength(2)
    expect(byNumber(s, 8601)).toMatchObject({
      title: 'task(doop): merge upstream doop 0.16.0 into cheese/main',
      status: 'backlog',
    })
    expect(byNumber(s, 8601).description).toContain(`commit ${c16}`)
    expect(byNumber(s, 8601).description).toContain('Waits for: CHE-7205')
  })
})

describe('admit.mjs --dry-run', () => {
  it('prints the parsed ledger and the planned actions, and writes nothing', async () => {
    const w: World = { children: [che7205()], s9: S9() }
    await seedWorld(state, w)
    const r = admit(w, ['--dry-run', '--s9', 's9-id'])
    expect(r.code).toBe(0)
    expect(r.json.dryRun).toBe(true)
    expect(r.json.ledger.map((c: Json) => c.key)).toEqual(['CHE-7205'])
    expect(r.json.ledger[0]).toMatchObject({ version: '0.15.0', claimed: true })
    expect(r.json.actions.map((a: Json) => a.type)).toEqual(['create'])
    expect(writes(await st())).toEqual([])
    await copyFile(state, path.join(dir, 'after.json'))
  })
})
