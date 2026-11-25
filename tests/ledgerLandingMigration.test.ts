import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
// @ts-expect-error plain .mjs script, no type declarations
import { replayMigrations } from '../scripts/ci/migration-replay.mjs'
// @ts-expect-error plain .mjs script, no type declarations
import { classifyMigration } from '../scripts/migration-classify.mjs'

/* CHE-9675 (A5 landing S1): migration 0072 adds `ledger_landings`. Pattern of migrationReplay.test.ts:
   a database at 0071, the runner applies 0072, the table and its key exist. */
const MIGRATIONS = path.resolve(__dirname, '../server/db/migrations')
const pad = (n: number) => String(n).padStart(4, '0')
type Entry = { idx: number; tag: string }

let root: string
beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'doop-landing-mig-'))
})
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

// The journal and files up to and including the entry whose tag starts with `to`.
async function slice(name: string, to: string): Promise<string> {
  const full = JSON.parse(await readFile(path.join(MIGRATIONS, 'meta/_journal.json'), 'utf8'))
  const last = full.entries.findIndex((e: Entry) => e.tag.startsWith(to))
  if (last < 0) throw new Error(`no journal entry ${to}`)
  const entries: Entry[] = full.entries.slice(0, last + 1)
  const dir = path.join(root, name)
  await mkdir(path.join(dir, 'meta'), { recursive: true })
  for (const e of entries) {
    await cp(path.join(MIGRATIONS, `${e.tag}.sql`), path.join(dir, `${e.tag}.sql`))
    // some old entries have no snapshot; the replay reads the ones that exist
    await cp(
      path.join(MIGRATIONS, `meta/${pad(e.idx)}_snapshot.json`),
      path.join(dir, `meta/${pad(e.idx)}_snapshot.json`),
    ).catch(() => {})
  }
  await writeFile(path.join(dir, 'meta/_journal.json'), JSON.stringify({ ...full, entries }))
  return dir
}

describe('0072_ledger_landings', () => {
  it('is the journal entry right after 0071_frame_pins', async () => {
    const journal = JSON.parse(await readFile(path.join(MIGRATIONS, 'meta/_journal.json'), 'utf8'))
    const tags = journal.entries.map((e: Entry) => e.tag)
    expect(tags[tags.indexOf('0071_frame_pins') + 1]).toBe('0072_ledger_landings')
  })

  it('a database at 0071 takes 0072: the table and its composite key exist, and the table starts empty', async () => {
    const at0071 = await slice('at0071', '0071_')
    const db = new PGlite()
    try {
      await migrate(drizzle(db), { migrationsFolder: at0071 })
      const before = await db.query(`select 1 from information_schema.tables where table_name = 'ledger_landings'`)
      expect(before.rows).toHaveLength(0)

      await migrate(drizzle(db), { migrationsFolder: MIGRATIONS })

      const cols = await db.query<{ column_name: string }>(
        `select column_name from information_schema.columns where table_name = 'ledger_landings' order by ordinal_position`,
      )
      expect(cols.rows.map((r) => r.column_name)).toEqual([
        'id',
        'canvas_id',
        'merge_sha',
        'lock_path',
        'repo',
        'pr',
        'source_page_id',
        'ledger_page_id',
        'label',
        'topic_issue_id',
        'close_decision_id',
        'manifest_sha256',
        'frames',
        'payload_hash',
        'created_by',
        'created_at',
      ])
      const key = await db.query<{ column_name: string }>(
        `select a.attname as column_name
           from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
          where i.indrelid = 'ledger_landings'::regclass and i.indisprimary
          order by array_position(i.indkey::int2[], a.attnum)`,
      )
      expect(key.rows.map((r) => r.column_name)).toEqual(['canvas_id', 'merge_sha', 'lock_path'])
      expect((await db.query('select count(*)::int as n from ledger_landings')).rows).toEqual([{ n: 0 }])
    } finally {
      await db.close()
    }
  }, 300_000)

  it('the replay (journal, ledger and snapshot steps) passes from 0071 to 0072', async () => {
    const base = await slice('replay-base', '0071_')
    const head = await slice('replay-head', '0072_')
    const result = await replayMigrations({ baseDir: base, headDir: head })
    expect(result).toMatchObject({ ok: true, appended: 1 })
  }, 300_000)

  it('the classifier calls the migration additive', async () => {
    const sql = await readFile(path.join(MIGRATIONS, '0072_ledger_landings.sql'), 'utf8')
    const r = await classifyMigration(sql)
    expect(r.statements.filter((s: { additive: boolean }) => !s.additive)).toEqual([])
    expect(r.additive).toBe(true)
  })
})
