// Static rollback-compatibility diff (C-8.5a, CHE-5474 S4a) between the drizzle snapshot of the running
// revision and the candidate's. Allowed: new tables; new columns that are nullable or have a constant
// default; new non-unique indexes. Anything else, or an unreadable snapshot, is "insufficient" (ok: false),
// which takes the forward-only path (C-8.6).
import { readFile } from 'node:fs/promises'
import { isDeepStrictEqual } from 'node:util'
import { pathToFileURL } from 'node:url'

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const NUMBER_OR_LITERAL = /^(-?\d+(\.\d+)?|true|false|null|'(?:[^']|'')*'(::[\w\s"[\]]+)?)$/i
const constantDefault = (d) =>
  typeof d === 'number' || typeof d === 'boolean' || (typeof d === 'string' && NUMBER_OR_LITERAL.test(d.trim()))
const no = (reason) => ({ ok: false, reason })

function newColumn(table, name, c) {
  const where = `new column ${table}.${name}`
  if (c.primaryKey || c.generated || c.identity) return `${where} is a key, generated or identity column`
  if (c.default !== undefined && !constantDefault(c.default)) return `${where} has a non-constant default`
  if (c.notNull && c.default === undefined) return `${where} is NOT NULL without a default`
  return null
}

function diffTable(key, before, after) {
  const { columns: bc = {}, indexes: bi = {}, ...bRest } = before
  const { columns: ac = {}, indexes: ai = {}, ...aRest } = after
  if (!isDeepStrictEqual(bRest, aRest))
    return `table ${key} changed beyond columns and indexes (constraint, foreign key or setting)`
  for (const [n, c] of Object.entries(bc)) {
    if (!(n in ac)) return `column ${key}.${n} was dropped`
    if (!isDeepStrictEqual(c, ac[n])) return `column ${key}.${n} changed (type, nullability or default)`
  }
  for (const [n, c] of Object.entries(ac))
    if (!(n in bc)) {
      const r = newColumn(key, n, c)
      if (r) return r
    }
  for (const [n, i] of Object.entries(bi)) {
    if (!(n in ai)) return `index ${n} on ${key} was dropped`
    if (!isDeepStrictEqual(i, ai[n])) return `index ${n} on ${key} changed`
  }
  for (const [n, i] of Object.entries(ai)) if (!(n in bi) && i.isUnique) return `new unique index ${n} on ${key}`
  return null
}

export function diffSnapshots(before, after) {
  if (!isObj(before) || !isObj(after) || !isObj(before.tables) || !isObj(after.tables)) {
    return no('snapshot missing or unreadable')
  }
  const { id: _a, prevId: _b, tables: bt, ...bRest } = before
  const { id: _c, prevId: _d, tables: at, ...aRest } = after
  if (!isDeepStrictEqual(bRest, aRest)) return no('enums, schemas, sequences, roles, policies or views changed')
  for (const [key, table] of Object.entries(bt)) {
    if (!(key in at)) return no(`table ${key} was dropped`)
    const reason = diffTable(key, table, at[key])
    if (reason) return no(reason)
  }
  return { ok: true }
}

// Journal entries without a `meta/<idx>_snapshot.json` in `files`.
export const missingSnapshots = (entries, files) =>
  entries.map((e) => `${String(e.idx).padStart(4, '0')}_snapshot.json`).filter((f) => !files.includes(f))

// CLI: node scripts/migration-snapshot.mjs <before.json> <after.json>; exits 1 when insufficient.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const read = (p) => readFile(p, 'utf8').then(JSON.parse, () => undefined)
  const r = diffSnapshots(await read(process.argv[2] ?? ''), await read(process.argv[3] ?? ''))
  console.log(JSON.stringify(r))
  process.exit(r.ok ? 0 : 1)
}
