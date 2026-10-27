import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { stubEnv, unstubAllEnvs } from './envStub.ts'
import type { Frame } from '../shared/types.ts'

/* Real PostgreSQL: the fallback reads the persisted comment row, so the
 * in-memory window (100 entries per canvas) and the table must disagree for
 * the test to mean anything. Set DOOP_TEST_PG_URL to an empty database to run;
 * skipped otherwise. Run with --no-file-parallelism next to commentEventsPg.test.ts: both
 * files empty the same tables. */
const PG_URL = process.env.DOOP_TEST_PG_URL

vi.mock('../server/resident.ts', () => ({ onFeedback: () => {} }))
vi.mock('../server/distill.ts', () => ({ onDecision: () => {} }))

const CANVAS_ID = 'pg-fallback'
const FRAME: Frame = {
  id: 'pg-fallback-frame',
  canvasId: CANVAS_ID,
  name: 'Hero',
  html: '<h1>Hi</h1>',
  x: 0,
  y: 0,
  width: 640,
  height: 480,
  createdAt: 0,
  updatedAt: 0,
  updatedBy: 'alice',
}
const WINDOW = 100

describe.skipIf(!PG_URL)('comments outside the memory window, on PostgreSQL', () => {
  let actions: typeof import('../server/actions.ts')
  let store: typeof import('../server/store.ts').store
  let pool: pg.Pool
  let broadcasts: Array<{ type: string; comment?: { id: string } }>

  beforeAll(async () => {
    stubEnv('DATABASE_URL', PG_URL)
    pool = new pg.Pool({ connectionString: PG_URL })
    await (await import('../server/db/index.ts')).initDb()
    actions = await import('../server/actions.ts')
    store = (await import('../server/store.ts')).store
  })

  afterAll(async () => {
    await pool?.end()
    unstubAllEnvs()
  })

  beforeEach(async () => {
    vi.restoreAllMocks()
    await pool.query('delete from comment_events')
    await pool.query('delete from comments')
    broadcasts = []
    actions.wire(
      (_canvasId, message) => broadcasts.push(message as (typeof broadcasts)[number]),
      () => {},
    )
    actions.hydrateLogs({
      tasks: new Map(),
      feedback: new Map(),
      comments: new Map([[CANVAS_ID, []]]),
      activity: new Map(),
      decisions: new Map(),
      proposals: new Map(),
    })
    vi.spyOn(store, 'getFrame').mockImplementation((id) => (id === FRAME.id ? FRAME : undefined))
  })

  const post = async (text: string) => {
    const c = await actions.addElementComment(FRAME.id, { selector: 'h1', snippet: '<h1>Hi</h1>', text }, 'alice', 'u1')
    if (!c) throw new Error('seed comment was refused')
    return c
  }

  /** `n` more comments, so everything older than the newest 100 leaves memory. */
  const fill = async (n: number) => {
    for (let i = 0; i < n; i++) await post(`filler ${i}`)
  }

  /** The row write behind a resolve is fire-and-forget, so poll until it lands. */
  const expectResolvedBy = (ids: string[], expected: Record<string, string | null>) =>
    vi.waitFor(async () => {
      const { rows } = await pool.query('select id, resolved_by from comments where id = any($1)', [ids])
      expect(Object.fromEntries(rows.map((r) => [r.id, r.resolved_by]))).toEqual(expected)
    })

  const inMemory = (id: string) => actions.getComments(CANVAS_ID).some((c) => c.id === id)

  it('keeps the window at 100, so the oldest root really is gone from memory', async () => {
    const root = await post('root')
    await fill(WINDOW)
    expect(actions.getComments(CANVAS_ID)).toHaveLength(WINDOW)
    expect(inMemory(root.id)).toBe(false)
  })

  it('finds an evicted comment from its stored row', async () => {
    const root = await post('root')
    await fill(WINDOW)
    expect(await actions.findComment(root.id)).toMatchObject({ id: root.id, canvasId: CANVAS_ID, text: 'root' })
    expect(await actions.findComment('missing')).toBeUndefined()
  })

  it('opens the thread of an evicted root', async () => {
    const root = await post('root')
    await fill(WINDOW)
    const open = await actions.openThread(root.id)
    expect(open?.root.id).toBe(root.id)
    expect(open?.frame?.id).toBe(FRAME.id)
  })

  it('replies to the oldest of 150 comments and shows root and reply', async () => {
    const root = await post('oldest')
    await fill(149)
    expect(inMemory(root.id)).toBe(false)

    const reply = await actions.replyToComment(root.id, 'still here', 'bob', 'u2')

    expect(reply).toMatchObject({ parentId: root.id, text: 'still here' })
    const shown = actions.getComments(CANVAS_ID)
    expect(shown.map((c) => c.id)).toEqual(expect.arrayContaining([root.id, reply!.id]))
    expect(shown.length).toBeLessThanOrEqual(WINDOW)
    expect(actions.commentThread(reply!).map((c) => c.id)).toEqual([root.id, reply!.id])
    /* a client already on the canvas is told about the root again, then the reply */
    expect(broadcasts.filter((b) => b.type === 'comment').map((b) => b.comment?.id)).toEqual(
      expect.arrayContaining([root.id, reply!.id]),
    )
  })

  it('pulls earlier replies back with the root', async () => {
    const root = await post('root')
    const first = (await actions.replyToComment(root.id, 'first', 'bob', 'u2'))!
    await fill(WINDOW)
    expect(inMemory(root.id) || inMemory(first.id)).toBe(false)

    const second = (await actions.replyToComment(root.id, 'second', 'bob', 'u2'))!

    expect(actions.commentThread(second).map((c) => c.id)).toEqual([root.id, first.id, second.id])
  })

  it('resolves an evicted thread and stores it as resolved', async () => {
    const root = await post('root')
    const reply = (await actions.replyToComment(root.id, 'reply', 'bob', 'u2'))!
    await fill(WINDOW)

    const resolved = await actions.resolveComment(root.id, 'alice')

    expect(resolved?.resolvedBy).toBe('alice')
    await expectResolvedBy([root.id, reply.id], { [root.id]: 'alice', [reply.id]: 'alice' })
  })

  it('resolves an evicted reply without closing its root', async () => {
    const root = await post('root')
    const reply = (await actions.replyToComment(root.id, 'reply', 'bob', 'u2'))!
    await fill(WINDOW)

    expect((await actions.resolveComment(reply.id, 'alice'))?.id).toBe(reply.id)

    await expectResolvedBy([root.id, reply.id], { [root.id]: null, [reply.id]: 'alice' })
  })

  it('refuses a reply to a resolved evicted thread', async () => {
    const root = await post('root')
    await actions.resolveComment(root.id, 'alice')
    await fill(WINDOW)
    expect(await actions.openThread(root.id)).toBeUndefined()
    expect(await actions.replyToComment(root.id, 'late', 'bob', 'u2')).toBeUndefined()
  })
})
