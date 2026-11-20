// Per-step migration replay (CHE-7207 S3b). Runs in the `test` matrix (tests/migrationReplay.test.ts) after
// `migration-base.mjs` has picked the base revision. Four steps, in order; the first one that fails stops the
// run and names itself:
//
//   1. prefix replay   migrate the base journal, then the head's. The ledger must hold every base entry and
//                      every new entry, with hash = sha256 of its SQL and created_at = its `when`.
//                      drizzle skips an entry whose `when` is not newer than the newest ledger row, so an
//                      upstream `when` that was kept shows up here as a missing ledger row.
//   2. idempotence     migrate the head again. Ledger and schema stay the same.
//   3. fresh replay    migrate the head into a new database. Its schema equals the step 1 schema.
//   4. snapshot truth  for each appended entry j, migrate base + entries up to j. The schema equals snapshot j.
//
// Schema comparison covers tables, columns (type, nullability, default), indexes, and primary key, unique,
// foreign key and check constraints. Steps 1 to 3 compare two live databases, so they use the full form.
// Step 4 compares a database with a drizzle snapshot, which cannot express everything the catalog holds
// (a check expression, an index's sort order), so that side uses the reduced form.
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import { formatReplayMarker } from './migration-marker.mjs'

const run = promisify(execFile)
const SHA = /^[0-9a-f]{40}$/
export const MIGRATIONS_DIR = 'server/db/migrations'

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')
const pad = (n) => String(n).padStart(4, '0')
const fail = (step, reason) => ({ ok: false, step, reason })
const isEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b)

// ---------------------------------------------------------------------------------------------------------
// Schema normalization

// One query per catalog area; every result row is plain JSON.
const COLUMNS = `
  select c.relname as tbl, a.attname as col, format_type(a.atttypid, a.atttypmod) as type, a.attnotnull as not_null,
         pg_get_expr(d.adbin, d.adrelid) as def
  from pg_attribute a
  join pg_class c on c.oid = a.attrelid
  join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
  left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
  where c.relkind = 'r' and a.attnum > 0 and not a.attisdropped
  order by 1, 2`
const TABLES = `
  select c.relname as tbl from pg_class c
  join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
  where c.relkind = 'r' order by 1`
// An index that backs a constraint is listed with its constraint, not here.
const INDEXES = `
  select t.relname as tbl, ic.relname as name, i.indisunique as is_unique, am.amname as method,
         pg_get_expr(i.indpred, i.indrelid) as pred,
         (select array_agg(pg_get_indexdef(i.indexrelid, k, true) order by k) from generate_series(1, i.indnkeyatts) k) as cols
  from pg_index i
  join pg_class ic on ic.oid = i.indexrelid
  join pg_class t on t.oid = i.indrelid
  join pg_namespace n on n.oid = t.relnamespace and n.nspname = 'public'
  join pg_am am on am.oid = ic.relam
  where not exists (select 1 from pg_constraint k where k.conindid = i.indexrelid and k.contype in ('p', 'u'))
  order by 1, 2`
const CONSTRAINTS = `
  select t.relname as tbl, k.conname as name, k.contype as kind, pg_get_constraintdef(k.oid) as def,
         (select array_agg(a.attname order by x.ord) from unnest(k.conkey) with ordinality x(num, ord)
            join pg_attribute a on a.attrelid = k.conrelid and a.attnum = x.num) as cols,
         (select r.relname from pg_class r where r.oid = k.confrelid) as ref_tbl,
         (select array_agg(a.attname order by x.ord) from unnest(k.confkey) with ordinality x(num, ord)
            join pg_attribute a on a.attrelid = k.confrelid and a.attnum = x.num) as ref_cols,
         k.confdeltype as on_delete, k.confupdtype as on_update
  from pg_constraint k
  join pg_class t on t.oid = k.conrelid
  join pg_namespace n on n.oid = t.relnamespace and n.nspname = 'public'
  where k.contype in ('p', 'u', 'f', 'c')
  order by 1, 2`

const ACTION = { a: 'no action', r: 'restrict', c: 'cascade', n: 'set null', d: 'set default' }

// `'x'::text` and `x` are the same default; so are `(0)` and `0`. Lowercased, casts and wrapping parens gone.
export function normalizeDefault(value) {
  if (value === undefined || value === null) return null
  let s = String(value).trim()
  // a jsonb literal: whitespace inside it is the catalog's, not the author's
  const literal = /^'([\s\S]*)'(::jsonb?)?$/.exec(s)
  if (literal && /^\s*[[{]/.test(literal[1])) {
    try {
      s = `'${JSON.stringify(JSON.parse(literal[1].replace(/''/g, "'")))}'`
    } catch {
      // not JSON after all: normalized as plain text below
    }
  }
  for (;;) {
    const next = s
      .replace(/::[a-z_][a-z0-9_ ]*(\([0-9, ]*\))?(\[\])*/gi, '')
      .replace(/^\((.*)\)$/s, '$1')
      .trim()
    if (next === s) break
    s = next
  }
  s = s.replace(/\s+/g, ' ').toLowerCase()
  if (s === 'current_timestamp') s = 'now()'
  return s
}

// What the catalog calls a type, from what a snapshot calls it.
export function normalizeType(type) {
  let t = String(type).trim().toLowerCase().replace(/\s+\(/g, '(').replace(/\s+/g, ' ')
  const array = /(\[\])+$/.exec(t)?.[0] ?? ''
  t = t.slice(0, t.length - array.length)
  const serial = { serial: 'integer', bigserial: 'bigint', smallserial: 'smallint' }[t]
  if (serial) return serial + array
  const alias = { varchar: 'character varying', char: 'character', int: 'integer', int4: 'integer', int8: 'bigint' }
  t = t.replace(/^(varchar|char|int8|int4|int)(?=\(|$)/, (m) => alias[m])
  const withZone = / with time zone$/.test(t)
  const base = t.replace(/ (with|without) time zone$/, '')
  if (/^(timestamp|time)(\(\d+\))?$/.test(base) || base === 'timestamptz') {
    const kind = base === 'timestamptz' ? 'timestamp' : base
    return `${kind}${base === 'timestamptz' || withZone ? ' with' : ' without'} time zone${array}`.replace(
      /^(timestamp|time)(\(\d+\)) /,
      '$1$2 ',
    )
  }
  return t + array
}

const isSerial = (type) => /^(small|big)?serial$/i.test(String(type).trim())
const clean = (expr) =>
  String(expr)
    .replace(/"/g, '')
    .replace(/\bpublic\./g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()

// The full form of a live database: what steps 1 to 3 compare.
export async function readSchema(client) {
  const rows = async (sql) => (await client.query(sql)).rows
  const tables = {}
  for (const { tbl } of await rows(TABLES))
    tables[tbl] = { columns: {}, indexes: {}, primaryKey: [], unique: {}, foreignKeys: {}, checks: {} }
  for (const r of await rows(COLUMNS))
    tables[r.tbl].columns[r.col] = { type: r.type, notNull: r.not_null, default: r.def ?? null }
  for (const r of await rows(INDEXES))
    tables[r.tbl].indexes[r.name] = { unique: r.is_unique, method: r.method, where: r.pred ?? null, columns: r.cols }
  for (const r of await rows(CONSTRAINTS)) {
    const t = tables[r.tbl]
    if (r.kind === 'p') t.primaryKey = r.cols
    else if (r.kind === 'u') t.unique[r.name] = r.cols
    else if (r.kind === 'c') t.checks[r.name] = r.def
    else
      t.foreignKeys[r.name] = {
        columns: r.cols,
        refTable: r.ref_tbl,
        refColumns: r.ref_cols,
        onDelete: ACTION[r.on_delete],
        onUpdate: ACTION[r.on_update],
      }
  }
  return tables
}

// The reduced form of a live database: only what a drizzle snapshot can say.
export function reduceSchema(full) {
  const out = {}
  for (const [name, t] of Object.entries(full)) {
    const columns = {}
    for (const [c, v] of Object.entries(t.columns)) {
      const serialDefault = typeof v.default === 'string' && v.default.startsWith('nextval(')
      columns[c] = {
        type: normalizeType(v.type),
        notNull: v.notNull,
        default: serialDefault ? null : normalizeDefault(v.default),
      }
    }
    const indexes = {}
    for (const [n, i] of Object.entries(t.indexes))
      indexes[n] = {
        unique: i.unique,
        method: i.method,
        partial: i.where !== null,
        columns: i.columns.map(clean),
      }
    out[name] = {
      columns,
      indexes,
      primaryKey: t.primaryKey,
      unique: byShape(Object.values(t.unique).map((cols) => cols.join(','))),
      foreignKeys: byShape(Object.values(t.foreignKeys), fkKey),
      checks: Object.keys(t.checks).sort(),
    }
  }
  return out
}

// A constraint's name is the catalog's or drizzle's choice (`x_key` against `x_unique`); its shape is the schema.
const byShape = (items, key = String) =>
  Object.fromEntries(items.map((i) => [key(i), i]).sort(([a], [b]) => (a < b ? -1 : 1)))
const fkKey = (f) => `${f.columns.join(',')}->${f.refTable}(${f.refColumns.join(',')})`

// The same reduced form, from a drizzle snapshot.
export function snapshotSchema(snapshot) {
  const out = {}
  for (const table of Object.values(snapshot.tables ?? {})) {
    const columns = {}
    const pk = []
    for (const c of Object.values(table.columns ?? {})) {
      columns[c.name] = {
        type: normalizeType(c.type),
        notNull: !!c.notNull,
        // a serial column's default is its implicit sequence
        default: isSerial(c.type) ? null : normalizeDefault(c.default),
      }
      if (c.primaryKey) pk.push(c.name)
    }
    for (const k of Object.values(table.compositePrimaryKeys ?? {})) pk.push(...k.columns)
    const indexes = {}
    for (const i of Object.values(table.indexes ?? {}))
      indexes[i.name] = {
        unique: !!i.isUnique,
        method: i.method ?? 'btree',
        partial: !!i.where,
        columns: i.columns.map((x) => clean(x.expression)),
      }
    const unique = byShape(Object.values(table.uniqueConstraints ?? {}).map((u) => u.columns.join(',')))
    const foreignKeys = byShape(
      Object.values(table.foreignKeys ?? {}).map((f) => ({
        columns: f.columnsFrom,
        refTable: f.tableTo,
        refColumns: f.columnsTo,
        onDelete: f.onDelete ?? 'no action',
        onUpdate: f.onUpdate ?? 'no action',
      })),
      fkKey,
    )
    out[table.name] = {
      columns,
      indexes,
      primaryKey: pk,
      unique,
      foreignKeys,
      checks: Object.keys(table.checkConstraints ?? {}).sort(),
    }
  }
  return out
}

// Readable differences between two normalized schemas, one line per path; empty when equal.
export function diffSchemas(a, b, label = ['actual', 'expected']) {
  const lines = []
  const walk = (x, y, where) => {
    const obj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
    if (obj(x) && obj(y)) {
      for (const k of new Set([...Object.keys(x), ...Object.keys(y)]).values()) {
        if (!(k in x)) lines.push(`${[...where, k].join('.')}: only in ${label[1]}`)
        else if (!(k in y)) lines.push(`${[...where, k].join('.')}: only in ${label[0]}`)
        else walk(x[k], y[k], [...where, k])
      }
    } else if (!isEqual(x, y)) {
      lines.push(`${where.join('.')}: ${label[0]} ${JSON.stringify(x)}, ${label[1]} ${JSON.stringify(y)}`)
    }
  }
  walk(a, b, [])
  return lines
}

// ---------------------------------------------------------------------------------------------------------
// Replay

const readJournal = async (dir) => JSON.parse(await readFile(path.join(dir, 'meta/_journal.json'), 'utf8'))
const ledger = async (client) =>
  (await client.query('select hash, created_at from drizzle.__drizzle_migrations order by id')).rows.map((r) => ({
    hash: r.hash,
    createdAt: Number(r.created_at),
  }))

async function expectedRows(dir, entries) {
  const rows = []
  for (const e of entries)
    rows.push({ hash: sha256(await readFile(path.join(dir, `${e.tag}.sql`))), createdAt: e.when })
  return rows
}

// Copies the SQL of `entries` from the directory that holds each one and writes a journal of exactly `entries`.
async function stage(dest, journal, entries) {
  await rm(path.join(dest, 'meta'), { recursive: true, force: true })
  await mkdir(path.join(dest, 'meta'), { recursive: true })
  for (const e of entries) await cp(e.from, path.join(dest, `${e.tag}.sql`))
  await writeFile(
    path.join(dest, 'meta/_journal.json'),
    JSON.stringify({ ...journal, entries: entries.map(({ from: _from, ...entry }) => entry) }),
  )
}

export async function replayMigrations({ baseDir, headDir }) {
  let base
  let head
  try {
    base = await readJournal(baseDir)
    head = await readJournal(headDir)
  } catch (e) {
    return fail(1, `a migration journal is unreadable: ${e.message}`)
  }
  const prefixOk = base.entries.every((e, i) => isEqual(e, head.entries[i]))
  if (!prefixOk || head.entries.length < base.entries.length)
    return fail(1, 'the head journal does not start with every base journal entry, unchanged and in order')
  const fresh = head.entries.slice(base.entries.length)
  const clients = []
  const open = () => {
    const c = new PGlite()
    clients.push(c)
    return c
  }
  const work = await mkdtemp(path.join(tmpdir(), 'doop-migration-replay-'))
  let step = 1
  try {
    // 1. prefix replay
    const a = open()
    await migrate(drizzle(a), { migrationsFolder: baseDir })
    const baseRows = await expectedRows(baseDir, base.entries)
    if (!isEqual(await ledger(a), baseRows)) return fail(1, 'the base does not replay to its own ledger')
    await migrate(drizzle(a), { migrationsFolder: headDir })
    const want = [...baseRows, ...(await expectedRows(headDir, fresh))]
    const got = await ledger(a)
    if (!isEqual(got, want)) {
      const applied = new Set(got.map((r) => r.createdAt))
      const skipped = head.entries.filter((e) => !applied.has(e.when)).map((e) => e.tag)
      return fail(
        1,
        `the ledger has ${got.length} rows, expected ${want.length} (base entries plus new entries, hash = sha256 of the SQL)` +
          (skipped.length
            ? `; drizzle skipped ${skipped.join(', ')}: a \`when\` that is not newer than the newest applied row is never run`
            : ''),
      )
    }
    const schema = await readSchema(a)

    // 2. idempotence
    step = 2
    await migrate(drizzle(a), { migrationsFolder: headDir })
    if (!isEqual(await ledger(a), want)) return fail(2, 'a second migrate of the head changed the ledger')
    const again = diffSchemas(await readSchema(a), schema, ['second run', 'first run'])
    if (again.length) return fail(2, `a second migrate of the head changed the schema:\n${again.join('\n')}`)

    // 3. fresh replay
    step = 3
    const b = open()
    await migrate(drizzle(b), { migrationsFolder: headDir })
    const freshDiff = diffSchemas(await readSchema(b), schema, ['fresh database', 'base then head'])
    if (freshDiff.length)
      return fail(3, `a fresh replay of the head differs from base then head:\n${freshDiff.join('\n')}`)

    // 4. snapshot truth
    step = 4
    if (fresh.length === 0) return { ok: true, base: base.entries.length, appended: 0 }
    const c = open()
    const all = [
      ...base.entries.map((e) => ({ ...e, from: path.join(baseDir, `${e.tag}.sql`) })),
      ...fresh.map((e) => ({ ...e, from: path.join(headDir, `${e.tag}.sql`) })),
    ]
    await stage(work, head, all.slice(0, base.entries.length))
    await migrate(drizzle(c), { migrationsFolder: work })
    for (const [j, entry] of fresh.entries()) {
      const file = `meta/${pad(entry.idx)}_snapshot.json`
      let snapshot
      try {
        snapshot = JSON.parse(await readFile(path.join(headDir, file), 'utf8'))
      } catch {
        return fail(4, `${entry.tag} has no readable ${file}`)
      }
      await stage(work, head, all.slice(0, base.entries.length + j + 1))
      await migrate(drizzle(c), { migrationsFolder: work })
      const diff = diffSchemas(reduceSchema(await readSchema(c)), snapshotSchema(snapshot), [
        'database',
        `snapshot ${pad(entry.idx)}`,
      ])
      if (diff.length) return fail(4, `${entry.tag}: the schema differs from ${file}:\n${diff.join('\n')}`)
    }
    return { ok: true, base: base.entries.length, appended: fresh.length }
  } catch (e) {
    return fail(step, `migrate failed: ${e.message}`)
  } finally {
    await Promise.all(clients.map((x) => x.close().catch(() => {})))
    await rm(work, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------------------------------------
// The base revision, from git

const realGit = {
  tree: async (rev, dir) =>
    (await run('git', ['ls-tree', '-r', '--name-only', rev, '--', dir])).stdout.split('\n').filter(Boolean),
  blob: async (rev, file) =>
    (await run('git', ['cat-file', 'blob', `${rev}:${file}`], { encoding: 'buffer', maxBuffer: 1 << 28 })).stdout,
  head: async () => (await run('git', ['rev-parse', 'HEAD'])).stdout.trim(),
}

// Writes the base revision's SQL and journal under `dest`. Throws when the base has no journal or cannot be read.
export async function exportBase(rev, dest, git = realGit) {
  const files = (await git.tree(rev, MIGRATIONS_DIR)).filter(
    (f) => f.endsWith('.sql') || f.endsWith('meta/_journal.json'),
  )
  if (!files.some((f) => f.endsWith('meta/_journal.json')))
    throw new Error(`base ${rev} has no ${MIGRATIONS_DIR} journal`)
  for (const f of files) {
    const to = path.join(dest, path.relative(MIGRATIONS_DIR, f))
    await mkdir(path.dirname(to), { recursive: true })
    await writeFile(to, await git.blob(rev, f))
  }
}

// What CI hands the replay test: the env `migration-base.mjs` wrote. Fails closed in GitHub Actions on anything
// missing. Outside Actions, with no base set, there is nothing to replay against: skipped.
export async function replayFromEnv({ env, headDir, git = realGit }) {
  const inActions = env.GITHUB_ACTIONS === 'true'
  if (!inActions && !env.MIGRATION_BASE_SHA) return { skipped: true }
  const base = env.MIGRATION_BASE_SHA
  if (!SHA.test(base ?? ''))
    return fail(0, 'MIGRATION_BASE_SHA is missing or not a commit sha: migration-base.mjs did not run first')
  const marker = {
    candidate: env.MIGRATION_CANDIDATE,
    base,
    prHead: env.MIGRATION_PR_HEAD,
    runAttempt: env.MIGRATION_RUN_ATTEMPT,
  }
  if (inActions) {
    if (!SHA.test(marker.candidate ?? '')) return fail(0, 'MIGRATION_CANDIDATE is missing or not a commit sha')
    if (!(SHA.test(marker.prHead ?? '') || marker.prHead === '-')) return fail(0, 'MIGRATION_PR_HEAD is missing')
    if (!/^\d+$/.test(marker.runAttempt ?? '')) return fail(0, 'MIGRATION_RUN_ATTEMPT is missing')
    try {
      const head = await git.head()
      if (head !== marker.candidate) return fail(0, `checked-out HEAD ${head} is not the candidate ${marker.candidate}`)
    } catch (e) {
      return fail(0, `HEAD could not be read: ${e.message}`)
    }
  }
  const dest = await mkdtemp(path.join(tmpdir(), 'doop-migration-base-'))
  try {
    try {
      await exportBase(base, dest, git)
    } catch (e) {
      return fail(0, `base ${base} could not be read: ${e.message}`)
    }
    const result = await replayMigrations({ baseDir: dest, headDir })
    if (!result.ok) return result
    return { ...result, marker: inActions ? formatReplayMarker(marker) : null }
  } finally {
    await rm(dest, { recursive: true, force: true })
  }
}

export const listMigrationFiles = (dir) => readdir(dir)
