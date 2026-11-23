import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error plain .mjs script, no type declarations
import { checkLedger, formatLedgerMarker, loadMigrations } from '../scripts/migration-ledger-check.mjs'

/* CHE-7207 S2: the PR-time ledger check. The base journal stands in for the C00 ledger (one row per base entry,
   hash = sha256 of its SQL bytes, created_at = its `when`); the head must keep every row and append only
   newer entries with a snapshot that chains from the base tail. */

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')
const B = 'b'.repeat(40)
const H = 'c'.repeat(40)

type Entry = { idx: number; version: string; when: number; tag: string; breakpoints: boolean }
type Snap = { id: string; prevId: string } | null
interface Side {
  journal: { entries: Entry[] }
  migrations: { name: string; sha256: string }[]
  snapshots: Record<string, Snap>
}
const tagOf = (i: number) => `${String(i).padStart(4, '0')}_m${i}`
const snapName = (i: number) => `${String(i).padStart(4, '0')}_snapshot.json`

/* entries 0..n-1: when = 1000 + i, sql = `sql <i>`, snapshot id s<i> chained from s<i-1> */
function side(n: number): Side {
  const entries: Entry[] = []
  const migrations: Side['migrations'] = []
  const snapshots: Side['snapshots'] = {}
  for (let i = 0; i < n; i++) {
    entries.push({ idx: i, version: '7', when: 1000 + i, tag: tagOf(i), breakpoints: true })
    migrations.push({ name: `${tagOf(i)}.sql`, sha256: sha256(`sql ${i}`) })
    snapshots[snapName(i)] = { id: `s${i}`, prevId: i === 0 ? '00000000' : `s${i - 1}` }
  }
  return { journal: { entries }, migrations, snapshots }
}
const clone = <T>(v: T): T => structuredClone(v)
const input = (base: Side, head: Side) => ({
  baseJournal: base.journal,
  baseMigrations: base.migrations,
  headJournal: head.journal,
  headMigrations: head.migrations,
  headSnapshots: head.snapshots,
})

describe('checkLedger', () => {
  const base = side(3)

  it('passes a valid append of one entry', () => {
    expect(checkLedger(input(base, side(4)))).toEqual({ ok: true, newMigrations: [`${tagOf(3)}.sql`] })
  })

  it('passes a head equal to the base (no new entries)', () => {
    expect(checkLedger(input(base, clone(base)))).toEqual({ ok: true, newMigrations: [] })
  })

  it('passes a valid append of several entries', () => {
    expect(checkLedger(input(base, side(6)))).toMatchObject({ ok: true })
  })

  it('red: the CHE-2734 `when` rewrite of an applied entry', () => {
    const head = side(4)
    head.journal.entries[1]!.when = 5000
    const r = checkLedger(input(base, head))
    expect(r.ok).toBe(false)
    expect(r.reason).toContain(`${tagOf(1)}`)
  })

  it('red: v0.15.0 upstream `when` values kept (an appended entry not newer than the ledger)', () => {
    const head = side(4)
    head.journal.entries[3]!.when = 1000 // upstream value, older than the base tail (1002)
    const r = checkLedger(input(base, head))
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/not newer than the ledger/)
  })

  it('red: changed SQL bytes of an applied migration', () => {
    const head = side(4)
    head.migrations[0] = { name: `${tagOf(0)}.sql`, sha256: sha256('edited') }
    const r = checkLedger(input(base, head))
    expect(r.ok).toBe(false)
    expect(r.reason).toContain(`${tagOf(0)}.sql`)
  })

  it('red: a reordered entry', () => {
    const head = side(4)
    const e = head.journal.entries
    ;[e[1], e[2]] = [e[2]!, e[1]!]
    const r = checkLedger(input(base, head))
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/changed, moved or deleted/)
  })

  it('red: a missing snapshot for an appended entry', () => {
    const head = side(4)
    delete head.snapshots[snapName(3)]
    const r = checkLedger(input(base, head))
    expect(r.ok).toBe(false)
    expect(r.reason).toContain(snapName(3))
  })

  it('red: an unreadable snapshot for an appended entry', () => {
    const head = side(4)
    head.snapshots[snapName(3)] = null
    expect(checkLedger(input(base, head)).ok).toBe(false)
  })

  it('red: a broken prevId on the first appended snapshot', () => {
    const head = side(4)
    head.snapshots[snapName(3)] = { id: 's3', prevId: 'not-s2' }
    const r = checkLedger(input(base, head))
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/prevId/)
  })

  it('red: a broken prevId in the middle of several appended snapshots', () => {
    const head = side(6)
    head.snapshots[snapName(4)] = { id: 's4', prevId: 'oops' }
    const r = checkLedger(input(base, head))
    expect(r.ok).toBe(false)
    expect(r.reason).toContain(snapName(4))
  })

  it('red: appended entries whose `when` does not strictly increase', () => {
    const head = side(5)
    head.journal.entries[4]!.when = head.journal.entries[3]!.when
    const r = checkLedger(input(base, head))
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/strictly increasing/)
  })

  it('red: an appended entry with no sql file', () => {
    const head = side(4)
    head.migrations.pop()
    expect(checkLedger(input(base, head)).ok).toBe(false)
  })

  it('red: a deleted applied entry', () => {
    const head = side(4)
    head.journal.entries.splice(0, 1)
    expect(checkLedger(input(base, head)).ok).toBe(false)
  })

  it('fails closed on an empty base ledger and unreadable input', () => {
    expect(checkLedger(input(side(0), side(2))).ok).toBe(false)
    expect(checkLedger({} as never).ok).toBe(false)
  })

  it('a legacy base entry with no snapshot does not fail the check', () => {
    const b = side(3)
    const h = side(4)
    delete b.snapshots[snapName(0)]
    delete h.snapshots[snapName(0)]
    expect(checkLedger(input(b, h)).ok).toBe(true)
  })
})

it('the marker is `migration-ledger-check OK base=<B> head=<H>`', () => {
  expect(formatLedgerMarker({ base: B, head: H })).toBe(`migration-ledger-check OK base=${B} head=${H}`)
})

/* The real files: the head is this repository's migrations, the base is the same files without the last N
   entries. A valid append of real data passes, so the 2 added rules agree with 0055-0065 as merged. */
describe('real server/db/migrations', () => {
  const dir = path.resolve('server/db/migrations')
  const read = (p: string) => readFileSync(path.join(dir, p), 'utf8')
  const journal = JSON.parse(read('meta/_journal.json')) as { entries: Entry[] }
  const snapshots = Object.fromEntries(
    readdirSync(path.join(dir, 'meta'))
      .filter((f) => f.endsWith('_snapshot.json'))
      .map((f) => [f, JSON.parse(read(`meta/${f}`)) as Snap]),
  )
  const migrations = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((name) => ({
      name,
      sha256: createHash('sha256')
        .update(readFileSync(path.join(dir, name)))
        .digest('hex'),
    }))

  it.each([1, 11])('appending the last %i real entries to the rest passes', (k) => {
    const keep = journal.entries.slice(0, -k)
    const r = checkLedger({
      baseJournal: { entries: keep },
      baseMigrations: migrations.filter((m) => keep.some((e) => `${e.tag}.sql` === m.name)),
      headJournal: journal,
      headMigrations: migrations,
      headSnapshots: snapshots,
    })
    expect(r).toMatchObject({ ok: true })
    expect(r.newMigrations).toHaveLength(k)
  })
})

/* The CLI: base files from git at MIGRATION_BASE_SHA, head files from the working tree. */
// git on a loaded host takes seconds per call and each test runs several; the runner's 5 s default is too short.
// Per test, not on the describe: `bun test` ignores a describe-level timeout.
const SLOW = 120_000

describe('CLI', () => {
  const script = path.resolve('scripts/migration-ledger-check.mjs')
  const roots: string[] = []
  afterEach(() => {
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
  })

  function write(root: string, s: Side) {
    const m = path.join(root, 'server/db/migrations')
    mkdirSync(path.join(m, 'meta'), { recursive: true })
    writeFileSync(path.join(m, 'meta/_journal.json'), JSON.stringify(s.journal, null, 2))
    for (const e of s.journal.entries) writeFileSync(path.join(m, `${e.tag}.sql`), `sql ${e.idx}`)
    for (const [f, v] of Object.entries(s.snapshots)) if (v) writeFileSync(path.join(m, 'meta', f), JSON.stringify(v))
  }

  function repo(baseSide: Side, headSide: Side) {
    const root = mkdtempSync(path.join(tmpdir(), 'ledger-check-'))
    roots.push(root)
    const git = (...a: string[]) =>
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: root, encoding: 'utf8' }).trim()
    git('init', '-q')
    write(root, baseSide)
    git('add', '-A')
    git('commit', '-qm', 'base')
    const baseSha = git('rev-parse', 'HEAD')
    rmSync(path.join(root, 'server'), { recursive: true })
    write(root, headSide)
    git('add', '-A')
    git('commit', '-q', '--allow-empty', '-m', 'head')
    return { root, baseSha, headSha: git('rev-parse', 'HEAD') }
  }

  const run = (root: string, env: Record<string, string>) =>
    spawnSync('node', [script], {
      cwd: root,
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env },
    })

  it(
    'prints the OK marker and exits 0 on a valid append',
    () => {
      const { root, baseSha, headSha } = repo(side(3), side(4))
      const r = run(root, { MIGRATION_BASE_SHA: baseSha, GITHUB_SHA: headSha })
      expect(r.stdout).toContain(`migration-ledger-check OK base=${baseSha} head=${headSha}`)
      expect(r.status).toBe(0)
    },
    SLOW,
  )

  it(
    'prints FAIL and exits 1 on a rewritten `when`',
    () => {
      const bad = side(4)
      bad.journal.entries[0]!.when = 9
      const { root, baseSha, headSha } = repo(side(3), bad)
      const r = run(root, { MIGRATION_BASE_SHA: baseSha, GITHUB_SHA: headSha })
      expect(r.stdout).toMatch(/^migration-ledger-check FAIL /m)
      expect(r.stdout).not.toContain('migration-ledger-check OK')
      expect(r.status).toBe(1)
    },
    SLOW,
  )

  it(
    'prints FAIL and exits 1 on changed SQL bytes',
    () => {
      const { root, baseSha, headSha } = repo(side(3), side(4))
      writeFileSync(path.join(root, 'server/db/migrations', `${tagOf(0)}.sql`), 'edited')
      const r = run(root, { MIGRATION_BASE_SHA: baseSha, GITHUB_SHA: headSha })
      expect(r.status).toBe(1)
      expect(r.stdout).toContain(`${tagOf(0)}.sql`)
    },
    SLOW,
  )

  it(
    'fails closed with no MIGRATION_BASE_SHA (S2a did not run)',
    () => {
      const { root, headSha } = repo(side(3), side(4))
      const r = run(root, { GITHUB_SHA: headSha })
      expect(r.stdout).toMatch(/^migration-ledger-check FAIL .*MIGRATION_BASE_SHA/m)
      expect(r.status).toBe(1)
    },
    SLOW,
  )

  it(
    'fails closed when the base commit is not in the checkout',
    () => {
      const { root, headSha } = repo(side(3), side(4))
      const r = run(root, { MIGRATION_BASE_SHA: 'd'.repeat(40), GITHUB_SHA: headSha })
      expect(r.status).toBe(1)
      expect(r.stdout).toMatch(/^migration-ledger-check FAIL /m)
    },
    SLOW,
  )

  it(
    'loadMigrations hashes the sql bytes of a directory',
    async () => {
      const { root } = repo(side(3), side(3))
      const m = await loadMigrations(path.join(root, 'server/db/migrations'))
      expect(m.migrations.map((x: { name: string }) => x.name)).toEqual([0, 1, 2].map((i) => `${tagOf(i)}.sql`))
      expect(m.snapshots[snapName(1)]).toEqual({ id: 's1', prevId: 's0' })
    },
    SLOW,
  )
})

/* The wiring: `lint` runs S2a (which exports MIGRATION_BASE_SHA) first, then this check, with no
   `continue-on-error` that would hide a failure. Text assertions, as in imageWorkflow.test.ts. */
it('the lint job runs migration-base, then the ledger check', () => {
  const ci = readFileSync('.github/workflows/ci.yml', 'utf8')
  const lint = /^ {2}lint:\n([\s\S]*?)(?=^ {2}[a-z][a-z0-9-]*:\n|(?![\s\S]))/m.exec(ci)?.[1] ?? ''
  const base = lint.indexOf('node scripts/ci/migration-base.mjs')
  const check = lint.indexOf('node scripts/migration-ledger-check.mjs')
  expect(base).toBeGreaterThan(-1)
  expect(check).toBeGreaterThan(base)
  expect(lint).not.toContain('continue-on-error')
})
