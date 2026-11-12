import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Canvas, Frame, PageSnapshot } from '../shared/types.ts'

/**
 * Page snapshots on the real schema (CHE-5307), on PGlite in a temp directory:
 * unchanged frame HTML is stored once, snapshots outlive the 50-per-frame
 * autosave history, and deleting a canvas takes its snapshots and blobs along.
 */

const frame = (id: string, html: string): Frame => ({
  id,
  canvasId: 'dbs-c1',
  pageId: 'p1',
  name: id,
  html,
  x: 0,
  y: 0,
  width: 640,
  height: 480,
  createdAt: 1,
  updatedAt: 1,
  updatedBy: 'seed',
})
const CANVAS: Canvas = {
  id: 'dbs-c1',
  name: 'DB snapshots',
  ownerId: 'o1',
  createdAt: 1,
  updatedAt: 1,
  pages: [{ id: 'p1', name: 'Page 1' }],
  frames: [frame('dbs-f1', '<h1>One</h1>'), frame('dbs-f2', '<h1>Two</h1>')],
}

let dir: string
let persist: typeof import('../server/db/persist.ts')
let db: typeof import('../server/db/index.ts').db
let t: typeof import('../server/db/schema.ts')

const hashOf = (html: string) => `h-${html.length}-${html.charCodeAt(4)}`
const snap = (id: string, createdAt: number, htmls: Record<string, string>): [PageSnapshot, Map<string, string>] => [
  {
    id,
    canvasId: 'dbs-c1',
    pageId: 'p1',
    pageName: 'Page 1',
    name: id,
    author: 'Claude',
    authorKind: 'agent',
    createdAt,
    frames: Object.entries(htmls).map(([frameId, html]) => ({
      frameId,
      name: frameId,
      x: 0,
      y: 0,
      width: 640,
      height: 480,
      deleted: false,
      hash: hashOf(html),
      htmlBytes: html.length,
    })),
  },
  new Map(Object.values(htmls).map((html) => [hashOf(html), html] as const)),
]

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doop-snap-'))
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

const blobs = () => db.select().from(t.snapshotBlobs).where(eq(t.snapshotBlobs.canvasId, 'dbs-c1'))

describe('persisted page snapshots', () => {
  it('stores unchanged frame html once across snapshots', async () => {
    await persist.savePageSnapshot(...snap('s1', 10, { 'dbs-f1': '<h1>One</h1>', 'dbs-f2': '<h1>Two</h1>' }))
    await persist.savePageSnapshot(...snap('s2', 20, { 'dbs-f1': '<h1>One</h1>', 'dbs-f2': '<h1>Two edited</h1>' }))
    expect(await blobs()).toHaveLength(3)
  })

  it('lists newest first, filtered by page, and reads one back by canvas', async () => {
    const listed = await persist.listPageSnapshots('dbs-c1', 'p1')
    expect(listed.map((s) => s.id)).toEqual(['s2', 's1'])
    expect(listed[0]!.frames.map((f) => f.frameId).sort()).toEqual(['dbs-f1', 'dbs-f2'])
    expect(await persist.listPageSnapshots('dbs-c1', 'other')).toEqual([])
    expect((await persist.getPageSnapshot('dbs-c1', 's1'))?.name).toBe('s1')
    expect(await persist.getPageSnapshot('another-canvas', 's1')).toBeUndefined()
  })

  it('reads snapshot html back by hash', async () => {
    const html = await persist.getSnapshotHtml('dbs-c1', [hashOf('<h1>One</h1>'), hashOf('<h1>Two edited</h1>')])
    expect(html.get(hashOf('<h1>One</h1>'))).toBe('<h1>One</h1>')
    expect(html.get(hashOf('<h1>Two edited</h1>'))).toBe('<h1>Two edited</h1>')
  })

  it('keeps snapshot html after the frame has more than 50 autosave versions', async () => {
    for (let i = 0; i < 60; i++) {
      const html = `<h1>prev ${i}</h1>`
      persist.saveFrameVersion({
        id: `dbs-v${i}`,
        frameId: 'dbs-f1',
        canvasId: 'dbs-c1',
        width: 640,
        height: 480,
        savedBy: 'seed',
        savedAt: 100 + i,
        htmlBytes: html.length,
        html,
      })
    }
    await persist.flush(() => undefined)
    const versions = await persist.listFrameVersions('dbs-f1')
    expect(versions).toHaveLength(50)
    const html = await persist.getSnapshotHtml('dbs-c1', [hashOf('<h1>One</h1>')])
    expect(html.get(hashOf('<h1>One</h1>'))).toBe('<h1>One</h1>')
  })

  it('deletes snapshots and blobs with the canvas', async () => {
    await persist.deleteCanvas('dbs-c1')
    await vi.waitFor(async () => expect(await blobs()).toHaveLength(0))
    expect(await persist.listPageSnapshots('dbs-c1')).toEqual([])
  })
})
