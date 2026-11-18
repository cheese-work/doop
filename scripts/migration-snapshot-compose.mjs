// Snapshot composer (S3c, CHE-7297 of CHE-7207). A fork sync appends upstream migrations after the fork's own, so
// the upstream drizzle snapshots (each the state of upstream's schema, not ours) cannot be copied. Instead:
//   composed_0 = the base tail snapshot; composed_j = composed_(j-1) with Δj applied,
// where Δj is the difference between incoming snapshots j-1 and j, per column, index, foreign key, primary key,
// unique and check constraint, policy and table attribute; enums, sequences, schemas, roles and views by name.
//   add X      absent: add. present and identical: no-op. present and different: stop.
//   modify X   (old -> new) present and equal to old: set new. present and equal to new: no-op. else stop.
//   remove X   present and equal to old: remove. else stop.
// Base snapshots are never edited. The caller checks the last composed snapshot against `generateSnapshot` of the
// resolved schema with `diffSnapshotObjects` (ignores id and prevId).
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { pathToFileURL } from 'node:url'
import { readFile, writeFile } from 'node:fs/promises'

const TABLE_GROUPS = [
  'columns',
  'indexes',
  'foreignKeys',
  'compositePrimaryKeys',
  'uniqueConstraints',
  'policies',
  'checkConstraints',
]
const TOP_GROUPS = ['enums', 'sequences', 'schemas', 'roles', 'policies', 'views']
const eq = isDeepStrictEqual
const clone = (v) => JSON.parse(JSON.stringify(v)) // snapshots are plain JSON

// Δ between two keyed collections: [{ path, op, old?, new? }]
function delta(path, a = {}, b = {}) {
  const out = []
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const p = `${path}.${k}`
    if (!(k in b)) out.push({ path: p, op: 'remove', old: a[k] })
    else if (!(k in a)) out.push({ path: p, op: 'add', new: b[k] })
    else if (!eq(a[k], b[k])) out.push({ path: p, op: 'modify', old: a[k], new: b[k] })
  }
  return out
}

const tableAttrs = (t) => Object.fromEntries(Object.entries(t).filter(([k]) => !TABLE_GROUPS.includes(k)))

function deltas(prev, next) {
  const out = []
  const pt = prev.tables ?? {}
  const nt = next.tables ?? {}
  for (const k of new Set([...Object.keys(pt), ...Object.keys(nt)])) {
    const p = `tables.${k}`
    if (!(k in nt)) out.push({ path: p, op: 'remove', old: pt[k] })
    else if (!(k in pt)) out.push({ path: p, op: 'add', new: nt[k] })
    else {
      out.push(...delta(`${p}.@attr`, tableAttrs(pt[k]), tableAttrs(nt[k])))
      for (const g of TABLE_GROUPS) out.push(...delta(`${p}.${g}`, pt[k][g], nt[k][g]))
    }
  }
  for (const g of TOP_GROUPS) out.push(...delta(g, prev[g], next[g]))
  return out
}

// Resolve a delta path to [container, key] inside `snap`; table attributes live on the table itself.
function locate(snap, path) {
  const m =
    /^tables\.(.+?)(?:\.(@attr|columns|indexes|foreignKeys|compositePrimaryKeys|uniqueConstraints|policies|checkConstraints)\.(.+))?$/.exec(
      path,
    )
  if (m) {
    const [, table, group, key] = m
    if (!group) return [snap.tables, table]
    const t = snap.tables[table]
    if (!t) return [undefined, key] // the table itself is absent
    if (group === '@attr') return [t, key]
    return [(t[group] ??= {}), key]
  }
  const [group, ...rest] = path.split('.')
  return [(snap[group] ??= {}), rest.join('.')]
}

function apply(snap, d) {
  const [box, key] = locate(snap, d.path)
  if (!box) return 'table absent'
  const cur = box[key]
  const has = key in box
  if (d.op === 'add') {
    if (!has) box[key] = clone(d.new)
    else if (!eq(cur, d.new)) return 'present and different'
  } else if (d.op === 'modify') {
    if (!has) return 'absent'
    if (eq(cur, d.old)) box[key] = clone(d.new)
    else if (!eq(cur, d.new)) return 'present and different from both old and new'
  } else {
    if (has && eq(cur, d.old)) delete box[key]
    else return has ? 'present and different from old' : 'absent'
  }
  return null
}

/** incoming = [predecessor, s1..sk]; returns { ok: true, snapshots: [composed_1..composed_k] } or the first stop. */
export function composeSnapshots(base, incoming) {
  let prevComposed = base
  const snapshots = []
  for (let j = 1; j < incoming.length; j++) {
    const next = clone(prevComposed)
    next.id = randomUUID()
    next.prevId = prevComposed.id
    for (const d of deltas(incoming[j - 1], incoming[j])) {
      const reason = apply(next, d)
      if (reason)
        return { ok: false, step: j, op: d.op, path: d.path.replace('.@attr', ''), reason, old: d.old, new: d.new }
    }
    snapshots.push(next)
    prevComposed = next
  }
  return { ok: true, snapshots }
}

/** Differing paths of two snapshots, ignoring the top-level id and prevId; [] means equal. */
export function diffSnapshotObjects(a, b) {
  const out = []
  const walk = (x, y, path) => {
    if (eq(x, y)) return
    const objs = x && y && typeof x === 'object' && typeof y === 'object' && !Array.isArray(x) && !Array.isArray(y)
    if (!objs) return void out.push(path)
    for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) {
      if (!path && (k === 'id' || k === 'prevId')) continue
      walk(x[k], y[k], path ? `${path}.${k}` : k)
    }
  }
  walk(a, b, '')
  return out
}

/** drizzle-kit's snapshot of schema modules (paths to .ts or .js files); needs a runtime that can import them (tsx). */
export async function generateSnapshot(schemaFiles) {
  const { generateDrizzleJson } = await import('drizzle-kit/api')
  const imports = await Promise.all(schemaFiles.map((f) => import(pathToFileURL(f).href)))
  // JSON round trip: the form drizzle writes to disk (its in-memory objects differ in prototype and undefined keys)
  return JSON.parse(JSON.stringify(generateDrizzleJson(Object.assign({}, ...imports))))
}

// CLI (run under tsx): migration-snapshot-compose.mjs --base <0054.json> --incoming <pred.json,s1.json,..>
//   --schema <schema.ts,auth-schema.ts> --out <dir> --first <idx>
// writes <dir>/<idx>_snapshot.json for each composed snapshot; exit 1 on a stop or a schema mismatch.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const arg = (n) => process.argv[process.argv.indexOf(`--${n}`) + 1]
  const read = async (p) => JSON.parse(await readFile(p, 'utf8'))
  const r = composeSnapshots(await read(arg('base')), await Promise.all(arg('incoming').split(',').map(read)))
  if (!r.ok) {
    console.log(JSON.stringify(r))
    process.exit(1)
  }
  const bad = diffSnapshotObjects(r.snapshots.at(-1), await generateSnapshot(arg('schema').split(',')))
  if (bad.length) {
    console.log(JSON.stringify({ ok: false, reason: 'composed snapshot differs from the resolved schema', diff: bad }))
    process.exit(1)
  }
  await Promise.all(
    r.snapshots.map((s, i) =>
      writeFile(
        `${arg('out')}/${String(Number(arg('first')) + i).padStart(4, '0')}_snapshot.json`,
        `${JSON.stringify(s, null, 2)}\n`,
      ),
    ),
  )
  console.log(JSON.stringify({ ok: true, written: r.snapshots.length }))
}
