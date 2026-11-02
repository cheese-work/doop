import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { stubEnv, unstubAllEnvs } from './envStub.ts'
import type { Canvas } from '../shared/types.ts'

/* Real PostgreSQL: a comment anchored by a positional selector before element
 * ids, and so old that a restart leaves it outside the 100-comment window.
 * Set DOOP_TEST_PG_URL to an empty database to run; skipped otherwise. Run with
 * --no-file-parallelism next to the other *Pg tests: they share the tables. */
const PG_URL = process.env.DOOP_TEST_PG_URL

vi.mock('../server/resident.ts', () => ({ onFeedback: () => {} }))
vi.mock('../server/distill.ts', () => ({ onDecision: () => {} }))

const CANVAS: Canvas = {
  id: 'pg-legacy',
  name: 'Legacy',
  ownerId: 'alice',
  createdAt: 0,
  updatedAt: 0,
  pages: [{ id: 'p1', name: 'Home' }],
  frames: [
    {
      id: 'pg-legacy-frame',
      canvasId: 'pg-legacy',
      pageId: 'p1',
      name: 'Hero',
      html: '<h1>Hi</h1><p>One</p>',
      x: 0,
      y: 0,
      width: 640,
      height: 480,
      createdAt: 0,
      updatedAt: 0,
      updatedBy: 'alice',
    },
  ],
}
const FRAME_ID = CANVAS.frames[0]!.id

describe.skipIf(!PG_URL)('a legacy comment older than the window, across a restart, on PostgreSQL', () => {
  let pool: pg.Pool
  let persist: typeof import('../server/db/persist.ts')
  let actions: typeof import('../server/actions.ts')
  let store: typeof import('../server/store.ts').store

  beforeAll(async () => {
    stubEnv('DATABASE_URL', PG_URL)
    pool = new pg.Pool({ connectionString: PG_URL })
    await (await import('../server/db/index.ts')).initDb()
    persist = await import('../server/db/persist.ts')
    actions = await import('../server/actions.ts')
    store = (await import('../server/store.ts')).store
  })

  /* before each test: the old comment still carries its selector, 100 newer ones push it out of the window */
  beforeEach(async () => {
    vi.restoreAllMocks()
    await pool.query('drop trigger if exists slow_stale_resolve on comments')
    for (const table of ['comment_events', 'comments', 'frames', 'canvases']) await pool.query(`delete from ${table}`)
    await persist.saveCanvasCopy(CANVAS)
    const insert = `insert into comments (id, canvas_id, frame_id, element_id, selector, snippet, from_name, text, at)
      values ($1, $2, $3, $4, $5, '<p>', 'alice', $1, $6)`
    await pool.query(insert, ['legacy-old', CANVAS.id, FRAME_ID, null, 'body > p:nth-of-type(1)', 1])
    for (let i = 0; i < 100; i++) await pool.query(insert, [`newer-${i}`, CANVAS.id, FRAME_ID, 'abc123', null, 2 + i])
  })

  afterAll(async () => {
    await pool?.end()
    unstubAllEnvs()
  })

  it('is backfilled from its row, so resolving it afterwards keeps the anchor', async () => {
    const data = await persist.hydrate()
    expect(data.comments.get(CANVAS.id)).toHaveLength(100)
    expect(data.comments.get(CANVAS.id)!.some((c) => c.id === 'legacy-old')).toBe(false)
    expect(data.legacyCommentSelectors.get('legacy-old')).toBe('body > p:nth-of-type(1)')

    store.init(data.canvases)
    actions.wire(
      () => {},
      () => {},
    )
    actions.hydrateLogs(data)
    expect(await actions.backfillElementIds(data.legacyCommentSelectors)).toEqual({ stamped: 1, lost: 0, failed: 0 })

    const { rows } = await pool.query('select element_id, selector from comments where id = $1', ['legacy-old'])
    expect(rows[0].element_id).toMatch(/^[a-z0-9]{6}$/)
    expect(rows[0].selector).toBeNull()

    /* restored from its row, the thread replies and resolves on that element */
    const reply = await actions.replyToComment('legacy-old', 'still here', 'bob', 'u2')
    expect(reply?.elementId).toBe(rows[0].element_id)
    expect((await actions.resolveComment('legacy-old', 'bob'))?.elementId).toBe(rows[0].element_id)
    await vi.waitFor(async () => {
      const after = await pool.query('select element_id, resolved_by from comments where id = $1', ['legacy-old'])
      expect(after.rows[0]).toEqual({ element_id: rows[0].element_id, resolved_by: 'bob' })
    })
  })

  it('keeps the anchor when a resolve restores the thread while the frame is being written', async () => {
    const data = await persist.hydrate()
    store.init(data.canvases)
    actions.wire(
      () => {},
      () => {},
    )
    actions.hydrateLogs(data)
    /* hold the frame write: the backfill has stamped the frame in memory and waits on the disk */
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const write = persist.saveFrameNow
    const held = vi.spyOn(persist, 'saveFrameNow').mockImplementation(async (frame) => {
      await gate
      return write(frame)
    })
    /* and hold the resolve's own write (the copy without the id) before it reaches the row, so the backfill writes first */
    await pool.query(`create or replace function slow_stale_resolve() returns trigger language plpgsql as $$
      begin perform pg_sleep(0.6); return new; end $$`)
    await pool.query(`create trigger slow_stale_resolve before insert on comments for each row
      when (new.element_id is null and new.resolved_by is not null) execute function slow_stale_resolve()`)
    const backfill = actions.backfillElementIds(data.legacyCommentSelectors)
    await vi.waitFor(() => expect(held).toHaveBeenCalled())

    expect((await actions.resolveComment('legacy-old', 'bob'))?.resolvedBy).toBe('bob')
    release()
    expect(await backfill).toEqual({ stamped: 1, lost: 0, failed: 0 })

    /* let the held write finish: it must not have undone the id */
    await new Promise((resolve) => setTimeout(resolve, 1000))
    const { rows } = await pool.query('select element_id, resolved_by from comments where id = $1', ['legacy-old'])
    expect(rows[0].resolved_by).toBe('bob')
    expect(rows[0].element_id).toMatch(/^[a-z0-9]{6}$/)
  })
})
