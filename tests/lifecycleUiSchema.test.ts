import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * CHE-9308 S0: migration 0068_lifecycle_ui adds the lifecycle UI columns (frame
 * lock and archive attribution, comment resolution). All are nullable, so a row
 * written in the old shape still inserts. Runs on PGlite in a temp directory.
 */

const FRAME_COLS = { locked_by: 'text', locked_at: 'bigint', lock_reason: 'text', archive_origin: 'jsonb' }
const COMMENT_COLS = { resolution: 'text', resolution_ref: 'text', resolution_note: 'text' }

let dir: string
let db: typeof import('../server/db/index.ts').db
let t: typeof import('../server/db/schema.ts')

type ColRow = { column_name: string; data_type: string; is_nullable: string }
const columns = async (table: string) => {
  const res = await db.execute(
    sql`select column_name, data_type, is_nullable from information_schema.columns where table_name = ${table}`,
  )
  return new Map((res.rows as ColRow[]).map((r) => [r.column_name, r]))
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doop-lcui-'))
  vi.spyOn(process, 'cwd').mockReturnValue(dir)
  const index = await import('../server/db/index.ts')
  await index.initDb()
  db = index.db
  t = await import('../server/db/schema.ts')
}, 120_000)

afterAll(() => {
  vi.restoreAllMocks()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('0068_lifecycle_ui', () => {
  it.each([
    ['frames', FRAME_COLS],
    ['comments', COMMENT_COLS],
  ])('%s has the new columns, all nullable', async (table, want) => {
    const cols = await columns(table)
    for (const [name, type] of Object.entries(want)) {
      expect(cols.get(name), `${table}.${name}`).toMatchObject({ data_type: type, is_nullable: 'YES' })
    }
  })

  it('keeps the lock columns of main out of this migration', async () => {
    const cols = await columns('frames')
    expect(cols.has('lock_epoch')).toBe(false)
    expect(cols.has('lock_attestation_id')).toBe(false)
  })

  it('an old-shape frame and comment insert still works and reads the new columns as null', async () => {
    await db.insert(t.frames).values({
      id: 'lcui-f1',
      canvasId: 'lcui-c1',
      name: 'Hero',
      x: 0,
      y: 0,
      width: 1,
      height: 1,
      html: '',
      createdAt: 1,
      updatedAt: 1,
      updatedBy: 'seed',
    })
    await db.insert(t.comments).values({
      id: 'lcui-m1',
      canvasId: 'lcui-c1',
      snippet: '',
      fromName: 'a',
      text: 'hi',
      at: 1,
    })
    const f = (await db.select().from(t.frames).where(eq(t.frames.id, 'lcui-f1')))[0]!
    expect(f).toMatchObject({ lockedBy: null, lockedAt: null, lockReason: null, archiveOrigin: null })
    const m = (await db.select().from(t.comments).where(eq(t.comments.id, 'lcui-m1')))[0]!
    expect(m).toMatchObject({ resolution: null, resolutionRef: null, resolutionNote: null })
  })

  it('stores the new columns', async () => {
    const origin = { pageId: 'p1', hidden: true, archivedAt: 5, by: 'u1' }
    await db
      .update(t.frames)
      .set({ lockedBy: 'u1', lockedAt: 7, lockReason: 'review', archiveOrigin: origin })
      .where(eq(t.frames.id, 'lcui-f1'))
    await db
      .update(t.comments)
      .set({ resolution: 'fixed', resolutionRef: 'abc', resolutionNote: 'done' })
      .where(eq(t.comments.id, 'lcui-m1'))
    const f = (await db.select().from(t.frames).where(eq(t.frames.id, 'lcui-f1')))[0]!
    expect(f).toMatchObject({ lockedBy: 'u1', lockedAt: 7, lockReason: 'review', archiveOrigin: origin })
    const m = (await db.select().from(t.comments).where(eq(t.comments.id, 'lcui-m1')))[0]!
    expect(m).toMatchObject({ resolution: 'fixed', resolutionRef: 'abc', resolutionNote: 'done' })
  })
})
