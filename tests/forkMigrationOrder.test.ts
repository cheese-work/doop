import { mkdtemp, readFile, rm, writeFile, mkdir, copyFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import { expect, it } from 'vitest'

/* drizzle runs only migrations whose journal `when` is newer than the newest
 * one the database applied. The fork's comment_events migration was applied
 * before the upstream migrations that now precede it, so a database that has
 * it must still receive every upstream migration. */
it.each([
  ['comment_events', ['0040_comment_events']],
  ['comment_events and canvas_bridge', ['0040_comment_events', '0041_canvas_bridge']],
])(
  'a database that already has %s still gets every upstream migration',
  { timeout: 60_000 },
  async (_label, forkApplied) => {
    const migrationsFolder = path.resolve('server/db/migrations')
    const journal = JSON.parse(await readFile(path.join(migrationsFolder, 'meta/_journal.json'), 'utf8')) as {
      entries: { tag: string }[]
    }
    const applied = ['0033_canvas_comments', ...forkApplied]
    const baseline = await mkdtemp(path.join(tmpdir(), 'doop-fork-migrations-'))
    const client = new PGlite()
    try {
      await mkdir(path.join(baseline, 'meta'))
      const entries = journal.entries.filter((entry) => entry.tag <= '0033' || applied.includes(entry.tag))
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
      const columns = await client.query<{ table_name: string; column_name: string }>(
        "SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name IN ('approval', 'guides', 'element_id', 'reasoning_effort', 'effort')",
      )
      expect(columns.rows.map((row) => `${row.table_name}.${row.column_name}`).sort()).toEqual(
        expect.arrayContaining([
          'canvases.guides',
          'comments.element_id',
          'frames.approval',
          'local_agent_preferences.effort',
          'model_accounts.reasoning_effort',
        ]),
      )
    } finally {
      await client.close()
      await rm(baseline, { recursive: true, force: true })
    }
  },
)
