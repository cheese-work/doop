import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { stubEnv, unstubAllEnvs } from './envStub.ts'
import type { Canvas, ElementComment, Frame } from '../shared/types.ts'

/* Real PostgreSQL: destination-enforced idempotency is a property of the
 * unique index and the insert transaction, so mocks cannot show it. Set
 * DOOP_TEST_PG_URL to an empty database to run; skipped otherwise. */
const PG_URL = process.env.DOOP_TEST_PG_URL

vi.mock('../server/resident.ts', () => ({ onFeedback: () => {} }))
vi.mock('../server/distill.ts', () => ({ onDecision: () => {} }))

const CANVAS: Canvas = {
  id: 'idem-canvas',
  name: 'Idempotency',
  ownerId: 'owner-1',
  createdAt: 0,
  updatedAt: 0,
  frames: [],
}
const FRAME: Frame = {
  id: 'idem-frame',
  canvasId: CANVAS.id,
  name: 'Hero',
  html: '<h1 data-doop-id="abc123">Hi</h1>',
  x: 0,
  y: 0,
  width: 640,
  height: 480,
  createdAt: 0,
  updatedAt: 0,
  updatedBy: 'alice',
}

describe.skipIf(!PG_URL)('reply idempotency on PostgreSQL', () => {
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

  const emptyLogs = () =>
    actions.hydrateLogs({
      tasks: new Map(),
      feedback: new Map(),
      comments: new Map([[CANVAS.id, []]]),
      activity: new Map(),
      decisions: new Map(),
      proposals: new Map(),
    })

  beforeEach(async () => {
    vi.restoreAllMocks()
    await pool.query('delete from comment_events')
    await pool.query('delete from comments')
    actions.wire(
      () => {},
      () => {},
    )
    emptyLogs()
    vi.spyOn(store, 'getFrame').mockImplementation((id) => (id === FRAME.id ? FRAME : undefined))
    vi.spyOn(store, 'getCanvas').mockImplementation((id) => (id === CANVAS.id ? CANVAS : undefined))
    vi.spyOn(actions, 'heartbeatAgent').mockImplementation(() => {})
  })

  const post = (text: string) =>
    actions.addElementComment(
      FRAME.id,
      { selector: 'h1', elementId: 'abc123', snippet: '<h1>Hi</h1>', text },
      'alice',
      'user-1',
    )
  const reply = (rootId: string, text: string, key?: string) =>
    actions.replyToComment(rootId, text, 'bob', 'user-2', 'user', key)
  const count = async () => (await pool.query('select count(*)::int as n from comments')).rows[0].n as number
  const events = async () => (await pool.query('select count(*)::int as n from comment_events')).rows[0].n as number

  async function connect() {
    const server = buildMcpServer('Owner', CANVAS.ownerId)
    const client = new Client({ name: 'idempotency-test', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    return client
  }

  it('same key and same text twice gives one comment, the same id and replay: true', async () => {
    const root = (await post('Root'))!
    const first = (await reply(root.id, 'Done', 'req-1'))!
    const again = (await reply(root.id, 'Done', 'req-1'))!
    expect(again.id).toBe(first.id)
    expect(again).toMatchObject({ replay: true })
    expect(first).not.toHaveProperty('replay')
    expect(await count()).toBe(2)
    expect(await events()).toBe(2)
    expect(actions.getComments(CANVAS.id)).toHaveLength(2)
  })

  it('same key and different text is a conflict that leaves the first reply unchanged', async () => {
    const root = (await post('Root'))!
    const first = (await reply(root.id, 'Done', 'req-1'))!
    await expect(reply(root.id, 'Something else', 'req-1')).rejects.toBeInstanceOf(actions.ClientRequestConflictError)
    expect(await count()).toBe(2)
    expect((await persist.findCommentRow(first.id))!.text).toBe('Done')
  })

  it('two concurrent calls with one key and the same text give one comment', async () => {
    const root = (await post('Root'))!
    const [a, b] = await Promise.all([reply(root.id, 'Done', 'req-1'), reply(root.id, 'Done', 'req-1')])
    expect(a!.id).toBe(b!.id)
    expect([a, b].filter((c) => (c as { replay?: boolean }).replay)).toHaveLength(1)
    expect(await count()).toBe(2)
  })

  it('two concurrent calls with one key and different text give one comment and one conflict', async () => {
    const root = (await post('Root'))!
    const results = await Promise.allSettled([reply(root.id, 'One', 'req-1'), reply(root.id, 'Two', 'req-1')])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.filter((r) => r.status === 'rejected')
    expect(rejected).toHaveLength(1)
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(actions.ClientRequestConflictError)
    expect(await count()).toBe(2)
  })

  it('the store itself arbitrates when two writers race past the thread lock', async () => {
    const root = (await post('Root'))!
    const mk = (id: string, text: string): ElementComment => ({
      ...root,
      id,
      text,
      parentId: root.id,
      at: root.at + 1,
      clientRequestId: 'req-1',
    })
    const sameText = await Promise.allSettled([
      persist.saveNewComment(mk('r1', 'Done')),
      persist.saveNewComment(mk('r2', 'Done')),
    ])
    expect(sameText.every((r) => r.status === 'fulfilled')).toBe(true)
    expect(sameText.map((r) => (r as PromiseFulfilledResult<unknown>).value).filter(Boolean)).toHaveLength(1)
    expect(await count()).toBe(2)
    await pool.query('delete from comments where parent_id is not null')
    const diffText = await Promise.allSettled([
      persist.saveNewComment(mk('r3', 'One')),
      persist.saveNewComment(mk('r4', 'Two')),
    ])
    expect(diffText.filter((r) => r.status === 'rejected')).toHaveLength(1)
    expect(await count()).toBe(2)
  })

  it('replay after a restart returns the first reply and writes nothing', async () => {
    const root = (await post('Root'))!
    const first = (await reply(root.id, 'Done', 'req-1'))!
    emptyLogs() // process restarted: nothing in memory
    const again = (await reply(root.id, 'Done', 'req-1'))!
    expect(again).toMatchObject({ id: first.id, replay: true })
    expect(await count()).toBe(2)
  })

  it('replay still answers after the thread was resolved', async () => {
    const root = (await post('Root'))!
    const first = (await reply(root.id, 'Done', 'req-1'))!
    await actions.resolveComment(root.id, 'bob')
    expect(await reply(root.id, 'Done', 'req-1')).toMatchObject({ id: first.id, replay: true })
    expect(await reply(root.id, 'New', undefined)).toBeUndefined()
  })

  it('different keys give two comments; no key behaves as before', async () => {
    const root = (await post('Root'))!
    const a = (await reply(root.id, 'Done', 'req-1'))!
    const b = (await reply(root.id, 'Done', 'req-2'))!
    const c = (await reply(root.id, 'Done'))!
    const d = (await reply(root.id, 'Done'))!
    expect(new Set([a.id, b.id, c.id, d.id]).size).toBe(4)
    expect(await count()).toBe(5)
  })

  it('the same key in a different thread is allowed', async () => {
    const r1 = (await post('Root one'))!
    const r2 = (await post('Root two'))!
    const a = (await reply(r1.id, 'Done', 'req-1'))!
    const b = (await reply(r2.id, 'Done', 'req-1'))!
    expect(a.id).not.toBe(b.id)
    expect(b).not.toHaveProperty('replay')
    expect(await count()).toBe(4)
  })

  it('repeat resolve is a no-op', async () => {
    const root = (await post('Root'))!
    const first = (await actions.resolveComment(root.id, 'bob'))!
    const again = (await actions.resolveComment(root.id, 'carol'))!
    expect(again.resolvedAt).toBe(first.resolvedAt)
    expect(again.resolvedBy).toBe('bob')
  })

  it('reply_to_comment over MCP takes client_request_id: replay says so, a changed text is an error', async () => {
    const client = await connect()
    const root = (await post('Root'))!
    const call = async (args: Record<string, unknown>) => {
      const res = (await client.callTool({
        name: 'reply_to_comment',
        arguments: { canvas_id: CANVAS.id, comment_id: root.id, agent_name: 'Claude', ...args },
      })) as unknown as { content: Array<{ text?: string }>; isError?: boolean }
      return { isError: res.isError, body: res.content.map((c) => c.text ?? '').join('') }
    }
    const first = await call({ text: 'Done', client_request_id: 'req-1' })
    expect(first.isError, first.body).toBeFalsy()
    const id = (JSON.parse(first.body) as { id: string }).id
    const again = await call({ text: 'Done', client_request_id: 'req-1' })
    expect(again.isError).toBeFalsy()
    expect(JSON.parse(again.body)).toMatchObject({ id, replay: true })
    const conflict = await call({ text: 'Other', client_request_id: 'req-1' })
    expect(conflict.isError).toBe(true)
    expect(conflict.body).toContain('client_request_id')
    expect(await count()).toBe(2)
  })
})
