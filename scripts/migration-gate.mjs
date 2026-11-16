// Migration gate checks for the deploy train (CHE-5474 S4a, C-8.2, C-8.3, C-8.6). Pure functions: the
// workflow reads git, the C00 ledger and the journals and hands them in. Every unknown fails closed.
import { isDeepStrictEqual } from 'node:util'

const SHA = /^[0-9a-f]{40}$/
const HASH = /^[0-9a-f]{64}$/
const no = (reason) => ({ ok: false, reason })

// C-8.2: the candidate must be a strict descendant of the revision label read from the C00 container.
export async function checkAncestry({ label, candidate, isAncestor }) {
  if (typeof label !== 'string' || !SHA.test(label)) return no('running revision label is missing or not a commit sha')
  if (typeof candidate !== 'string' || !SHA.test(candidate)) return no('candidate is not a commit sha')
  if (label === candidate) return no('candidate is the running revision, not a descendant')
  try {
    if (!(await isAncestor(label, candidate)))
      return no(`running revision ${label.slice(0, 7)} is not an ancestor of ${candidate.slice(0, 7)}`)
  } catch (e) {
    return no(`ancestry could not be checked: ${e.message}`)
  }
  return { ok: true }
}

// C-8.3: every migration in the C00 ledger keeps its hash and its journal entry, order included.
// `ledger` rows are { hash, created_at } from drizzle.__drizzle_migrations; `candidateMigrations` is the
// inventory list { name, sha256 }. A new migration must be newer than the whole ledger: drizzle applies
// only entries with `when` above the newest ledger row and would silently skip an older one.
export function checkImmutable({ ledger, predecessorJournal, candidateJournal, candidateMigrations }) {
  if (!Array.isArray(ledger) || ledger.length === 0) return no('C00 ledger is empty or unreadable')
  const rows = []
  for (const r of ledger) {
    const created = Number(r?.created_at)
    if (typeof r?.hash !== 'string' || !HASH.test(r.hash) || !Number.isFinite(created))
      return no('C00 ledger row is unreadable')
    rows.push({ hash: r.hash, created })
  }
  const before = predecessorJournal?.entries
  const after = candidateJournal?.entries
  if (!Array.isArray(before) || !Array.isArray(after)) return no('journal is missing or unreadable')

  const byName = new Map(candidateMigrations.map((m) => [m.name, m.sha256]))
  const hashes = new Set(byName.values())
  for (const r of rows) {
    const tag = before.find((e) => e.when === r.created)?.tag
    const label = tag ? `applied migration ${tag}` : `applied migration with ledger hash ${r.hash.slice(0, 12)}`
    if (tag ? byName.get(`${tag}.sql`) !== r.hash : !hashes.has(r.hash))
      return no(`${label} changed or deleted in the candidate`)
  }
  for (const [i, e] of before.entries()) {
    if (!isDeepStrictEqual(e, after[i])) return no(`journal entry ${e.tag} changed, moved or deleted`)
  }
  const newest = Math.max(...rows.map((r) => r.created))
  const newMigrations = []
  for (const e of after.slice(before.length)) {
    if (!byName.has(`${e.tag}.sql`)) return no(`new migration ${e.tag} has no sql file`)
    if (!(e.when > newest)) return no(`new migration ${e.tag} is not newer than the ledger; drizzle would skip it`)
    newMigrations.push(`${e.tag}.sql`)
  }
  return { ok: true, newMigrations }
}

// C-8.6: ancestry or immutability failing stops the run. A not-additive or insufficient-evidence candidate
// is forward-only: it skips every window, and the failed part and migrations are named.
export function decide({ ancestry, immutable, classification, snapshot } = {}) {
  const hard = []
  if (ancestry?.ok !== true) hard.push({ part: 'ancestry', reason: ancestry?.reason ?? 'no ancestry result' })
  if (immutable?.ok !== true) hard.push({ part: 'immutable', reason: immutable?.reason ?? 'no immutability result' })
  if (hard.length) return { deploy: false, forwardOnly: false, failed: hard }
  const migrations = immutable.newMigrations
  if (migrations.length === 0) return { deploy: true, forwardOnly: false, failed: [] }
  const failed = []
  if (!classification) failed.push({ part: 'classifier', migrations, reason: 'no classifier result' })
  else if (classification.additive !== true) {
    const bad = (classification.migrations ?? []).filter((m) => !m.additive)
    failed.push({
      part: 'classifier',
      migrations: bad.length ? bad.map((m) => m.name) : migrations,
      reason:
        bad.flatMap((m) => m.statements.filter((s) => !s.additive).map((s) => s.reason)).join('; ') || 'not additive',
    })
  }
  if (snapshot?.ok !== true)
    failed.push({ part: 'snapshot', migrations, reason: snapshot?.reason ?? 'no snapshot diff result' })
  return failed.length ? { deploy: false, forwardOnly: true, failed } : { deploy: true, forwardOnly: false, failed: [] }
}
