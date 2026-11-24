import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { PGlite } from '@electric-sql/pglite'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Canvas, CanvasPageInfo } from '../shared/types.ts'
import { Client, startServer, type Server } from './harness.ts'

/**
 * CHE-9398 L1: a write that names no page lands on the first page that is not
 * the ledger, Finished or Archive (`defaultWritePageId`), not on page one.
 * With no such page it is refused and nothing is written. An explicit page id
 * is used as given. A trash restore whose page is gone falls back to
 * `recoveryPageId`: an open page, else the ledger, never Finished or Archive.
 *
 * The first half runs the real store, actions and MCP server in this process
 * (persistence mocked); the second half runs the real REST server on a
 * database seeded with the page layouts, since no route sets the flags yet.
 */

vi.mock('../server/db/persist.ts', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  const noop = () => {}
  return {
    ...Object.fromEntries(Object.keys(actual).map((key) => [key, noop])),
    getFrameVersion: async () => undefined,
  }
})
vi.mock('../server/resident.ts', () => ({ onFeedback: () => {} }))
vi.mock('../server/distill.ts', () => ({ onDecision: () => {} }))

const actions = await import('../server/actions.ts')
const { buildMcpServer } = await import('../server/mcp.ts')
const { store } = await import('../server/store.ts')
const { systemContext } = await import('../server/writePolicy.ts')
const { defaultWritePageId, recoveryPageId } = await import('../shared/pages.ts')
const { setPrototypeStart } = await import('../server/prototypeTools.ts')

const sys = systemContext()
const OWNER = 'owner-1'
const actor = { name: 'Tester', kind: 'agent' as const, color: '#888888' }
/* a recon-only frame is exempt from the recon gate, so a bound page takes it first */
const RECON = '<script type="application/json" id="doop-recon">{}</script>'
const FINISHED = { at: 1, by: 'Cheese' }

const ledger = (id = 'ledger'): CanvasPageInfo => ({ id, name: 'Baseline', ledger: true })
const open = (id: string): CanvasPageInfo => ({ id, name: id })
const finished = (id = 'fin'): CanvasPageInfo => ({ id, name: 'Done', finished: FINISHED })
const archive = (): CanvasPageInfo => ({ id: 'archive', name: 'Archive' })

/** layouts with no open page */
const CLOSED: Record<string, CanvasPageInfo[]> = {
  'ledger + Finished + Archive': [ledger(), finished(), archive()],
  'Finished + Archive': [finished(), archive()],
  'Archive only': [archive()],
}

let seeded = 0
const broadcasts: unknown[] = []
function seed(pages: CanvasPageInfo[], extra: Partial<Canvas> = {}): Canvas {
  const canvas: Canvas = {
    id: `c${++seeded}`,
    name: 'Write default',
    ownerId: OWNER,
    createdAt: 0,
    updatedAt: 0,
    pages,
    frames: [],
    ...extra,
  }
  store.init([canvas])
  return canvas
}

async function connect() {
  const server = buildMcpServer('Owner', OWNER)
  const client = new McpClient({ name: 'write-default-test', version: '1.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  return client
}

async function call(client: McpClient, name: string, args: Record<string, unknown>) {
  const result = (await client.callTool({ name, arguments: { agent_name: 'Claude', ...args } })) as unknown as {
    content: Array<{ type: string; text?: string }>
    isError?: boolean
  }
  return { text: result.content.map((block) => block.text ?? '').join('\n'), isError: !!result.isError }
}

/* the tool text is JSON followed by a nudge: the frame summary's id is the first one */
const created = (text: string) => /"id":\s*"([^"]+)"/.exec(text)![1]!
const pageOf = (canvasId: string, frameId: string) => store.getFrame(frameId)?.pageId

beforeEach(() => {
  broadcasts.length = 0
  actions.wire(
    (_canvasId, msg) => void broadcasts.push(msg),
    () => {},
  )
})

describe('defaultWritePageId and recoveryPageId', () => {
  it('skip the ledger, Finished and Archive; recovery falls back to the ledger', () => {
    const id = 'x'
    expect(defaultWritePageId({ id, pages: [ledger(), open('a'), open('b')] })).toBe('a')
    expect(defaultWritePageId({ id, pages: [open('a'), ledger('b')] })).toBe('a')
    expect(defaultWritePageId({ id, pages: [finished(), open('a')] })).toBe('a')
    expect(defaultWritePageId({ id, pages: CLOSED['ledger + Finished + Archive'] })).toBeUndefined()
    expect(recoveryPageId({ id, pages: CLOSED['ledger + Finished + Archive'] })).toBe('ledger')
    expect(recoveryPageId({ id, pages: CLOSED['Finished + Archive'] })).toBeUndefined()
    expect(recoveryPageId({ id, pages: [ledger(), open('a')] })).toBe('a')
    expect(defaultWritePageId({ id })).toBe(`${id}:page1`)
  })
})

describe('a write with no page lands on the first open page', () => {
  const layout = () => [ledger(), finished(), open('open1'), open('open2'), archive()]

  it('MCP create_frame', async () => {
    const canvas = seed(layout())
    const client = await connect()
    const out = await call(client, 'create_frame', { canvas_id: canvas.id, name: 'Hero', html: '<h1>x</h1>' })
    expect(out.isError, out.text).toBe(false)
    expect(pageOf(canvas.id, created(out.text))).toBe('open1')
  })

  it('store.createFrame and actions.createFrame', () => {
    const canvas = seed(layout())
    expect(store.createFrame(sys, canvas.id, { name: 'a' }, 'T')?.pageId).toBe('open1')
    expect(actions.createFrame(canvas.id, { name: 'b' }, actor)?.pageId).toBe('open1')
  })

  it('overlap placement measures the first open page', async () => {
    const canvas = seed(layout())
    store.createFrame(sys, canvas.id, { name: 'held', pageId: 'open1', x: 0, y: 0, html: '<p>a</p>' }, 'T')
    const client = await connect()
    const out = await call(client, 'create_frame', { canvas_id: canvas.id, name: 'B', html: '<p>b</p>', x: 0, y: 0 })
    expect(out.isError, out.text).toBe(false)
    expect(out.text).toMatch(/placement/)
    expect(pageOf(canvas.id, created(out.text))).toBe('open1')
  })

  it('MCP set_page_background', async () => {
    const canvas = seed(layout())
    const client = await connect()
    const out = await call(client, 'set_page_background', { canvas_id: canvas.id, color: '#112233' })
    expect(out.isError, out.text).toBe(false)
    const pages = store.getCanvas(canvas.id)!.pages!
    expect(pages.find((p) => p.id === 'open1')?.background).toBe('#112233')
    expect(pages.find((p) => p.id === 'ledger')?.background).toBeUndefined()
  })

  it('marking a non-first page as the ledger leaves the default where it was', () => {
    const canvas = seed([open('first'), { ...open('second'), ledger: true }, archive()])
    expect(store.createFrame(sys, canvas.id, { name: 'a' }, 'T')?.pageId).toBe('first')
  })

  it('a verified agent bound to the first open page still writes there', () => {
    const canvas = seed([ledger(), { ...open('open1'), issueId: 'issue-1' }, archive()], { projectId: 'project-1' })
    const ctx = {
      kind: 'agent' as const,
      taskId: 't1',
      agentId: 'a1',
      issueId: 'issue-1',
      projectId: 'project-1',
      verified: true,
    }
    expect(store.createFrame(ctx, canvas.id, { name: 'recon', html: RECON }, 'T')?.pageId).toBe('open1')
  })

  it('an explicit page id is used as given, the ledger included', async () => {
    const canvas = seed(layout())
    const client = await connect()
    for (const pageId of ['ledger', 'open2']) {
      const out = await call(client, 'create_frame', { canvas_id: canvas.id, pageId, name: pageId, html: '<p>x</p>' })
      expect(out.isError, out.text).toBe(false)
      expect(pageOf(canvas.id, created(out.text))).toBe(pageId)
    }
  })
})

describe('flow start with no page named', () => {
  it('clearing it targets the first open page, and is refused when there is none', () => {
    const canvas = seed([
      { ...ledger(), startFrameId: 'led-start' },
      { ...open('open1'), startFrameId: 'open-start' },
      archive(),
    ])
    expect(setPrototypeStart(canvas, undefined, null, actor)).toMatchObject({ ok: true })
    const pages = store.getCanvas(canvas.id)!.pages!
    expect(pages.find((p) => p.id === 'open1')?.startFrameId).toBeUndefined()
    expect(pages.find((p) => p.id === 'ledger')?.startFrameId).toBe('led-start')
    const closed = seed(structuredClone(CLOSED['Finished + Archive']!))
    expect(setPrototypeStart(closed, undefined, null, actor)).toEqual({
      ok: false,
      error: 'no open page: pass page_id',
    })
  })
})

describe.each(Object.entries(CLOSED))('layout %s: no open page', (_name, pages) => {
  const snapshot = (canvas: Canvas) => ({
    frames: canvas.frames.map((f) => f.id),
    pages: JSON.stringify(store.getCanvas(canvas.id)!.pages),
    activity: actions.getActivity(canvas.id).length,
    broadcasts: broadcasts.length,
  })

  it('MCP create_frame and set_page_background are refused and write nothing', async () => {
    const canvas = seed(structuredClone(pages))
    const client = await connect()
    const before = snapshot(canvas)
    const create = await call(client, 'create_frame', { canvas_id: canvas.id, name: 'x', html: '<p>x</p>' })
    expect(create.isError).toBe(true)
    expect(create.text).toContain('no open page: pass page_id')
    const background = await call(client, 'set_page_background', { canvas_id: canvas.id, color: '#112233' })
    expect(background.isError).toBe(true)
    expect(background.text).toContain('no open page: pass page_id')
    expect(snapshot(canvas)).toEqual(before)
  })

  it('store and action creates throw no_open_page and write nothing', () => {
    const canvas = seed(structuredClone(pages))
    const before = snapshot(canvas)
    expect(() => actions.createFrame(canvas.id, { name: 'x' }, actor)).toThrow(/no open page/)
    expect(() => store.createFrame(sys, canvas.id, { name: 'x' }, 'T')).toThrow(/no open page/)
    expect(snapshot(canvas)).toEqual(before)
  })

  it('an explicit page passes, the ledger included', async () => {
    const canvas = seed(structuredClone(pages))
    const client = await connect()
    const pageId = pages[0]!.id
    const out = await call(client, 'create_frame', { canvas_id: canvas.id, pageId, name: 'x', html: '<p>x</p>' })
    expect(out.isError, out.text).toBe(false)
    expect(pageOf(canvas.id, created(out.text))).toBe(pageId)
    const bg = await call(client, 'set_page_background', { canvas_id: canvas.id, page_id: pageId, color: '#112233' })
    expect(bg.isError, bg.text).toBe(false)
  })
})

describe('trash restore with the origin page gone', () => {
  async function trashed(pages: CanvasPageInfo[]) {
    const canvas = seed([open('gone'), ...pages])
    const frame = store.createFrame(sys, canvas.id, { name: 'Hero', html: '<h1>a</h1>', pageId: 'gone' }, 'T')!
    actions.deleteFrame(frame.id, actor)
    store.getCanvas(canvas.id)!.pages = pages
    return { canvas, frame }
  }

  it('lands on the first open page', async () => {
    const { canvas, frame } = await trashed([ledger(), finished(), open('open1'), archive()])
    const back = await actions.restoreFrame(frame.id, actor)
    expect(back?.pageId).toBe('open1')
    expect(pageOf(canvas.id, frame.id)).toBe('open1')
  })

  it('else lands on the ledger, never Finished or Archive', async () => {
    const { frame } = await trashed(CLOSED['ledger + Finished + Archive']!)
    const back = await actions.restoreFrame(frame.id, actor)
    expect(back?.pageId).toBe('ledger')
  })

  it.each(['Finished + Archive', 'Archive only'])('with %s: refused, the frame stays in the trash', async (name) => {
    const { canvas, frame } = await trashed(CLOSED[name]!)
    const activity = actions.getActivity(canvas.id).length
    const sent = broadcasts.length
    await expect(actions.restoreFrame(frame.id, actor)).rejects.toThrow(/no open page/)
    expect(store.getFrame(frame.id)).toBeUndefined()
    expect(store.getDeletedFrame(frame.id)).toBeDefined()
    expect(actions.getActivity(canvas.id).length).toBe(activity)
    expect(broadcasts.length).toBe(sent)
  })

  it('MCP restore_frame answers the refusal as a tool error', async () => {
    const { frame } = await trashed(CLOSED['Archive only']!)
    const out = await call(await connect(), 'restore_frame', { frame_id: frame.id })
    expect(out.isError).toBe(true)
    expect(out.text).toContain('no open page')
  })
})

/* ------------------------------------------------------------------ */
/* REST, against the real server on a seeded database                  */
/* ------------------------------------------------------------------ */

describe('REST frame create and trash restore', () => {
  const layouts: Record<string, CanvasPageInfo[]> = {
    open: [ledger(), finished(), open('open1'), archive()],
    ...CLOSED,
  }
  const ids: Record<string, { canvasId: string; frameId: string }> = {}
  let server: Server
  let owner: Client

  beforeAll(async () => {
    server = await startServer()
    owner = new Client(server)
    await owner.signUp('writedefault@test.dev', 'Write Default')
    for (const name of Object.keys(layouts)) {
      const canvas = await (await owner.post('/api/canvases', { name })).json()
      const frame = await (
        await owner.post(`/api/canvases/${canvas.id}/frames`, { name: 'Hero', html: '<h1>a</h1>' })
      ).json()
      expect((await owner.delete(`/api/frames/${frame.id}`)).status).toBe(200)
      ids[name] = { canvasId: canvas.id, frameId: frame.id }
    }
    /* the page flags have no route yet: write the layouts into the database and boot again */
    const dataDir = server.dataDir
    server.stop({ keepData: true })
    await server.stopped
    const db = new PGlite(path.join(dataDir, 'data', 'pg'))
    for (const [name, pages] of Object.entries(layouts))
      await db.query('UPDATE canvases SET pages = $1::jsonb WHERE id = $2', [
        JSON.stringify(pages),
        ids[name]!.canvasId,
      ])
    await db.close()
    server = await startServer({}, dataDir)
    owner = new Client(server)
    expect(
      (await owner.post('/api/auth/sign-in/email', { email: 'writedefault@test.dev', password: 'password12345' }))
        .status,
    ).toBe(200)
  }, 180_000)

  afterAll(() => server?.stop())

  const canvasOf = async (name: string) =>
    (await (await owner.get(`/api/canvases/${ids[name]!.canvasId}`)).json()) as Canvas

  it('creates on the first open page when none is named', async () => {
    const res = await owner.post(`/api/canvases/${ids.open!.canvasId}/frames`, { name: 'New' })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { pageId: string }).pageId).toBe('open1')
  })

  it.each(Object.keys(CLOSED))(
    'layout %s: create with no page is 409 no_open_page; an explicit page passes',
    async (name) => {
      const { canvasId } = ids[name]!
      const before = (await canvasOf(name)).frames.length
      const res = await owner.post(`/api/canvases/${canvasId}/frames`, { name: 'New' })
      expect(res.status).toBe(409)
      expect(((await res.json()) as { code: string }).code).toBe('no_open_page')
      expect((await canvasOf(name)).frames).toHaveLength(before)
      const pageId = layouts[name]![0]!.id
      const ok = await owner.post(`/api/canvases/${canvasId}/frames`, { name: 'New', pageId })
      expect(ok.status).toBe(200)
      expect(((await ok.json()) as { pageId: string }).pageId).toBe(pageId)
    },
  )

  it('restore of a frame whose page is gone: open page, else the ledger', async () => {
    const onOpen = await owner.post(`/api/frames/${ids.open!.frameId}/restore`)
    expect(onOpen.status).toBe(200)
    expect(((await onOpen.json()) as { pageId: string }).pageId).toBe('open1')
    const onLedger = await owner.post(`/api/frames/${ids['ledger + Finished + Archive']!.frameId}/restore`)
    expect(onLedger.status).toBe(200)
    expect(((await onLedger.json()) as { pageId: string }).pageId).toBe('ledger')
  })

  it.each(['Finished + Archive', 'Archive only'])(
    'restore with %s: 409 no_open_page, the frame stays in the trash',
    async (name) => {
      const { canvasId, frameId } = ids[name]!
      const res = await owner.post(`/api/frames/${frameId}/restore`)
      expect(res.status).toBe(409)
      expect(((await res.json()) as { code: string }).code).toBe('no_open_page')
      const trash = (await (await owner.get(`/api/canvases/${canvasId}/trash`)).json()) as { frames: { id: string }[] }
      expect(trash.frames.map((f) => f.id)).toContain(frameId)
    },
  )
})
