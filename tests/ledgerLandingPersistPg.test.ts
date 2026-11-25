import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { stubEnv, unstubAllEnvs } from './envStub.ts'
import type { Canvas, Frame } from '../shared/types.ts'

/* CHE-9675 (A5 landing S1): a page-list save that commits while a landing transaction is open. It needs two real
   connections, which PGlite (one session) cannot give, so it runs on PostgreSQL: set DOOP_TEST_PG_URL to an empty
   database; skipped otherwise (as frameWriteKeysPg.test.ts). */
const PG_URL = process.env.DOOP_TEST_PG_URL

const pages = [
  { id: 'ledger', name: 'Ledger' },
  { id: 'src', name: 'Source' },
]
const frame = (canvasId: string, id: string): Frame => ({
  id,
  canvasId,
  pageId: 'ledger',
  name: id,
  x: 0,
  y: 0,
  width: 10,
  height: 10,
  html: '<p>copy</p>',
  createdAt: 1,
  updatedAt: 1,
  updatedBy: 'landing',
  locked: true,
})
const receipt = (canvasId: string, mergeSha: string) => ({
  id: `r-${canvasId}`,
  canvasId,
  mergeSha,
  lockPath: 'design/x/approved/lock.json',
  repo: 'cheese-work/doop',
  pr: 39,
  sourcePageId: 'src',
  ledgerPageId: 'ledger',
  label: 'Lifecycle UI',
  topicIssueId: 'topic-1',
  closeDecisionId: 'dec-1',
  manifestSha256: 'b'.repeat(64),
  frames: [{ sourceFrameId: 's1', copyFrameId: `${canvasId}-copy`, contentSha256: 'c'.repeat(64) }],
  payloadHash: 'd'.repeat(64),
  createdBy: 'landing',
  createdAt: 200,
})
const added = { id: 'added', name: 'Added by a page save' }

describe.skipIf(!PG_URL)('saveLanding with overlapping page saves on PostgreSQL', () => {
  let persist: typeof import('../server/db/persist.ts')
  let pool: pg.Pool

  beforeAll(async () => {
    stubEnv('DATABASE_URL', PG_URL)
    pool = new pg.Pool({ connectionString: PG_URL })
    await (await import('../server/db/index.ts')).initDb()
    persist = await import('../server/db/persist.ts')
  })
  afterAll(async () => {
    await pool?.end()
    unstubAllEnvs()
  })

  const seed = async (id: string, updatedAt: number) => {
    // a rerun against the same database starts clean
    for (const table of ['ledger_landings', 'frames'])
      await pool.query(`delete from ${table} where canvas_id = $1`, [id])
    await pool.query('delete from canvases where id = $1', [id])
    await persist.saveCanvasCopy({ id, name: id, ownerId: 'u', createdAt: 1, updatedAt, pages, frames: [] } as Canvas)
  }
  const savePages = (id: string, updatedAt: number) =>
    persist.saveCanvas({
      id,
      name: id,
      ownerId: 'u',
      createdAt: 1,
      updatedAt,
      pages: [...pages, added],
      frames: [],
    } as Canvas)
  const canvasRow = async (id: string) =>
    (await pool.query('select pages, updated_at from canvases where id = $1', [id])).rows[0] as {
      pages: { id: string }[]
      updated_at: string
    }
  const count = async (table: string, canvasId: string) =>
    Number((await pool.query(`select count(*) from ${table} where canvas_id = $1`, [canvasId])).rows[0].count)
  const deferred = () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    return { gate, release }
  }

  it('a page save committed while the landing is open (before its canvas update) survives; updated_at is the later of the two', async () => {
    await seed('pg-during', 100)
    const open = deferred()
    const reached = deferred()
    const landing = persist.saveLanding(
      'pg-during',
      300,
      [frame('pg-during', 'pg-during-copy')],
      receipt('pg-during', 'a'.repeat(40)) as never,
      {
        afterFirstFrame: async () => {
          reached.release()
          await open.gate
        },
      },
    )
    await reached.gate
    // the landing transaction holds an inserted copy and is not committed: a second connection commits the page save
    expect(await count('frames', 'pg-during')).toBe(0)
    savePages('pg-during', 400)
    await vi.waitFor(async () => expect((await canvasRow('pg-during')).pages.map((p) => p.id)).toContain('added'))
    expect(await count('frames', 'pg-during')).toBe(0) // still uncommitted
    open.release()
    await landing

    const row = await canvasRow('pg-during')
    expect(row.pages.map((p) => p.id)).toEqual(['ledger', 'src', 'added'])
    expect(Number(row.updated_at)).toBe(400) // GREATEST(400, 300): the landing did not move it back
    expect(await count('frames', 'pg-during')).toBe(1)
    expect(await count('ledger_landings', 'pg-during')).toBe(1)
    const reloaded = (await persist.hydrate()).canvases.find((c) => c.id === 'pg-during')!
    expect(reloaded.pages?.map((p) => p.id)).toContain('added')
    expect(reloaded.frames.map((f) => f.id)).toEqual(['pg-during-copy'])
    expect(reloaded.frames[0]).toMatchObject({ locked: true })
  })

  it('a page save issued after the landing updated the canvas row waits for the commit, then lands on top', async () => {
    await seed('pg-held', 100)
    const open = deferred()
    const reached = deferred()
    const landing = persist.saveLanding(
      'pg-held',
      500,
      [frame('pg-held', 'pg-held-copy')],
      receipt('pg-held', 'b'.repeat(40)) as never,
      {
        beforeCommit: async () => {
          reached.release()
          await open.gate
        },
      },
    )
    await reached.gate
    savePages('pg-held', 400)
    await new Promise((r) => setTimeout(r, 300))
    expect((await canvasRow('pg-held')).pages.map((p) => p.id)).toEqual(['ledger', 'src']) // blocked on the row lock
    open.release()
    await landing
    await vi.waitFor(async () => expect((await canvasRow('pg-held')).pages.map((p) => p.id)).toContain('added'))

    expect(await count('frames', 'pg-held')).toBe(1)
    expect(await count('ledger_landings', 'pg-held')).toBe(1)
    expect(Number((await canvasRow('pg-held')).updated_at)).toBeGreaterThanOrEqual(400)
  })

  it('a page save committed after the landing keeps the copies and the receipt', async () => {
    await seed('pg-after', 100)
    await persist.saveLanding(
      'pg-after',
      300,
      [frame('pg-after', 'pg-after-copy')],
      receipt('pg-after', 'c'.repeat(40)) as never,
      {},
    )
    savePages('pg-after', 400)
    await vi.waitFor(async () => expect((await canvasRow('pg-after')).pages.map((p) => p.id)).toContain('added'))
    expect(await count('frames', 'pg-after')).toBe(1)
    expect(await count('ledger_landings', 'pg-after')).toBe(1)
    expect(Number((await canvasRow('pg-after')).updated_at)).toBe(400)
  })
})
