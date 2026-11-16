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

// C-8.3: every migration in the C00 ledger keeps its hash and journal entry, order included.
// `ledger` rows are { hash, created_at } from drizzle.__drizzle_migrations; `predecessorMigrations` and
// `candidateMigrations` are inventory lists { name, sha256 } at the running revision and the candidate.
// A ledger hash resolves to exactly one predecessor migration by hash (ambiguous or unknown = stop), and the
// candidate must hold that same name with the same bytes: the same bytes under another name do not count.
// A new migration must be newer than the whole ledger: drizzle applies only entries with `when` above the
// newest ledger row and would silently skip an older one.
export function checkImmutable({
  ledger,
  predecessorJournal,
  predecessorMigrations,
  candidateJournal,
  candidateMigrations,
}) {
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
  if (!Array.isArray(predecessorMigrations) || !Array.isArray(candidateMigrations))
    return no('migration list is missing')

  const byName = new Map(candidateMigrations.map((m) => [m.name, m.sha256]))
  for (const p of predecessorMigrations) {
    if (byName.get(p.name) !== p.sha256) return no(`applied migration ${p.name} changed or deleted in the candidate`)
  }
  for (const r of rows) {
    const named = predecessorMigrations.filter((p) => p.sha256 === r.hash)
    if (named.length !== 1) {
      return no(
        `ledger hash ${r.hash.slice(0, 12)} matches ${named.length} predecessor migrations, expected exactly one`,
      )
    }
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
  const classifier = (reason, names = migrations) => failed.push({ part: 'classifier', migrations: names, reason })
  const results = classification?.migrations
  if (!Array.isArray(results)) classifier('no classifier result')
  else {
    // Exactly one well-formed result per new migration: a missing, duplicate or extra result is not evidence.
    const names = results.map((m) => m?.name)
    const exact =
      names.length === migrations.length &&
      new Set(names).size === names.length &&
      migrations.every((n) => names.includes(n))
    if (!exact)
      classifier(`classifier results [${names.join(', ')}] do not match the new migrations [${migrations.join(', ')}]`)
    else {
      const bad = results.filter(
        (m) => m.additive !== true || !Array.isArray(m.statements) || !m.statements.every((s) => s?.additive === true),
      )
      if (bad.length) {
        classifier(
          bad
            .flatMap((m) => (m.statements ?? []).filter((s) => s?.additive !== true).map((s) => s?.reason))
            .filter(Boolean)
            .join('; ') || 'not additive',
          bad.map((m) => m.name),
        )
      }
    }
  }
  if (snapshot?.ok !== true)
    failed.push({ part: 'snapshot', migrations, reason: snapshot?.reason ?? 'no snapshot diff result' })
  return failed.length ? { deploy: false, forwardOnly: true, failed } : { deploy: true, forwardOnly: false, failed: [] }
}
