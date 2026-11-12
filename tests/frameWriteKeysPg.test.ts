import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { stubEnv, unstubAllEnvs } from './envStub.ts'
import type { Canvas, Frame } from '../shared/types.ts'

/* Real PostgreSQL: at-most-once frame writes are a property of the unique
 * index and the one transaction, so mocks cannot show them. Set
 * DOOP_TEST_PG_URL to an empty database to run; skipped otherwise. */
const PG_URL = process.env.DOOP_TEST_PG_URL

vi.mock('../server/resident.ts', () => ({ onFeedback: () => {} }))
vi.mock('../server/distill.ts', () => ({ onDecision: () => {} }))

const T0 = 1_700_000_000_000
const ORIGINAL = '<h1>Original</h1>'
const actor = { name: 'Claude', kind: 'agent' as const, color: '#888' }
const user = { name: 'Bob', kind: 'user' as const, color: '#444' }
const mkCanvas = (): Canvas => ({
  id: 'fwk-canvas',
  name: 'Write keys',
  ownerId: 'owner-1',
  createdAt: 0,
  updatedAt: 0,
  pages: [{ id: 'p1', name: 'Page 1' }],
  frames: ['fwk-a', 'fwk-b'].map((id): Frame => ({
    id,
    canvasId: 'fwk-canvas',
    pageId: 'p1',
    name: id,
    html: ORIGINAL,
    x: 0,
    y: 0,
    width: 640,
    height: 480,
    createdAt: 0,
    updatedAt: T0,
    updatedBy: 'alice',
  })),
})

describe.skipIf(!PG_URL)('frame write keys on PostgreSQL', () => {
  let actions: typeof import('../server/actions.ts')
  let store: typeof import('../server/store.ts').store
  let persist: typeof import('../server/db/persist.ts')
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
    await pool.query('delete from frame_write_keys')
    await pool.query('delete from frame_versions')
    await pool.query('delete from frames')
    await pool.query("delete from canvases where id = 'fwk-canvas'")
    await pool.query('drop trigger if exists fwk_fail on frame_versions')
    const canvas = mkCanvas()
    await persist.saveCanvasCopy(canvas)
    store.init([canvas])
    actions.wire(
      () => {},
      () => {},
    )
  })

  const setHtml = async (
    frameId: string,
    html: string,
    key: string,
    extra: { versionName?: string; expectedUpdatedAt?: number } = {},
  ) => {
    const result = await actions.writeFrameHtmlOnce(frameId, { op: 'set', html, key, ...extra }, actor)
    if (!result) throw new Error(`frame ${frameId} not found`)
    return result
  }
  const dbFrame = async (id: string) =>
    (await pool.query('select html, width, height, updated_at from frames where id = $1', [id])).rows[0] as {
      html: string
      width: number
      height: number
      updated_at: string
    }
  const keyRows = async () => (await pool.query('select count(*)::int as n from frame_write_keys')).rows[0].n as number
  const versionRows = async (id: string) =>
    (await pool.query('select count(*)::int as n from frame_versions where id = $1', [id])).rows[0].n as number

  it('a retry after the caller lost the answer returns the first result: replay, same version id, no second write', async () => {
    const first = await setHtml('fwk-a', '<h1>New</h1>', 'k1', { versionName: 'draft 1' })
    expect(first.replay).toBe(false)
    // the caller was killed before it saved anything; it retries blind
    const again = await setHtml('fwk-a', '<h1>New</h1>', 'k1', { versionName: 'draft 1' })
    expect(again).toMatchObject({ replay: true, versionId: first.versionId, updatedAt: first.updatedAt })
    expect(await keyRows()).toBe(1)
    expect(await versionRows(first.versionId)).toBe(1)
    expect((await pool.query('select name from frame_versions where id = $1', [first.versionId])).rows[0].name).toBe(
      'draft 1',
    )
    expect(store.getFrame('fwk-a')!.html).toBe('<h1>New</h1>')
    expect(Number((await dbFrame('fwk-a')).updated_at)).toBe(first.updatedAt)
    expect(store.getFrame('fwk-a')!.updatedAt).toBe(first.updatedAt)
  })

  it('two concurrent calls with one key and one payload give one write and one replay', async () => {
    const [a, b] = await Promise.all([setHtml('fwk-a', '<h1>New</h1>', 'k1'), setHtml('fwk-a', '<h1>New</h1>', 'k1')])
    expect([a, b].filter((r) => r.replay)).toHaveLength(1)
    expect(a.versionId).toBe(b.versionId)
    expect(a.updatedAt).toBe(b.updatedAt)
    expect(await keyRows()).toBe(1)
    expect(await versionRows(a.versionId)).toBe(1)
  })

  it('one key with different payloads gives one write and one conflict, nothing changed by the loser', async () => {
    const results = await Promise.allSettled([
      setHtml('fwk-a', '<h1>One</h1>', 'k1'),
      setHtml('fwk-a', '<h1>Two</h1>', 'k1'),
    ])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    expect(rejected).toHaveLength(1)
    expect(rejected[0]!.reason).toBeInstanceOf(actions.FrameWriteKeyConflictError)
    const won = (results.find((r) => r.status === 'fulfilled') as PromiseFulfilledResult<{ versionId: string }>).value
    expect(await keyRows()).toBe(1)
    expect(await versionRows(won.versionId)).toBe(1)
    expect((await dbFrame('fwk-a')).html).toBe(store.getFrame('fwk-a')!.html)
    await expect(setHtml('fwk-a', '<h1>Three</h1>', 'k1')).rejects.toBeInstanceOf(actions.FrameWriteKeyConflictError)
    expect(store.getFrame('fwk-a')!.html).not.toBe('<h1>Three</h1>')
  })

  it('a replay after another writer edited the frame returns the first result and leaves that edit alone', async () => {
    const first = await setHtml('fwk-a', '<h1>Mine</h1>', 'k1')
    actions.updateFrame('fwk-a', { html: '<h1>Theirs</h1>' }, user)
    await persist.saveFrameNow(store.getFrame('fwk-a')!)
    const again = await setHtml('fwk-a', '<h1>Mine</h1>', 'k1')
    expect(again).toMatchObject({ replay: true, versionId: first.versionId, updatedAt: first.updatedAt })
    expect(store.getFrame('fwk-a')!.html).toBe('<h1>Theirs</h1>')
    expect((await dbFrame('fwk-a')).html).toBe('<h1>Theirs</h1>')
  })

  it('checks the key before expected_updated_at and before the lock: a replay is never a 412 or a 423', async () => {
    const first = await setHtml('fwk-a', '<h1>Mine</h1>', 'k1', { expectedUpdatedAt: T0 })
    actions.updateFrame('fwk-a', { locked: true }, user)
    const again = await setHtml('fwk-a', '<h1>Mine</h1>', 'k1', { expectedUpdatedAt: T0 })
    expect(again).toMatchObject({ replay: true, versionId: first.versionId })
  })

  it('a new key with a stale expected_updated_at is refused and leaves no key row', async () => {
    await expect(setHtml('fwk-a', '<h1>New</h1>', 'k1', { expectedUpdatedAt: T0 - 1 })).rejects.toBeInstanceOf(
      (await import('../server/store.ts')).FrameStaleError,
    )
    expect(await keyRows()).toBe(0)
    expect(store.getFrame('fwk-a')!.html).toBe(ORIGINAL)
  })

  it('a new key on a locked frame is refused and leaves no key row', async () => {
    actions.updateFrame('fwk-a', { locked: true }, user)
    await expect(setHtml('fwk-a', '<h1>New</h1>', 'k1')).rejects.toBeInstanceOf(
      (await import('../server/store.ts')).FrameLockedError,
    )
    expect(await keyRows()).toBe(0)
  })

  it('the same key on a different frame is a separate write', async () => {
    const a = await setHtml('fwk-a', '<h1>A</h1>', 'k1')
    const b = await setHtml('fwk-b', '<h1>B</h1>', 'k1')
    expect(b.replay).toBe(false)
    expect(b.versionId).not.toBe(a.versionId)
    expect(await keyRows()).toBe(2)
    expect(store.getFrame('fwk-b')!.html).toBe('<h1>B</h1>')
  })

  it('a write that fails midway leaves no key row, no stored html change and no in-memory change', async () => {
    await pool.query(`create or replace function fwk_boom() returns trigger as $$
      begin raise exception 'injected failure'; end $$ language plpgsql`)
    await pool.query('create trigger fwk_fail before insert on frame_versions for each row execute function fwk_boom()')
    // drizzle wraps the database error; the cause is the trigger's
    await expect(setHtml('fwk-a', '<h1>New</h1>', 'k1', { versionName: 'x' })).rejects.toMatchObject({
      cause: { message: 'injected failure' },
    })
    await pool.query('drop trigger fwk_fail on frame_versions')
    expect(await keyRows()).toBe(0)
    expect((await dbFrame('fwk-a')).html).toBe(ORIGINAL)
    expect(store.getFrame('fwk-a')).toMatchObject({ html: ORIGINAL, updatedAt: T0, updatedBy: 'alice' })
    // the same key works once the fault is gone
    expect((await setHtml('fwk-a', '<h1>New</h1>', 'k1')).replay).toBe(false)
    expect(await keyRows()).toBe(1)
  })

  it('without a key it behaves as before: every call writes, nothing is recorded', async () => {
    actions.updateFrame('fwk-a', { html: '<h1>One</h1>' }, actor)
    const after = actions.updateFrame('fwk-a', { html: '<h1>One</h1>' }, actor)
    expect(after?.html).toBe('<h1>One</h1>')
    expect(await keyRows()).toBe(0)
  })

  describe('over MCP', () => {
    async function connect() {
      const server = buildMcpServer('Owner', 'owner-1')
      const client = new Client({ name: 'fwk-test', version: '1.0.0' })
      const [c, s] = InMemoryTransport.createLinkedPair()
      await server.connect(s)
      await client.connect(c)
      return client
    }
    const run = async (client: Client, name: string, args: Record<string, unknown>) => {
      const res = (await client.callTool({
        name,
        arguments: { frame_id: 'fwk-a', agent_name: 'Claude', ...args },
      })) as unknown as { content: Array<{ text?: string }>; isError?: boolean }
      return { isError: res.isError, body: res.content.map((c) => c.text ?? '').join('\n') }
    }

    it('set_frame_html: a retry says replay: true; a changed payload is an error', async () => {
      const client = await connect()
      const first = await run(client, 'set_frame_html', { html: '<h1>New</h1>', idempotency_key: 'k1' })
      expect(first.isError, first.body).toBeFalsy()
      const again = await run(client, 'set_frame_html', { html: '<h1>New</h1>', idempotency_key: 'k1' })
      expect(again.isError, again.body).toBeFalsy()
      expect(again.body).toContain('"replay": true')
      const other = await run(client, 'set_frame_html', { html: '<h1>Other</h1>', idempotency_key: 'k1' })
      expect(other.isError).toBe(true)
      expect(other.body).toContain('idempotency_key')
      expect(await keyRows()).toBe(1)
    })

    it('edit_frame_html: a retry replays even though old_str is gone by then', async () => {
      const client = await connect()
      const args = { old_str: 'Original', new_str: 'Edited', idempotency_key: 'k1' }
      expect((await run(client, 'edit_frame_html', args)).isError).toBeFalsy()
      expect(store.getFrame('fwk-a')!.html).toBe('<h1>Edited</h1>')
      const again = await run(client, 'edit_frame_html', args)
      expect(again.isError, again.body).toBeFalsy()
      expect(again.body).toContain('"replay": true')
      expect(store.getFrame('fwk-a')!.html).toBe('<h1>Edited</h1>')
    })

    it('append_frame_html: a retried chunk is not appended twice', async () => {
      const client = await connect()
      const start = { html_chunk: '<h1>A</h1>', start: true, idempotency_key: 'c1' }
      expect((await run(client, 'append_frame_html', start)).isError).toBeFalsy()
      const next = { html_chunk: '<p>B</p>', idempotency_key: 'c2' }
      expect((await run(client, 'append_frame_html', next)).isError).toBeFalsy()
      const again = await run(client, 'append_frame_html', next)
      expect(again.isError, again.body).toBeFalsy()
      expect(again.body).toContain('"replay": true')
      expect(store.getFrame('fwk-a')!.html).toBe('<h1>A</h1><p>B</p>')
    })
  })
})
