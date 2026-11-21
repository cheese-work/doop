import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { expect, it } from 'vitest'
// @ts-expect-error plain .mjs script, no type declarations
import { inventory } from '../scripts/migration-inventory.mjs'
// @ts-expect-error plain .mjs script, no type declarations
import { checkImmutable } from '../scripts/migration-gate.mjs'

/* CHE-5474 C-8.3 on this PR's real files: the predecessor (cheese/main 7d5d03c, the revision C00 runs)
   is frozen in a fixture. The candidate must keep every applied migration's name, bytes and journal
   entry, and append the upstream migrations newer than the ledger. */
const dir = path.resolve('server/db/migrations')
const readJson = async (p: string) => JSON.parse(await readFile(p, 'utf8')) as never

it('the candidate keeps every migration the C00 ledger has applied (C-8.3)', async () => {
  const pred = (await readJson(path.resolve('tests/fixtures/migration-predecessor.json'))) as {
    migrations: { name: string; sha256: string }[]
    journal: { entries: { tag: string; when: number }[] }
  }
  const ledger = pred.journal.entries.map((e) => ({
    hash: pred.migrations.find((m) => m.name === `${e.tag}.sql`)!.sha256,
    created_at: e.when,
  }))
  const r = checkImmutable({
    ledger,
    predecessorJournal: pred.journal,
    predecessorMigrations: pred.migrations,
    candidateJournal: await readJson(path.join(dir, 'meta/_journal.json')),
    candidateMigrations: (await inventory(dir)).migrations,
  })
  expect(r).toMatchObject({ ok: true })
  /* 0046-0054 came in with the 0.14 merge, 0055-0065 (upstream 0049-0059, renumbered) with 0.15.0, 0066 is the G3 attestation + Multica task id */
  expect(r.newMigrations).toHaveLength(21)
})
