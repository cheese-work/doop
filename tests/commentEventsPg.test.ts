import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { stubEnv, unstubAllEnvs } from './envStub.ts'
import type { Canvas, Frame } from '../shared/types.ts'

/* Real PostgreSQL: the outbox guarantees (one transaction, late commits stay
 * visible) are properties of the database, so PGlite and mocks cannot show
 * them. Set DOOP_TEST_PG_URL to an empty database to run; skipped otherwise. */
const PG_URL = process.env.DOOP_TEST_PG_URL

vi.mock('../server/resident.ts', () => ({ onFeedback: () => {} }))
vi.mock('../server/distill.ts', () => ({ onDecision: () => {} }))

const CANVAS: Canvas = {
  id: 'pg-canvas',
  name: 'Outbox',
  ownerId: 'owner-1',
  createdAt: 0,
  updatedAt: 0,
  frames: [],
}
const FRAME: Frame = {
  id: 'pg-frame',
  canvasId: CANVAS.id,
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

describe.skipIf(!PG_URL)('comment events on PostgreSQL', () => {
  let actions: typeof import('../server/actions.ts')
  let persist: typeof import('../server/db/persist.ts')
  let store: typeof import('../server/store.ts').store
  let buildMcpServer: typeof import('../server/mcp.ts').buildMcpServer
  let pool: pg.Pool

  beforeAll(async () => {
    stubEnv('DATABASE_URL', PG_URL)
    pool = new pg.Pool({ connectionString: PG_URL })
    await (await import('../server/db/index.ts')).initDb()
    actions = await import('../server/actions.ts')
    persist = await import('../server/db/persist.ts')
    store = (await import('../server/store.ts')).store
    buildMcpServer = (await import('../server/mcp.ts')).buildMcpServer
  })

  afterAll(async () => {
    await pool?.end()
    unstubAllEnvs()
  })

  beforeEach(async () => {
    vi.restoreAllMocks()
    await pool.query('drop trigger if exists fail_event on comment_events')
    await pool.query('delete from comment_events')
    await pool.query('delete from comments')
    actions.wire(
      () => {},
      () => {},
    )
    actions.hydrateLogs({
      tasks: new Map(),
      feedback: new Map(),
      comments: new Map([[CANVAS.id, []]]),
      activity: new Map(),
      decisions: new Map(),
      proposals: new Map(),
    })
    vi.spyOn(store, 'getFrame').mockImplementation((id) => (id === FRAME.id ? FRAME : undefined))
    vi.spyOn(store, 'getCanvas').mockImplementation((id) => (id === CANVAS.id ? CANVAS : undefined))
    vi.spyOn(actions, 'heartbeatAgent').mockImplementation(() => {})
  })

  const post = (text: string, from = 'alice') =>
    actions.addElementComment(FRAME.id, { selector: 'h1', snippet: '<h1>Hi</h1>', text }, from, 'user-1')

  async function connect() {
    const server = buildMcpServer('Owner', CANVAS.ownerId)
    const client = new Client({ name: 'comment-events-test', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    return client
  }

  async function callJson(client: Client, name: string, args: Record<string, unknown>) {
    const result = (await client.callTool({ name, arguments: args })) as unknown as {
      content: Array<{ type: string; text?: string }>
    }
    return JSON.parse(result.content.map((c) => c.text ?? '').join('')) as unknown
  }

  it('stores the comment and one event together', async () => {
    const comment = (await post('Make it bigger'))!
    const events = await persist.listUnackedCommentEvents(CANVAS.id, 10)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      canvasId: CANVAS.id,
      commentId: comment.id,
      parentId: null,
      fromUserId: 'user-1',
      at: comment.at,
    })
    expect(events[0]!.comment).toMatchObject({ id: comment.id, text: 'Make it bigger', from: 'alice' })
  })

  it('records the thread link on a reply event', async () => {
    const root = (await post('Root'))!
    const reply = (await actions.replyToComment(root.id, 'Reply', 'bob', 'user-2'))!
    const events = await persist.listUnackedCommentEvents(CANVAS.id, 10)
    expect(events.map((e) => e.commentId)).toEqual([root.id, reply.id])
    expect(events[1]!.parentId).toBe(root.id)
  })

  it('stores nothing and fails the request when the event cannot be written', async () => {
    await pool.query(`create or replace function fail_event() returns trigger language plpgsql as $$
      begin raise exception 'forced event failure'; end $$`)
    await pool.query(
      'create trigger fail_event before insert on comment_events for each row execute function fail_event()',
    )

    await expect(post('Will not land')).rejects.toThrow()

    expect((await pool.query('select count(*)::int as n from comments')).rows[0].n).toBe(0)
    expect((await pool.query('select count(*)::int as n from comment_events')).rows[0].n).toBe(0)
    expect(actions.getComments(CANVAS.id)).toEqual([])
  })

  it('stops listing an event once it is acknowledged', async () => {
    await post('one')
    await post('two')
    const [first, second] = await persist.listUnackedCommentEvents(CANVAS.id, 10)

    expect(await persist.ackCommentEvents([first!.id], () => true)).toEqual([first!.id])
    expect((await persist.listUnackedCommentEvents(CANVAS.id, 10)).map((e) => e.id)).toEqual([second!.id])
    /* acking again is harmless */
    expect(await persist.ackCommentEvents([first!.id], () => true)).toEqual([first!.id])
  })

  it('does not acknowledge events on a canvas the caller cannot reach', async () => {
    await post('one')
    const [event] = await persist.listUnackedCommentEvents(CANVAS.id, 10)
    expect(await persist.ackCommentEvents([event!.id], () => false)).toEqual([])
    expect(await persist.listUnackedCommentEvents(CANVAS.id, 10)).toHaveLength(1)
  })

  it('still returns an event that commits after a higher id was read and acknowledged', async () => {
    const slow = await pool.connect()
    try {
      await slow.query('begin')
      await slow.query(
        `insert into comments (id, canvas_id, selector, snippet, from_name, text, at) values ('slow', $1, '', '', 'a', 'slow', 1)`,
        [CANVAS.id],
      )
      await slow.query(`insert into comment_events (canvas_id, comment_id, at) values ($1, 'slow', 1)`, [CANVAS.id])

      /* a later transaction takes a higher id and commits first */
      const fast = (await post('fast'))!
      const seen = await persist.listUnackedCommentEvents(CANVAS.id, 10)
      expect(seen.map((e) => e.commentId)).toEqual([fast.id])
      await persist.ackCommentEvents(
        seen.map((e) => e.id),
        () => true,
      )

      await slow.query('commit')
      const late = await persist.listUnackedCommentEvents(CANVAS.id, 10)
      expect(late.map((e) => e.commentId)).toEqual(['slow'])
    } finally {
      slow.release()
    }
  })

  it('honours the limit and orders by event id', async () => {
    for (const t of ['a', 'b', 'c']) await post(t)
    const events = await persist.listUnackedCommentEvents(CANVAS.id, 2)
    expect(events.map((e) => e.comment.text)).toEqual(['a', 'b'])
  })

  it('exposes list and ack as MCP tools', async () => {
    await post('over MCP')
    const client = await connect()
    try {
      const { tools } = await client.listTools()
      expect(tools.map((t) => t.name)).toEqual(
        expect.arrayContaining(['list_unacked_comment_events', 'ack_comment_events']),
      )

      const listed = (await callJson(client, 'list_unacked_comment_events', {
        canvas_id: CANVAS.id,
        limit: 10,
      })) as Array<{
        id: number
        comment: { text: string }
      }>
      expect(listed.map((e) => e.comment.text)).toEqual(['over MCP'])

      const acked = await callJson(client, 'ack_comment_events', { ids: [listed[0]!.id] })
      expect(acked).toEqual({ acked: [listed[0]!.id] })
      expect(await callJson(client, 'list_unacked_comment_events', { canvas_id: CANVAS.id, limit: 10 })).toEqual([])
    } finally {
      await client.close()
    }
  })
})
