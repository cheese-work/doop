// PR-time migration ledger check (CHE-7207 S2). Runs in the `lint` job right after `scripts/ci/migration-base.mjs`
// (S2a), which exports MIGRATION_BASE_SHA. The base journal stands in for the C00 ledger: one row per base entry,
// hash = sha256 of its SQL bytes, created_at = its `when`. `checkImmutable` (C-8.3) then runs unchanged, and 2 rules
// are added for the entries the head appends:
//   1. `when` strictly increases (checkImmutable only requires each one to be newer than the newest ledger row);
//   2. each appended entry has a drizzle snapshot whose `prevId` is the `id` of the entry before it, starting at
//      the base tail. Entries already in the base are not checked: four legacy ones have no snapshot (CHE-5474).
// Fails closed. Marker on success: `migration-ledger-check OK base=<B> head=<H>`, H = the checked-out HEAD
// (github.sha, the merge commit on a pull_request).
import { execFile } from 'node:child_process'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { checkImmutable } from './migration-gate.mjs'

const run = promisify(execFile)
const SHA = /^[0-9a-f]{40}$/
const no = (reason) => ({ ok: false, reason })
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')
const snapshotFile = (idx) => `${String(idx).padStart(4, '0')}_snapshot.json`
const DIR = 'server/db/migrations'

export const formatLedgerMarker = ({ base, head }) => `migration-ledger-check OK base=${base} head=${head}`

// Pure. `headSnapshots` maps `NNNN_snapshot.json` to the parsed { id, prevId } (null when unreadable).
export function checkLedger({ baseJournal, baseMigrations, headJournal, headMigrations, headSnapshots }) {
  const base = baseJournal?.entries
  const head = headJournal?.entries
  if (!Array.isArray(base) || !Array.isArray(head)) return no('journal is missing or unreadable')
  if (!Array.isArray(baseMigrations) || !Array.isArray(headMigrations)) return no('migration list is missing')
  if (!headSnapshots || typeof headSnapshots !== 'object') return no('snapshots are missing')

  const ledger = []
  for (const e of base) {
    const m = baseMigrations.find((x) => x.name === `${e.tag}.sql`)
    if (!m) return no(`base migration ${e.tag} has no sql file`)
    ledger.push({ hash: m.sha256, created_at: e.when })
  }
  const immutable = checkImmutable({
    ledger,
    predecessorJournal: baseJournal,
    predecessorMigrations: baseMigrations,
    candidateJournal: headJournal,
    candidateMigrations: headMigrations,
  })
  if (!immutable.ok) return immutable

  const added = head.slice(base.length)
  let prevWhen = base.at(-1)?.when
  let prev = base.at(-1)
  for (const e of added) {
    if (!(e.when > prevWhen))
      return no(`new migration ${e.tag} when ${e.when} is not strictly increasing after ${prevWhen}`)
    prevWhen = e.when
    const file = snapshotFile(e.idx)
    const snap = headSnapshots[file]
    if (snap === undefined) return no(`new migration ${e.tag} has no snapshot ${file}`)
    if (!snap || typeof snap.id !== 'string' || typeof snap.prevId !== 'string')
      return no(`snapshot ${file} is unreadable`)
    const before = headSnapshots[snapshotFile(prev.idx)]
    if (!before || typeof before.id !== 'string')
      return no(`snapshot ${snapshotFile(prev.idx)} before ${file} is missing`)
    if (snap.prevId !== before.id)
      return no(`snapshot ${file} prevId ${snap.prevId} is not ${snapshotFile(prev.idx)} id ${before.id}`)
    prev = e
  }
  return immutable
}

const readJson = async (p) => JSON.parse(await readFile(p, 'utf8'))

// Head side, from the working tree: the sql inventory (name, sha256 of bytes), the journal and every snapshot.
export async function loadMigrations(dir) {
  const names = (await readdir(dir)).filter((n) => n.endsWith('.sql')).sort()
  const migrations = []
  for (const name of names) migrations.push({ name, sha256: sha256(await readFile(path.join(dir, name))) })
  const journal = await readJson(path.join(dir, 'meta/_journal.json'))
  const snapshots = {}
  for (const f of (await readdir(path.join(dir, 'meta'))).filter((n) => n.endsWith('_snapshot.json'))) {
    snapshots[f] = await readJson(path.join(dir, 'meta', f)).then(
      (s) => ({ id: s.id, prevId: s.prevId }),
      () => null,
    )
  }
  return { migrations, journal, snapshots }
}

// Base side, from git objects at `base`: the journal and the sql files, hashed from their bytes.
async function loadBase(base) {
  const show = async (p) =>
    (await run('git', ['show', `${base}:${p}`], { encoding: 'buffer', maxBuffer: 64 << 20 })).stdout
  const names = (await run('git', ['ls-tree', '--name-only', `${base}:${DIR}`])).stdout
    .split('\n')
    .filter((n) => n.endsWith('.sql'))
    .sort()
  const migrations = []
  for (const name of names) migrations.push({ name, sha256: sha256(await show(`${DIR}/${name}`)) })
  return { journal: JSON.parse((await show(`${DIR}/meta/_journal.json`)).toString('utf8')), migrations }
}

async function cli(env) {
  const base = env.MIGRATION_BASE_SHA
  if (!SHA.test(base ?? ''))
    return no('MIGRATION_BASE_SHA is missing or not a commit sha (did migration-base run first?)')
  const head = env.GITHUB_SHA || (await run('git', ['rev-parse', 'HEAD'])).stdout.trim()
  if (!SHA.test(head)) return no('head is not a commit sha')
  const b = await loadBase(base)
  const h = await loadMigrations(DIR)
  const r = checkLedger({
    baseJournal: b.journal,
    baseMigrations: b.migrations,
    headJournal: h.journal,
    headMigrations: h.migrations,
    headSnapshots: h.snapshots,
  })
  return r.ok ? { ...r, marker: formatLedgerMarker({ base, head }) } : r
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  cli(process.env).then(
    (r) => {
      if (r.ok) {
        console.log(r.marker)
        process.exit(0)
      }
      console.log(`migration-ledger-check FAIL ${r.reason}`)
      process.exit(1)
    },
    (err) => {
      console.log(`migration-ledger-check FAIL ${err.message}`)
      process.exit(1)
    },
  )
}
