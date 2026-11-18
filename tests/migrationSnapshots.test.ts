import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { expect, it } from 'vitest'
// @ts-expect-error plain .mjs script, no type declarations
import { classifyMigration } from '../scripts/migration-classify.mjs'
// @ts-expect-error plain .mjs script, no type declarations
import { diffSnapshots, missingSnapshots } from '../scripts/migration-snapshot.mjs'

/* CHE-5474 C-8.5a: the rollback-compatibility diff compares drizzle snapshots, so every journal entry
   must have one. A new migration without its snapshot fails here, before it can reach a deploy. */
const dir = path.resolve('server/db/migrations')
const entries = async () =>
  (
    JSON.parse(await readFile(path.join(dir, 'meta/_journal.json'), 'utf8')) as {
      entries: { idx: number; tag: string }[]
    }
  ).entries

/* These four predate the check and have no snapshot (the OSS journal skips and renumbers around them). The
   diff only reads the newest snapshot of each side, so they are not needed; the list never grows. */
const LEGACY_MISSING = ['0019_snapshot.json', '0023_snapshot.json', '0024_snapshot.json', '0025_snapshot.json']

it('every journal entry has a drizzle snapshot', async () => {
  const files = await readdir(path.join(dir, 'meta'))
  expect(missingSnapshots(await entries(), files)).toEqual(LEGACY_MISSING)
})

it('0045 is additive over 0044, by sql and by snapshot', async () => {
  const read = async (f: string) => JSON.parse(await readFile(path.join(dir, f), 'utf8')) as unknown
  expect(diffSnapshots(await read('meta/0044_snapshot.json'), await read('meta/0045_snapshot.json'))).toEqual({
    ok: true,
  })
  const sql = await readFile(path.join(dir, '0045_frame_write_keys.sql'), 'utf8')
  expect((await classifyMigration(sql)).additive).toBe(true)
})

/* CHE-7205: the upstream 0.15.0 merge renumbered upstream 0049-0059 to 0055-0065. Each renumbered snapshot must
   still carry every fork table and column of 0054, and the chain must stay additive and linked end to end. */
it('0055-0065 keep every fork table and column of 0054 and chain from it', async () => {
  const read = async (n: number) =>
    JSON.parse(await readFile(path.join(dir, `meta/${String(n).padStart(4, '0')}_snapshot.json`), 'utf8')) as {
      id: string
      prevId: string
      tables: Record<string, { columns: Record<string, unknown> }>
    }
  let prev = await read(54)
  const fork = prev
  for (let n = 55; n <= 65; n++) {
    const cur = await read(n)
    expect(cur.prevId, `snapshot ${n} prevId`).toBe(prev.id)
    for (const [t, table] of Object.entries(fork.tables)) {
      expect(cur.tables[t], `snapshot ${n} lost table ${t}`).toBeDefined()
      for (const c of Object.keys(table.columns)) {
        expect(cur.tables[t]?.columns[c], `snapshot ${n} lost ${t}.${c}`).toBeDefined()
      }
    }
    expect(diffSnapshots(prev, cur), `snapshot ${n - 1} -> ${n}`).toEqual({ ok: true })
    prev = cur
  }
})
