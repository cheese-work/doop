import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error plain .mjs script, no type declarations
import { classifyMigration } from '../scripts/migration-classify.mjs'
// @ts-expect-error plain .mjs script, no type declarations
import { inventory } from '../scripts/migration-inventory.mjs'
// @ts-expect-error plain .mjs script, no type declarations
import { checkAncestry, checkImmutable, decide } from '../scripts/migration-gate.mjs'
// @ts-expect-error plain .mjs script, no type declarations
import { diffSnapshots, missingSnapshots } from '../scripts/migration-snapshot.mjs'

const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const SHA_A = 'a'.repeat(40)
const SHA_B = 'b'.repeat(40)

/* ---------- classifier (C-8.4) ---------- */

describe('classifier', () => {
  const additive = [
    'CREATE TABLE IF NOT EXISTS "t" ("id" text PRIMARY KEY NOT NULL, "n" integer DEFAULT 0 NOT NULL);',
    'ALTER TABLE "t" ADD COLUMN IF NOT EXISTS "x" text;',
    `ALTER TABLE "t" ADD COLUMN IF NOT EXISTS "x" jsonb DEFAULT '{}'::jsonb NOT NULL;`,
    'ALTER TABLE "t" ADD COLUMN IF NOT EXISTS "x" boolean DEFAULT false NOT NULL;',
    'ALTER TABLE "t" ADD COLUMN IF NOT EXISTS "x" integer DEFAULT -1 NOT NULL;',
    'CREATE INDEX IF NOT EXISTS "i" ON "t" ("c");',
    'CREATE TABLE IF NOT EXISTS "a" ("id" text);\n--> statement-breakpoint\nCREATE INDEX IF NOT EXISTS "i" ON "a" ("id");',
    '',
  ]
  it.each(additive)('additive: %s', async (sql) => {
    const r = await classifyMigration(sql)
    expect(r.additive).toBe(true)
  })

  const notAdditive: [string, string][] = [
    ['DROP', 'DROP TABLE "t";'],
    ['DROP COLUMN', 'ALTER TABLE "t" DROP COLUMN "c";'],
    ['RENAME', 'ALTER TABLE "t" RENAME TO "u";'],
    ['RENAME COLUMN', 'ALTER TABLE "t" RENAME COLUMN "a" TO "b";'],
    ['ALTER TYPE', 'ALTER TABLE "t" ALTER COLUMN "c" SET DATA TYPE bigint;'],
    ['UPDATE', `UPDATE "t" SET "c" = 'x';`],
    ['DELETE', 'DELETE FROM "t";'],
    ['INSERT', `INSERT INTO "t" ("c") VALUES ('x');`],
    ['DO block', 'DO $$ BEGIN PERFORM 1; END $$;'],
    ['parse error', 'ALTER TABEL "t" ADD COLUMN "c" text;'],
    ['NOT NULL without default', 'ALTER TABLE "t" ADD COLUMN IF NOT EXISTS "x" text NOT NULL;'],
    ['ADD COLUMN without IF NOT EXISTS', 'ALTER TABLE "t" ADD COLUMN "x" text;'],
    ['non-constant default', 'ALTER TABLE "t" ADD COLUMN IF NOT EXISTS "x" timestamp DEFAULT now() NOT NULL;'],
    ['generated column', 'ALTER TABLE "t" ADD COLUMN IF NOT EXISTS "x" integer GENERATED ALWAYS AS (1 + 1) STORED;'],
    ['unique column', 'ALTER TABLE "t" ADD COLUMN IF NOT EXISTS "x" text UNIQUE;'],
    ['mixed ALTER commands', 'ALTER TABLE "t" ADD COLUMN IF NOT EXISTS "x" text, DROP COLUMN "y";'],
    ['CREATE TABLE without IF NOT EXISTS', 'CREATE TABLE "t" ("id" text);'],
    ['CREATE TABLE AS', 'CREATE TABLE IF NOT EXISTS "t" AS SELECT 1;'],
    ['index without IF NOT EXISTS', 'CREATE INDEX "i" ON "t" ("c");'],
    ['CONCURRENTLY', 'CREATE INDEX CONCURRENTLY IF NOT EXISTS "i" ON "t" ("c");'],
    ['unique index', 'CREATE UNIQUE INDEX IF NOT EXISTS "i" ON "t" ("c");'],
    [
      'one bad statement among good ones',
      'CREATE TABLE IF NOT EXISTS "a" ("id" text);\n--> statement-breakpoint\nDROP TABLE "b";',
    ],
    ['two statements in one chunk', 'CREATE TABLE IF NOT EXISTS "a" ("id" text); DROP TABLE "b";'],
  ]
  it.each(notAdditive)('not additive: %s', async (_name, sql) => {
    const r = await classifyMigration(sql)
    expect(r.additive).toBe(false)
    expect(r.statements.some((s: { additive: boolean; reason?: string }) => !s.additive && s.reason)).toBe(true)
  })
})

/* ---------- inventory (C-8.1) ---------- */

describe('inventory', () => {
  let dir: string
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
  })
  async function fixture(files: Record<string, string>) {
    dir = await mkdtemp(path.join(tmpdir(), 'doop-inv-'))
    await mkdir(path.join(dir, 'meta'))
    for (const [name, body] of Object.entries(files)) await writeFile(path.join(dir, name), body)
    return dir
  }

  it('hashes each migration by name and bytes, plus the journal', async () => {
    const d = await fixture({
      '0001_b.sql': 'B',
      '0000_a.sql': 'A',
      'meta/_journal.json': '{}',
      'meta/x.txt': 'ignored',
    })
    const inv = await inventory(d)
    expect(inv.migrations).toEqual([
      { name: '0000_a.sql', sha256: sha('A') },
      { name: '0001_b.sql', sha256: sha('B') },
    ])
    expect(inv.journalSha256).toBe(sha('{}'))
    expect(inv.sha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('the inventory sha changes with a byte, a rename or the journal', async () => {
    const base = await inventory(await fixture({ '0000_a.sql': 'A', 'meta/_journal.json': '{}' }))
    const byte = await inventory(await fixture({ '0000_a.sql': 'A ', 'meta/_journal.json': '{}' }))
    const rename = await inventory(await fixture({ '0000_z.sql': 'A', 'meta/_journal.json': '{}' }))
    const journal = await inventory(await fixture({ '0000_a.sql': 'A', 'meta/_journal.json': '{"a":1}' }))
    const again = await inventory(await fixture({ '0000_a.sql': 'A', 'meta/_journal.json': '{}' }))
    expect(new Set([base.sha256, byte.sha256, rename.sha256, journal.sha256]).size).toBe(4)
    expect(again.sha256).toBe(base.sha256)
  })

  it('a missing journal fails closed', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'doop-inv-'))
    await writeFile(path.join(dir, '0000_a.sql'), 'A')
    await expect(inventory(dir)).rejects.toThrow()
  })
})

/* ---------- ancestry (C-8.2) ---------- */

describe('ancestry', () => {
  const git =
    (...ok: [string, string][]) =>
    async (a: string, b: string) =>
      ok.some(([x, y]) => x === a && y === b)
  it('passes for a strict descendant', async () => {
    expect(await checkAncestry({ label: SHA_A, candidate: SHA_B, isAncestor: git([SHA_A, SHA_B]) })).toEqual({
      ok: true,
    })
  })
  it.each([
    ['missing label', undefined],
    ['empty label', ''],
    ['not a sha', 'latest'],
  ])('stops on %s', async (_n, label) => {
    const r = await checkAncestry({ label, candidate: SHA_B, isAncestor: git([SHA_A, SHA_B]) })
    expect(r.ok).toBe(false)
  })
  it('stops when the candidate is the running revision', async () => {
    const r = await checkAncestry({ label: SHA_A, candidate: SHA_A, isAncestor: git([SHA_A, SHA_A]) })
    expect(r.ok).toBe(false)
  })
  it('stops on a non-ancestor', async () => {
    const r = await checkAncestry({ label: SHA_B, candidate: SHA_A, isAncestor: git([SHA_A, SHA_B]) })
    expect(r.ok).toBe(false)
  })
  it('stops when git cannot answer', async () => {
    const r = await checkAncestry({
      label: SHA_A,
      candidate: SHA_B,
      isAncestor: async () => {
        throw new Error('bad object')
      },
    })
    expect(r.ok).toBe(false)
  })
})

/* ---------- immutable applied migrations (C-8.3) ---------- */

describe('immutable applied migrations', () => {
  const entry = (idx: number, when: number) => ({
    idx,
    version: '7',
    when,
    tag: `000${idx}_m`,
    breakpoints: true,
  })
  const journal = (...e: ReturnType<typeof entry>[]) => ({ version: '7', dialect: 'postgresql', entries: e })
  const m = (idx: number, body = `sql${idx}`) => ({ name: `000${idx}_m.sql`, sha256: sha(body) })
  const prev = journal(entry(0, 100), entry(1, 200))
  const ledger = [
    { hash: sha('sql0'), created_at: 100 },
    { hash: sha('sql1'), created_at: 200 },
  ]
  const base = { predecessorJournal: prev, ledger }

  it('passes when applied migrations are unchanged and new ones are newer', () => {
    const r = checkImmutable({
      ...base,
      candidateJournal: journal(entry(0, 100), entry(1, 200), entry(2, 300)),
      candidateMigrations: [m(0), m(1), m(2)],
    })
    expect(r).toEqual({ ok: true, newMigrations: ['0002_m.sql'] })
  })
  it('passes with no new migration', () => {
    const r = checkImmutable({ ...base, candidateJournal: prev, candidateMigrations: [m(0), m(1)] })
    expect(r).toEqual({ ok: true, newMigrations: [] })
  })
  it('stops on a changed applied migration', () => {
    const r = checkImmutable({ ...base, candidateJournal: prev, candidateMigrations: [m(0), m(1, 'edited')] })
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/0001_m/)
  })
  it('stops on a deleted applied migration', () => {
    const r = checkImmutable({ ...base, candidateJournal: journal(entry(0, 100)), candidateMigrations: [m(0)] })
    expect(r.ok).toBe(false)
  })
  it('stops on a changed journal entry of an applied migration', () => {
    const r = checkImmutable({
      ...base,
      candidateJournal: journal(entry(0, 100), entry(1, 250)),
      candidateMigrations: [m(0), m(1)],
    })
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/journal/)
  })
  it('stops on a reordered applied migration', () => {
    const swapped = journal({ ...entry(1, 200), idx: 0 }, { ...entry(0, 100), idx: 1 })
    const r = checkImmutable({ ...base, candidateJournal: swapped, candidateMigrations: [m(0), m(1)] })
    expect(r.ok).toBe(false)
  })
  it('stops on a new migration inserted before an applied one', () => {
    const r = checkImmutable({
      ...base,
      candidateJournal: journal(entry(0, 100), { ...entry(2, 150), idx: 1 }, { ...entry(1, 200), idx: 2 }),
      candidateMigrations: [m(0), m(1), m(2)],
    })
    expect(r.ok).toBe(false)
  })
  it('stops on a new migration that drizzle would skip (not newer than the ledger)', () => {
    const r = checkImmutable({
      ...base,
      candidateJournal: journal(entry(0, 100), entry(1, 200), entry(2, 200)),
      candidateMigrations: [m(0), m(1), m(2)],
    })
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/skip/)
  })
  it('stops on a migration missing its sql file', () => {
    const r = checkImmutable({
      ...base,
      candidateJournal: journal(entry(0, 100), entry(1, 200), entry(2, 300)),
      candidateMigrations: [m(0), m(1)],
    })
    expect(r.ok).toBe(false)
  })
  it('stops on a ledger row the candidate does not know', () => {
    const r = checkImmutable({
      ...base,
      ledger: [...ledger, { hash: sha('other'), created_at: 150 }],
      candidateJournal: prev,
      candidateMigrations: [m(0), m(1)],
    })
    expect(r.ok).toBe(false)
  })
  it('accepts a ledger that applied a migration twice (re-whened journal entry)', () => {
    const r = checkImmutable({
      ...base,
      ledger: [...ledger, { hash: sha('sql0'), created_at: 90 }],
      candidateJournal: prev,
      candidateMigrations: [m(0), m(1)],
    })
    expect(r.ok).toBe(true)
  })
  it.each([
    ['empty ledger', []],
    ['not an array', null],
    ['row without hash', [{ created_at: 1 }]],
    ['row with non-numeric created_at', [{ hash: sha('sql0'), created_at: 'x' }]],
  ])('stops on an unreadable ledger: %s', (_n, bad) => {
    const r = checkImmutable({ ...base, ledger: bad, candidateJournal: prev, candidateMigrations: [m(0), m(1)] })
    expect(r.ok).toBe(false)
  })
  it('accepts created_at as a string, as psql prints bigint', () => {
    const r = checkImmutable({
      ...base,
      ledger: ledger.map((l) => ({ ...l, created_at: String(l.created_at) })),
      candidateJournal: prev,
      candidateMigrations: [m(0), m(1)],
    })
    expect(r.ok).toBe(true)
  })
})

/* ---------- snapshot diff (C-8.5a) ---------- */

type Json = Record<string, unknown>
const col = (over: Json = {}) => ({ name: 'c', type: 'text', primaryKey: false, notNull: false, ...over })
const idx = (over: Json = {}) => ({
  name: 'i',
  columns: [{ expression: 'c', isExpression: false, asc: true, nulls: 'last' }],
  isUnique: false,
  concurrently: false,
  method: 'btree',
  with: {},
  ...over,
})
const table = (over: Json = {}) => ({
  name: 't',
  schema: '',
  columns: { id: col({ name: 'id', notNull: true, primaryKey: true }) },
  indexes: {},
  foreignKeys: {},
  compositePrimaryKeys: {},
  uniqueConstraints: {},
  policies: {},
  checkConstraints: {},
  isRLSEnabled: false,
  ...over,
})
const snap = (tables: Record<string, Json>, over: Json = {}) => ({
  id: 'new',
  prevId: 'old',
  version: '7',
  dialect: 'postgresql',
  tables,
  enums: {},
  schemas: {},
  sequences: {},
  roles: {},
  policies: {},
  views: {},
  _meta: { columns: {}, schemas: {}, tables: {} },
  ...over,
})
const T = (over: Json = {}) => ({ 'public.t': table(over) })
const withCols = (c: Record<string, Json>) =>
  T({ columns: { id: col({ name: 'id', notNull: true, primaryKey: true }), ...c } })

describe('snapshot diff', () => {
  const before = snap(T())
  const ok = (after: Json) => expect(diffSnapshots(before, after)).toEqual({ ok: true })
  const bad = (after: Json, re?: RegExp) => {
    const r = diffSnapshots(before, after)
    expect(r.ok).toBe(false)
    if (re) expect(r.reason).toMatch(re)
  }

  it('allows no change (ids differ)', () => ok(snap(T())))
  it('allows a new table', () => ok(snap({ ...T(), 'public.u': table({ name: 'u' }) })))
  it('allows a new nullable column', () => ok(snap(withCols({ x: col({ name: 'x' }) }))))
  it('allows a new not-null column with a constant default', () => {
    ok(snap(withCols({ x: col({ name: 'x', notNull: true, default: "'{}'::jsonb" }) })))
    ok(snap(withCols({ x: col({ name: 'x', notNull: true, default: 'false' }) })))
    ok(snap(withCols({ x: col({ name: 'x', type: 'integer', notNull: true, default: 0 }) })))
  })
  it('allows a new non-unique index', () => ok(snap(T({ indexes: { i: idx() } }))))

  it('rejects a new not-null column without default', () =>
    bad(snap(withCols({ x: col({ name: 'x', notNull: true }) })), /x/))
  it('rejects a new column with a function default', () =>
    bad(snap(withCols({ x: col({ name: 'x', notNull: true, default: 'now()' }) }))))
  it('rejects a new primary-key column', () => bad(snap(withCols({ x: col({ name: 'x', primaryKey: true }) }))))
  it('rejects a changed column type', () =>
    bad(snap(T({ columns: { id: col({ name: 'id', type: 'bigint', notNull: true, primaryKey: true }) } })), /id/))
  it('rejects a changed nullability', () =>
    bad(snap(T({ columns: { id: col({ name: 'id', notNull: false, primaryKey: true }) } }))))
  it('rejects a changed default', () =>
    bad(snap(T({ columns: { id: col({ name: 'id', notNull: true, primaryKey: true, default: "'a'" }) } }))))
  it('rejects a dropped column', () => bad(snap(T({ columns: {} }))))
  it('rejects a dropped table', () => bad(snap({})))
  it('rejects a new unique index', () => bad(snap(T({ indexes: { i: idx({ isUnique: true }) } })), /unique/))
  it('rejects a new unique constraint', () =>
    bad(snap(T({ uniqueConstraints: { u: { name: 'u', nullsNotDistinct: false, columns: ['id'] } } }))))
  it('rejects a new foreign key on an existing table', () =>
    bad(
      snap(
        T({ foreignKeys: { f: { name: 'f', tableFrom: 't', tableTo: 'u', columnsFrom: ['id'], columnsTo: ['id'] } } }),
      ),
    ))
  it('rejects a new check constraint on an existing table', () =>
    bad(snap(T({ checkConstraints: { c: { name: 'c', value: 'id <> 0' } } }))))
  it('rejects a dropped or changed index', () => {
    const had = snap(T({ indexes: { i: idx() } }))
    expect(diffSnapshots(had, snap(T())).ok).toBe(false)
    expect(diffSnapshots(had, snap(T({ indexes: { i: idx({ method: 'hash' }) } }))).ok).toBe(false)
  })
  it('rejects a new enum, view or sequence', () => {
    bad(snap(T(), { enums: { e: { name: 'e', schema: 'public', values: ['a'] } } }))
    bad(snap(T(), { views: { v: { name: 'v' } } }))
    bad(snap(T(), { sequences: { s: { name: 's' } } }))
  })
  it.each([
    ['missing before', undefined, snap(T())],
    ['missing after', snap(T()), undefined],
    ['not an object', snap(T()), 'x'],
    ['no tables', snap(T()), { id: 'a' }],
  ])('rejects an unreadable snapshot: %s', (_n, a, b) => {
    expect(diffSnapshots(a, b).ok).toBe(false)
  })
})

describe('every journal entry has a snapshot', () => {
  const entries = [
    { idx: 0, tag: '0000_a' },
    { idx: 1, tag: '0001_b' },
  ]
  it('lists the entries without one', () => {
    expect(missingSnapshots(entries, ['0000_snapshot.json'])).toEqual(['0001_snapshot.json'])
    expect(missingSnapshots(entries, ['0000_snapshot.json', '0001_snapshot.json'])).toEqual([])
  })
})

/* ---------- verdict (C-8.6) ---------- */

describe('decide', () => {
  const pass = { ok: true }
  it('deploys when every part passes', () => {
    expect(
      decide({
        ancestry: pass,
        immutable: { ok: true, newMigrations: ['0046_x.sql'] },
        classification: { additive: true, migrations: [] },
        snapshot: pass,
      }),
    ).toMatchObject({ deploy: true, forwardOnly: false })
  })
  it('deploys when there is nothing new, with no classification or snapshot needed', () => {
    expect(decide({ ancestry: pass, immutable: { ok: true, newMigrations: [] } })).toMatchObject({ deploy: true })
  })
  it('skips every window and names the part and migrations for a non-additive candidate', () => {
    const v = decide({
      ancestry: pass,
      immutable: { ok: true, newMigrations: ['0046_x.sql'] },
      classification: {
        additive: false,
        migrations: [{ name: '0046_x.sql', additive: false, statements: [{ additive: false, reason: 'DROP' }] }],
      },
      snapshot: pass,
    })
    expect(v.deploy).toBe(false)
    expect(v.forwardOnly).toBe(true)
    expect(v.failed).toEqual([expect.objectContaining({ part: 'classifier', migrations: ['0046_x.sql'] })])
  })
  it('names the snapshot part when evidence is insufficient', () => {
    const v = decide({
      ancestry: pass,
      immutable: { ok: true, newMigrations: ['0046_x.sql'] },
      classification: { additive: true, migrations: [] },
      snapshot: { ok: false, reason: 'missing snapshot 0046' },
    })
    expect(v.forwardOnly).toBe(true)
    expect(v.failed[0]).toMatchObject({ part: 'snapshot', reason: 'missing snapshot 0046' })
  })
  it('a failed ancestry or immutability stops the run and is not forward-only', () => {
    expect(decide({ ancestry: { ok: false, reason: 'x' }, immutable: { ok: true, newMigrations: [] } })).toMatchObject({
      deploy: false,
      forwardOnly: false,
      failed: [expect.objectContaining({ part: 'ancestry' })],
    })
    expect(decide({ ancestry: pass, immutable: { ok: false, reason: 'y' } })).toMatchObject({
      deploy: false,
      forwardOnly: false,
      failed: [expect.objectContaining({ part: 'immutable' })],
    })
  })
  it('fails closed on a missing part', () => {
    expect(decide({ ancestry: pass, immutable: { ok: true, newMigrations: ['0046_x.sql'] } }).deploy).toBe(false)
    expect(decide({}).deploy).toBe(false)
  })
})
