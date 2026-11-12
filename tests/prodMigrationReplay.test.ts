import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import { expect, it } from 'vitest'

/* The C00 production ledger was written by the pre-merge journal: 0034-0038
 * applied with these `when` values (newest 1793062237684). The merged journal
 * gives 0034-0038 newer `when` values so forks that applied comment_events
 * still receive them (forkMigrationOrder.test.ts). Drizzle therefore re-runs
 * 0034-0038 on production, so they must be idempotent (CHE-2734). */
const PROD_WHEN: Record<string, number> = {
  '0034_frame_approval': 1792719758584,
  '0035_approval_automations': 1792742861394,
  '0036_canvas_guides': 1792917173712,
  '0037_local_agent_effort': 1793060896296,
  '0038_reasoning_effort': 1793062237684,
}

it(
  'a production database that applied 0034-0038 under the old journal migrates cleanly',
  { timeout: 60_000 },
  async () => {
    const migrationsFolder = path.resolve('server/db/migrations')
    const journal = JSON.parse(await readFile(path.join(migrationsFolder, 'meta/_journal.json'), 'utf8')) as {
      entries: { tag: string; when: number }[]
    }
    const baseline = await mkdtemp(path.join(tmpdir(), 'doop-prod-migrations-'))
    const client = new PGlite()
    try {
      await mkdir(path.join(baseline, 'meta'))
      const entries = journal.entries
        .filter((entry) => entry.tag <= '0038')
        .map((entry) => ({ ...entry, when: PROD_WHEN[entry.tag] ?? entry.when }))
      await writeFile(path.join(baseline, 'meta/_journal.json'), JSON.stringify({ ...journal, entries }))
      for (const entry of entries) {
        await copyFile(path.join(migrationsFolder, `${entry.tag}.sql`), path.join(baseline, `${entry.tag}.sql`))
      }
      const db = drizzle(client)
      await migrate(db, { migrationsFolder: baseline })
      await migrate(db, { migrationsFolder })
      await migrate(db, { migrationsFolder })
      const tables = await client.query<{ table_name: string }>(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'",
      )
      expect(tables.rows.map((row) => row.table_name)).toEqual(
        expect.arrayContaining(['comment_events', 'canvas_bridge', 'automation_approvals']),
      )
    } finally {
      await client.close()
      await rm(baseline, { recursive: true, force: true })
    }
  },
)
