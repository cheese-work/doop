import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Canvas, Frame } from '../shared/types.ts'

/**
 * The database is the second line of the frame lock: a write of a locked
 * frame's row never changes the stored html, width or height, even if a bug
 * upstream hands it a changed locked frame. Name, position and the lock itself
 * still go through, and an unlock written together with new html lands whole.
 * Runs on PGlite in a temp directory, so no Postgres is needed.
 */

const FRAME: Frame = {
  id: 'dbl-f1',
  canvasId: 'dbl-c1',
  pageId: 'p1',
  name: 'Hero',
  html: '<h1>Original</h1>',
  x: 0,
  y: 0,
  width: 640,
  height: 480,
  createdAt: 1,
  updatedAt: 1,
  updatedBy: 'seed',
  locked: true,
}
const CANVAS: Canvas = {
  id: 'dbl-c1',
  name: 'DB lock',
  ownerId: 'o1',
  createdAt: 1,
  updatedAt: 1,
  pages: [{ id: 'p1', name: 'Page 1' }],
  frames: [FRAME],
}

let dir: string
let persist: typeof import('../server/db/persist.ts')
let db: typeof import('../server/db/index.ts').db
let t: typeof import('../server/db/schema.ts')

const row = async () => (await db.select().from(t.frames).where(eq(t.frames.id, FRAME.id)))[0]!

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doop-lock-'))
  vi.spyOn(process, 'cwd').mockReturnValue(dir)
  const index = await import('../server/db/index.ts')
  await index.initDb()
  db = index.db
  persist = await import('../server/db/persist.ts')
  t = await import('../server/db/schema.ts')
  await persist.saveCanvasCopy(CANVAS)
}, 120_000)

afterAll(() => {
  vi.restoreAllMocks()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('persist.saveFrameNow on a locked row', () => {
  it('keeps the stored html, width and height of a locked frame', async () => {
    await persist.saveFrameNow({
      ...FRAME,
      html: '<p>smuggled</p>',
      width: 1,
      height: 2,
      name: 'Renamed',
      x: 9,
      updatedAt: 2,
    })
    expect(await row()).toMatchObject({
      html: '<h1>Original</h1>',
      width: 640,
      height: 480,
      name: 'Renamed',
      x: 9,
      locked: true,
    })
  })

  it('writes everything when the same save unlocks the frame', async () => {
    await persist.saveFrameNow({ ...FRAME, locked: false, html: '<p>after unlock</p>', width: 320, updatedAt: 3 })
    expect(await row()).toMatchObject({ html: '<p>after unlock</p>', width: 320, locked: false })
  })

  it('writes html freely on an unlocked row', async () => {
    await persist.saveFrameNow({ ...FRAME, locked: false, html: '<p>again</p>', updatedAt: 4 })
    expect((await row()).html).toBe('<p>again</p>')
  })
})
