import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { afterAll, expect, it } from 'vitest'

/* CHE-6624: a page copy whose policy check refuses at the commit must leave nothing in the real
   database (temporary pglite), not just nothing in memory. */
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doop-pagecopy-'))
const cwd = process.cwd()
process.chdir(dir)
const dbm = await import('../server/db/index.ts')
const t = await import('../server/db/schema.ts')
const persist = await import('../server/db/persist.ts')
await dbm.initDb()
process.chdir(cwd)
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

const canvas = {
  id: 'c-atomic',
  name: 'x',
  ownerId: 'u',
  createdAt: 1,
  updatedAt: 1,
  pages: [{ id: 'p1', name: 'P1' }],
  frames: [],
}
const frame = (id: string) => ({
  id,
  canvasId: canvas.id,
  pageId: 'p2',
  name: id,
  x: 0,
  y: 0,
  width: 10,
  height: 10,
  html: '<p/>',
  createdAt: 1,
  updatedAt: 1,
  updatedBy: 'a',
})

it('a refusal inside the page-copy transaction rolls back the frames and the page list', async () => {
  const copy = { ...canvas, pages: [...canvas.pages, { id: 'p2', name: 'P2' }] }
  await dbm.db.insert(t.canvases).values({ id: canvas.id, ...persistColumns(canvas), createdAt: 1 })
  await expect(
    persist.savePageCopy(copy as never, [frame('f-copied')] as never, () => {
      throw new Error('policy_refused: copy_page')
    }),
  ).rejects.toThrow(/policy_refused/)
  expect(await dbm.db.select().from(t.frames).where(eq(t.frames.id, 'f-copied'))).toHaveLength(0)
  const [row] = await dbm.db.select().from(t.canvases).where(eq(t.canvases.id, canvas.id))
  expect((row!.pages as { id: string }[]).map((p) => p.id)).toEqual(['p1'])
})

it('the same copy commits when nothing refuses', async () => {
  const copy = { ...canvas, pages: [...canvas.pages, { id: 'p2', name: 'P2' }] }
  await persist.savePageCopy(copy as never, [frame('f-kept')] as never, () => undefined)
  expect(await dbm.db.select().from(t.frames).where(eq(t.frames.id, 'f-kept'))).toHaveLength(1)
})

function persistColumns(c: typeof canvas) {
  return { name: c.name, ownerId: c.ownerId, pages: c.pages, updatedAt: c.updatedAt }
}
