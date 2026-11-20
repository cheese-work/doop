import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  replayFromEnv,
  replayMigrations,
  // @ts-expect-error plain .mjs script, no type declarations
} from '../scripts/ci/migration-replay.mjs'
// @ts-expect-error plain .mjs script, no type declarations
import { parseReplayMarkers } from '../scripts/ci/migration-marker.mjs'

/* CHE-7207 S3b: the per-step migration replay. `migration-base.mjs` runs first in each `test (N)` shard and
   exports MIGRATION_*; the CI-bound case at the end replays base -> head from those and prints the marker. */

const MIGRATIONS = path.resolve(__dirname, '../server/db/migrations')
const sha = (c: string) => c.repeat(40)

type Entry = { idx: number; version: string; when: number; tag: string; breakpoints: boolean }
type Journal = { version: string; dialect: string; entries: Entry[] }
const readJournal = async (dir = MIGRATIONS): Promise<Journal> =>
  JSON.parse(await readFile(path.join(dir, 'meta/_journal.json'), 'utf8'))
const pad = (n: number) => String(n).padStart(4, '0')

// The real v0.14.0 sync: main's migrations through 0045 (base) and through 0054 (head). Current files
// 0000-0054 are byte-identical to the corrected sync commit, so the repo's own files are the fixture.
const BASE_TAG = '0045_'
const HEAD_TAG = '0054_'

let root: string
let seq = 0
const fresh = async () => {
  const dir = path.join(root, `d${seq++}`)
  await mkdir(path.join(dir, 'meta'), { recursive: true })
  return dir
}

// Copies the journal entries `from..to` (inclusive, by tag prefix) with their SQL and snapshots.
async function slice(to: string): Promise<{ dir: string; journal: Journal }> {
  const full = await readJournal()
  const last = full.entries.findIndex((e) => e.tag.startsWith(to))
  if (last < 0) throw new Error(`no journal entry ${to}`)
  const entries = full.entries.slice(0, last + 1)
  const dir = await fresh()
  for (const e of entries) {
    await cp(path.join(MIGRATIONS, `${e.tag}.sql`), path.join(dir, `${e.tag}.sql`))
    await cp(
      path.join(MIGRATIONS, `meta/${pad(e.idx)}_snapshot.json`),
      path.join(dir, `meta/${pad(e.idx)}_snapshot.json`),
    ).catch(() => {})
  }
  const journal = { ...full, entries }
  await writeFile(path.join(dir, 'meta/_journal.json'), JSON.stringify(journal))
  return { dir, journal }
}

async function rewriteJournal(dir: string, edit: (j: Journal) => void) {
  const j = await readJournal(dir)
  edit(j)
  await writeFile(path.join(dir, 'meta/_journal.json'), JSON.stringify(j))
}

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'doop-replay-test-'))
})
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('replayMigrations: the real v0.14.0 sync', () => {
  it('replays base 0045 -> head 0054 through all four steps', async () => {
    const base = await slice(BASE_TAG)
    const head = await slice(HEAD_TAG)
    const result = await replayMigrations({ baseDir: base.dir, headDir: head.dir })
    expect(result).toEqual({ ok: true, base: base.journal.entries.length, appended: 9 })
  }, 300_000)

  it('passes when nothing was appended (head equals base)', async () => {
    const base = await slice(BASE_TAG)
    const result = await replayMigrations({ baseDir: base.dir, headDir: base.dir })
    expect(result).toMatchObject({ ok: true, appended: 0 })
  }, 300_000)
})

describe('replayMigrations: fixtures that must fail', () => {
  it('(a) a renumbered head that kept the upstream `when` values fails at step 1', async () => {
    const base = await slice(BASE_TAG)
    const head = await slice(HEAD_TAG)
    const tail = base.journal.entries.at(-1)!.when
    await rewriteJournal(head.dir, (j) => {
      // upstream's `when` values for the renumbered entries sit at or below the newest base ledger row
      j.entries.slice(base.journal.entries.length).forEach((e, i) => (e.when = tail - 10 + i))
    })
    const result = await replayMigrations({ baseDir: base.dir, headDir: head.dir })
    expect(result.ok).toBe(false)
    expect(result.step).toBe(1)
    expect(result.reason).toMatch(/skipped 0046_/)
    expect(result.reason).toMatch(/`when`/)
  }, 300_000)

  it("(b) main's relinked 0042 snapshot after 0054 fails at step 4", async () => {
    const base = await slice(BASE_TAG)
    const head = await slice(HEAD_TAG)
    const file = path.join(head.dir, 'meta/0054_snapshot.json')
    const snapshot = JSON.parse(await readFile(file, 'utf8'))
    // main's 0042 snapshot knows neither table (50 tables against 58)
    delete snapshot.tables['public.comment_events']
    delete snapshot.tables['public.page_snapshots']
    await writeFile(file, JSON.stringify(snapshot))
    const result = await replayMigrations({ baseDir: base.dir, headDir: head.dir })
    expect(result.ok).toBe(false)
    expect(result.step).toBe(4)
    expect(result.reason).toMatch(/0054_/)
    expect(result.reason).toMatch(/comment_events.*only in database/)
  }, 300_000)

  it('a head that edits a base journal entry fails at step 1', async () => {
    const base = await slice(BASE_TAG)
    const head = await slice(HEAD_TAG)
    await rewriteJournal(head.dir, (j) => void (j.entries[3]!.when += 1))
    const result = await replayMigrations({ baseDir: base.dir, headDir: head.dir })
    expect(result).toMatchObject({ ok: false, step: 1 })
  }, 300_000)
})

describe('replayFromEnv: the CI binding', () => {
  const actions = (over: Record<string, string> = {}) => ({
    GITHUB_ACTIONS: 'true',
    MIGRATION_BASE_SHA: sha('a'),
    MIGRATION_CANDIDATE: sha('c'),
    MIGRATION_PR_HEAD: sha('d'),
    MIGRATION_RUN_ATTEMPT: '1',
    ...over,
  })
  const noGit = {
    head: async () => sha('c'),
    tree: async () => [],
    blob: async () => Buffer.alloc(0),
  }

  it('(c) fails closed in Actions when the base was never set', async () => {
    const env = actions()
    delete (env as Record<string, string | undefined>).MIGRATION_BASE_SHA
    const result = await replayFromEnv({ env, headDir: MIGRATIONS, git: noGit })
    expect(result).toMatchObject({ ok: false, step: 0 })
    expect(result.reason).toMatch(/migration-base\.mjs did not run first/)
  })

  it('(c) fails closed when the base commit cannot be read', async () => {
    const git = {
      ...noGit,
      tree: async () => {
        throw new Error('fatal: bad object')
      },
    }
    const result = await replayFromEnv({ env: actions(), headDir: MIGRATIONS, git })
    expect(result).toMatchObject({ ok: false, step: 0 })
    expect(result.reason).toMatch(/could not be read/)
  })

  it('(c) fails closed when the base has no journal', async () => {
    const result = await replayFromEnv({ env: actions(), headDir: MIGRATIONS, git: noGit })
    expect(result).toMatchObject({ ok: false, step: 0 })
    expect(result.reason).toMatch(/no server\/db\/migrations journal/)
  })

  it('fails closed when the checked-out HEAD is not the candidate', async () => {
    const git = { ...noGit, head: async () => sha('e') }
    const result = await replayFromEnv({ env: actions(), headDir: MIGRATIONS, git })
    expect(result).toMatchObject({ ok: false, step: 0 })
    expect(result.reason).toMatch(/not the candidate/)
  })

  it('accepts pr_head `-` (a push run) and rejects a missing run attempt', async () => {
    const missing = await replayFromEnv({
      env: actions({ MIGRATION_RUN_ATTEMPT: '' }),
      headDir: MIGRATIONS,
      git: noGit,
    })
    expect(missing).toMatchObject({ ok: false, step: 0 })
    const push = await replayFromEnv({ env: actions({ MIGRATION_PR_HEAD: '-' }), headDir: MIGRATIONS, git: noGit })
    // gets past the env checks and fails later, on the empty base
    expect(push.reason).toMatch(/no server\/db\/migrations journal/)
  })

  it('is skipped outside Actions when no base is set', async () => {
    expect(await replayFromEnv({ env: {}, headDir: MIGRATIONS, git: noGit })).toEqual({ skipped: true })
  })

  it('reads the base files from git and prints a marker that merge-proof parses', async () => {
    const base = await slice(BASE_TAG)
    const files = ['meta/_journal.json', ...base.journal.entries.map((e) => `${e.tag}.sql`)]
    const git = {
      head: async () => sha('c'),
      tree: async () => files.map((f) => `server/db/migrations/${f}`),
      blob: async (_rev: string, f: string) => readFile(path.join(base.dir, path.relative('server/db/migrations', f))),
    }
    const result = await replayFromEnv({ env: actions(), headDir: MIGRATIONS, git })
    expect(result).toMatchObject({ ok: true })
    expect(result.marker).toBe(
      `migration-replay OK candidate=${sha('c')} base=${sha('a')} pr_head=${sha('d')} run_attempt=1`,
    )
    expect(parseReplayMarkers(`log line ${result.marker}\n`)).toHaveLength(1)
  }, 300_000)
})

describe('ci.yml wiring', () => {
  it('runs migration-base.mjs first in every `test (N)` shard, right after checkout', async () => {
    const ci = await readFile(path.resolve(__dirname, '../.github/workflows/ci.yml'), 'utf8')
    const job = /^ {2}test:\n([\s\S]*?)^ {2}tests:/m.exec(ci)?.[1] ?? ''
    const steps = job
      .slice(job.indexOf('steps:'))
      .split(/^ {6}- /m)
      .slice(1)
    expect(steps[0]).toMatch(/^uses: actions\/checkout@/)
    expect(steps[1]).toMatch(/run: node scripts\/ci\/migration-base\.mjs/)
    // the matrix is the shard list, so every shard runs the step
    expect(job).toMatch(/shard: \[1, 2, 3, 4\]/)
  })
})

// The one case that runs against the real checkout. It needs `migration-base.mjs` to have run first, so it
// runs only in GitHub Actions (or when a base is exported); the marker it prints is what merge-proof reads.
// describe.skip, not describe.runIf: the pregate also runs test files under Bun's own runner, which lacks runIf
;(process.env.GITHUB_ACTIONS === 'true' || process.env.MIGRATION_BASE_SHA ? describe : describe.skip)(
  'CI replay: base -> head',
  () => {
    it('replays every appended migration of this checkout', async () => {
      const result = await replayFromEnv({ env: process.env, headDir: MIGRATIONS })
      if (!result.ok) throw new Error(`migration replay failed at step ${result.step}: ${result.reason}`)
      if (result.marker) console.log(result.marker)
      expect(result.ok).toBe(true)
    }, 600_000)
  },
)
