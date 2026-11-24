import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { afterAll, describe, expect, it, vi } from 'vitest'

/* CHE-9675 (A5 landing S1): persist.saveLanding writes the copied frames, their asset refs and one receipt in
   one transaction on a real database (temporary pglite). FP-02 is the REQUIRED_TEST of the CHE-9448 plan. */
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doop-landing-'))
const cwd = process.cwd()
process.chdir(dir)
const dbm = await import('../server/db/index.ts')
const t = await import('../server/db/schema.ts')
const persist = await import('../server/db/persist.ts')
await dbm.initDb()
process.chdir(cwd)
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

const pages = [
  { id: 'ledger', name: 'Ledger' },
  { id: 'src', name: 'Source' },
]
const canvas = (id: string, updatedAt = 100) => ({
  id,
  name: id,
  ownerId: 'u',
  createdAt: 1,
  updatedAt,
  pages,
  frames: [],
})
async function seed(id: string, updatedAt = 100) {
  await dbm.db.insert(t.canvases).values({ id, name: id, ownerId: 'u', pages, updatedAt, createdAt: 1 })
}
const frame = (canvasId: string, id: string, html = '<p>copy</p>') => ({
  id,
  canvasId,
  pageId: 'ledger',
  name: id,
  x: 0,
  y: 0,
  width: 10,
  height: 10,
  html,
  createdAt: 1,
  updatedAt: 1,
  updatedBy: 'landing',
  locked: true,
})
const receipt = (canvasId: string, over: Record<string, unknown> = {}) => ({
  id: `r-${canvasId}-${Math.random().toString(36).slice(2)}`,
  canvasId,
  mergeSha: 'a'.repeat(40),
  lockPath: 'design/x/approved/lock.json',
  repo: 'cheese-work/doop',
  pr: 39,
  sourcePageId: 'src',
  ledgerPageId: 'ledger',
  label: 'Lifecycle UI',
  topicIssueId: 'topic-1',
  closeDecisionId: 'dec-1',
  manifestSha256: 'b'.repeat(64),
  frames: [{ sourceFrameId: 's1', copyFrameId: 'c1', contentSha256: 'c'.repeat(64) }],
  payloadHash: 'd'.repeat(64),
  createdBy: 'landing',
  createdAt: 200,
  ...over,
})
const rows = async (canvasId: string) => ({
  frames: await dbm.db.select().from(t.frames).where(eq(t.frames.canvasId, canvasId)),
  receipts: await dbm.db.select().from(t.ledgerLandings).where(eq(t.ledgerLandings.canvasId, canvasId)),
  canvas: (await dbm.db.select().from(t.canvases).where(eq(t.canvases.id, canvasId)))[0]!,
})

describe('FP-02 (persist): saveLanding is all or nothing', () => {
  it('FP-02: a throw after the first frame insert leaves no frame, no receipt and updated_at unchanged', async () => {
    await seed('c-fp02', 100)
    const copies = [frame('c-fp02', 'f1'), frame('c-fp02', 'f2')] as never
    const rec = receipt('c-fp02') as never
    await expect(
      persist.saveLanding('c-fp02', 500, copies, rec, {
        afterFirstFrame: () => {
          throw new Error('db down after first copy')
        },
      }),
    ).rejects.toThrow(/db down/)
    const after = await rows('c-fp02')
    expect(after.frames).toHaveLength(0)
    expect(after.receipts).toHaveLength(0)
    expect(after.canvas.updatedAt).toBe(100)
    expect(await persist.findLanding('c-fp02', 'a'.repeat(40), 'design/x/approved/lock.json')).toBeUndefined()

    // a retry creates exactly one set
    await persist.saveLanding('c-fp02', 500, copies, rec, {})
    const retried = await rows('c-fp02')
    expect(retried.frames.map((f) => f.id).sort()).toEqual(['f1', 'f2'])
    expect(retried.receipts).toHaveLength(1)
    expect(retried.canvas.updatedAt).toBe(500)
  })

  it('a throw from beforeCommit also rolls everything back', async () => {
    await seed('c-before', 100)
    await expect(
      persist.saveLanding('c-before', 500, [frame('c-before', 'g1')] as never, receipt('c-before') as never, {
        beforeCommit: () => {
          throw new Error('refused at commit')
        },
      }),
    ).rejects.toThrow(/refused/)
    const after = await rows('c-before')
    expect([after.frames.length, after.receipts.length, after.canvas.updatedAt]).toEqual([0, 0, 100])
  })
})

describe('saveLanding: the receipt and the copies', () => {
  it('a duplicate (canvas, merge sha, lock path) fails on the primary key and writes nothing more', async () => {
    await seed('c-dup')
    await persist.saveLanding('c-dup', 500, [frame('c-dup', 'd1')] as never, receipt('c-dup') as never, {})
    const err = await persist
      .saveLanding('c-dup', 600, [frame('c-dup', 'd2')] as never, receipt('c-dup') as never, {})
      .then(
        () => undefined,
        (e: Error & { cause?: Error }) => e,
      )
    // drizzle wraps the driver error; the cause names the violated primary key
    expect(String(err?.cause?.message ?? err?.message)).toMatch(/ledger_landings_canvas_id_merge_sha_lock_path_pk/)
    const after = await rows('c-dup')
    expect(after.frames.map((f) => f.id)).toEqual(['d1'])
    expect(after.receipts).toHaveLength(1)
    expect(after.canvas.updatedAt).toBe(500)
  })

  it('inserted copies reload with locked = true, with their asset refs', async () => {
    await seed('c-lock')
    const withAsset = frame('c-lock', 'l1', '<img src="/a/ast_abc123.png">')
    await persist.saveLanding('c-lock', 500, [withAsset] as never, receipt('c-lock') as never, {})
    const after = await rows('c-lock')
    expect(after.frames[0]).toMatchObject({ id: 'l1', locked: true, html: withAsset.html })
    const loaded = (await persist.hydrate()).canvases.find((c) => c.id === 'c-lock')!
    expect(loaded.frames.find((f) => f.id === 'l1')).toMatchObject({ locked: true })
    const refs = await dbm.db.select().from(t.assetRefs).where(eq(t.assetRefs.frameId, 'l1'))
    expect(refs).toEqual([{ assetId: 'ast_abc123', frameId: 'l1' }])
  })

  it('a saveCanvas of other pages committed during the open transaction survives with its pages', async () => {
    await seed('c-over', 100)
    const saved = { ...canvas('c-over', 400), pages: [...pages, { id: 'new', name: 'Added meanwhile' }] }
    await persist.saveLanding('c-over', 300, [frame('c-over', 'o1')] as never, receipt('c-over') as never, {
      beforeCommit: () => {
        /* the page-list save is queued behind the landing's transaction; it must not be lost */
        persist.saveCanvas(saved as never)
      },
    })
    await vi.waitFor(async () => {
      const { canvas: row } = await rows('c-over')
      expect((row.pages as { id: string }[]).map((p) => p.id)).toContain('new')
    })
    const after = await rows('c-over')
    expect(after.frames.map((f) => f.id)).toEqual(['o1'])
    expect(after.receipts).toHaveLength(1)
    expect(after.canvas.updatedAt).toBeGreaterThanOrEqual(400)
  })

  it('updated_at never moves backwards (GREATEST)', async () => {
    await seed('c-greatest', 900)
    await persist.saveLanding(
      'c-greatest',
      500,
      [frame('c-greatest', 'x1')] as never,
      receipt('c-greatest') as never,
      {},
    )
    expect((await rows('c-greatest')).canvas.updatedAt).toBe(900)
  })
})

describe('findLanding and landingsFor', () => {
  it('finds one receipt by key and lists a canvas newest first', async () => {
    await seed('c-find')
    const mk = (sha: string, createdAt: number, fid: string) =>
      persist.saveLanding(
        'c-find',
        createdAt,
        [frame('c-find', fid)] as never,
        receipt('c-find', {
          mergeSha: sha.repeat(40),
          createdAt,
          frames: [{ sourceFrameId: 's', copyFrameId: fid, contentSha256: 'e'.repeat(64) }],
        }) as never,
        {},
      )
    await mk('1', 10, 'n1')
    await mk('2', 30, 'n3')
    await mk('3', 20, 'n2')
    const one = await persist.findLanding('c-find', '2'.repeat(40), 'design/x/approved/lock.json')
    expect(one).toMatchObject({ canvasId: 'c-find', mergeSha: '2'.repeat(40), pr: 39, label: 'Lifecycle UI' })
    expect(one!.frames).toEqual([{ sourceFrameId: 's', copyFrameId: 'n3', contentSha256: 'e'.repeat(64) }])
    expect((await persist.landingsFor('c-find')).map((r) => r.createdAt)).toEqual([30, 20, 10])
    expect(await persist.findLanding('c-find', '9'.repeat(40), 'design/x/approved/lock.json')).toBeUndefined()
    expect(await persist.landingsFor('c-none')).toEqual([])
  })
})
