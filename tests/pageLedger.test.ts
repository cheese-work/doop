import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { PGlite } from '@electric-sql/pglite'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Canvas, CanvasPageInfo, Frame } from '../shared/types.ts'
import { Client, startServer, type Server } from './harness.ts'

/**
 * CHE-9398 L2: the ledger page. `PUT /api/canvases/:id/pages/:pageId/ledger` sets
 * the flag (one page at a time), and `pageOrder` keeps the list as: ledger, open
 * pages in saved order, Finished pages, Archive. Page-list saves (REST and MCP
 * `set_canvas_pages`) keep the flag, normalize the order and refuse only a list
 * that drops the ledger page. Copies and trash restores drop the flag.
 *
 * The first half runs the real store, actions and MCP server in this process
 * (persistence mocked); the second half runs the real REST server.
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
const { pageOrder } = await import('../shared/pages.ts')

const OWNER = 'owner-1'
const actor = { name: 'Tester', kind: 'user' as const, color: '#888888' }
const FINISHED = { at: 1, by: 'Cheese' }

const ledger = (id = 'ledger', name = 'Baseline'): CanvasPageInfo => ({ id, name, ledger: true })
const open = (id: string): CanvasPageInfo => ({ id, name: id })
const finished = (id = 'fin'): CanvasPageInfo => ({ id, name: 'Done', finished: FINISHED })
const archive = (): CanvasPageInfo => ({ id: 'archive', name: 'Archive' })
const ids = (pages: CanvasPageInfo[]) => pages.map((p) => p.id)
const plain = (pages: CanvasPageInfo[]) => pages.map(({ id, name }) => ({ id, name }))

let seeded = 0
const broadcasts: unknown[] = []
function seed(pages: CanvasPageInfo[], frames: Frame[] = []): Canvas {
  const canvas: Canvas = {
    id: `l${++seeded}`,
    name: 'Ledger',
    ownerId: OWNER,
    createdAt: 0,
    updatedAt: 0,
    pages,
    frames,
  }
  store.init([canvas])
  return canvas
}
const pagesOf = (canvas: Canvas) => store.getCanvas(canvas.id)!.pages!
const frame = (canvasId: string, id: string, pageId?: string): Frame =>
  ({
    id,
    canvasId,
    name: id,
    html: '<p>x</p>',
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    ...(pageId ? { pageId } : {}),
  }) as Frame

async function connect() {
  const server = buildMcpServer('Owner', OWNER)
  const client = new McpClient({ name: 'page-ledger-test', version: '1.0.0' })
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

beforeEach(() => {
  broadcasts.length = 0
  actions.wire(
    (_canvasId, msg) => void broadcasts.push(msg),
    () => {},
  )
})

describe('pageOrder', () => {
  it('puts the ledger first, open pages in saved order, Finished, then Archive', () => {
    const list = [archive(), finished('f1'), open('a'), ledger(), open('b'), finished('f2')]
    expect(ids(pageOrder(list))).toEqual(['ledger', 'a', 'b', 'f1', 'f2', 'archive'])
  })

  it('leaves a list with none of them as it is', () => {
    expect(ids(pageOrder([open('a'), open('b')]))).toEqual(['a', 'b'])
  })
})

describe('setting the ledger', () => {
  it('moves the page first and clears the old ledger', () => {
    const canvas = seed([open('a'), ledger('old'), open('b'), archive()])
    const done = actions.setPageLedger(canvas.id, 'b', true, actor)
    expect(done).toMatchObject({ ok: true, changed: true })
    expect(ids(pagesOf(canvas))).toEqual(['b', 'a', 'old', 'archive'])
    expect(
      pagesOf(canvas)
        .filter((p) => p.ledger)
        .map((p) => p.id),
    ).toEqual(['b'])
    expect(broadcasts).toContainEqual(expect.objectContaining({ type: 'canvas:pages' }))
  })

  it('frames keep their page across the reorder, those with no page id included', () => {
    const canvas = seed(
      [open('first'), open('second'), archive()],
      [frame('l-x', 'f-none'), frame('l-x', 'f-second', 'second')],
    )
    for (const f of canvas.frames) f.canvasId = canvas.id
    store.init([canvas])
    actions.setPageLedger(canvas.id, 'second', true, actor)
    expect(ids(pagesOf(canvas))).toEqual(['second', 'first', 'archive'])
    expect(store.getFrame('f-none')?.pageId).toBe('first')
    expect(store.getFrame('f-second')?.pageId).toBe('second')
  })

  it('clearing keeps the order and drops the flag', () => {
    const canvas = seed([open('a'), ledger('led'), archive()])
    expect(ids(pagesOf(canvas))).toEqual(['a', 'led', 'archive'])
    actions.setPageLedger(canvas.id, 'led', false, actor)
    expect(pagesOf(canvas).some((p) => p.ledger)).toBe(false)
  })

  it('refuses Archive, a Finished page and an unknown page, and writes nothing', () => {
    const canvas = seed([open('a'), finished(), archive()])
    const before = JSON.stringify(pagesOf(canvas))
    const log = actions.getActivity(canvas.id).length
    expect(actions.setPageLedger(canvas.id, 'archive', true, actor)).toMatchObject({ ok: false, code: 'archive_page' })
    expect(actions.setPageLedger(canvas.id, 'fin', true, actor)).toMatchObject({ ok: false, code: 'page_finished' })
    expect(actions.setPageLedger(canvas.id, 'nope', true, actor)).toMatchObject({ ok: false, code: 'not_found' })
    expect(JSON.stringify(pagesOf(canvas))).toBe(before)
    expect(actions.getActivity(canvas.id).length).toBe(log)
    expect(broadcasts).toHaveLength(0)
  })

  it('a repeat set writes, broadcasts and logs nothing', () => {
    const canvas = seed([open('a'), open('b')])
    actions.setPageLedger(canvas.id, 'b', true, actor)
    const log = actions.getActivity(canvas.id)
    const sent = broadcasts.length
    const again = actions.setPageLedger(canvas.id, 'b', true, actor)
    expect(again).toMatchObject({ ok: true, changed: false })
    expect(broadcasts).toHaveLength(sent)
    expect(actions.getActivity(canvas.id)).toEqual(log)
    expect(log.map((a) => a.message)).toEqual([expect.stringContaining('marked “b” as the ledger')])
  })

  it('logs the clear', () => {
    const canvas = seed([ledger('led'), open('a')])
    actions.setPageLedger(canvas.id, 'led', false, actor)
    expect(actions.getActivity(canvas.id)[0]?.message).toContain('cleared the ledger')
  })
})

describe('page-list saves keep the ledger and normalize the order', () => {
  it('lifecycle.py: [Patterns] + pages on a canvas whose ledger is Baseline', async () => {
    const canvas = seed([ledger(), open('a'), open('b'), archive()])
    const client = await connect()
    const patterns = { id: 'patterns', name: 'Patterns' }
    const out = await call(client, 'set_canvas_pages', {
      canvas_id: canvas.id,
      expectedPages: plain(pagesOf(canvas)),
      pages: [patterns, ...plain(pagesOf(canvas))],
    })
    expect(out.isError, out.text).toBe(false)
    expect(ids(pagesOf(canvas))).toEqual(['ledger', 'patterns', 'a', 'b', 'archive'])
    expect(pagesOf(canvas)[0]).toMatchObject({ ledger: true })
  })

  it('a plain {id, name} save that puts the ledger third returns it first and keeps the flag', async () => {
    const canvas = seed([ledger(), open('a'), open('b'), archive()])
    const client = await connect()
    const out = await call(client, 'set_canvas_pages', {
      canvas_id: canvas.id,
      expectedPages: plain(pagesOf(canvas)),
      pages: [open('a'), open('b'), { id: 'ledger', name: 'Baseline' }, archive()].map(({ id, name }) => ({
        id,
        name,
      })),
    })
    expect(out.isError, out.text).toBe(false)
    expect(ids(pagesOf(canvas))).toEqual(['ledger', 'a', 'b', 'archive'])
    expect(pagesOf(canvas)[0]?.ledger).toBe(true)
  })

  it('Finished pages stay after the open pages through a save', async () => {
    const canvas = seed([ledger(), open('a'), finished(), archive()])
    const client = await connect()
    const out = await call(client, 'set_canvas_pages', {
      canvas_id: canvas.id,
      expectedPages: plain(pagesOf(canvas)),
      pages: [
        { id: 'fin', name: 'Done' },
        { id: 'a', name: 'a' },
        { id: 'ledger', name: 'Baseline' },
        { id: 'archive', name: 'Archive' },
      ],
    })
    expect(out.isError, out.text).toBe(false)
    expect(ids(pagesOf(canvas))).toEqual(['ledger', 'a', 'fin', 'archive'])
    expect(pagesOf(canvas)[2]?.finished).toEqual(FINISHED)
  })

  it('MCP: a save without the ledger page is refused and writes nothing', async () => {
    const canvas = seed([ledger(), open('a'), archive()])
    const before = JSON.stringify(pagesOf(canvas))
    const log = actions.getActivity(canvas.id).length
    const out = await call(await connect(), 'set_canvas_pages', {
      canvas_id: canvas.id,
      expectedPages: plain(pagesOf(canvas)),
      pages: [
        { id: 'a', name: 'a' },
        { id: 'archive', name: 'Archive' },
      ],
    })
    expect(out.isError).toBe(true)
    expect(out.text).toContain('ledger')
    expect(JSON.stringify(pagesOf(canvas))).toBe(before)
    expect(actions.getActivity(canvas.id).length).toBe(log)
    expect(broadcasts).toHaveLength(0)
  })
})

describe('copy, restore and archive', () => {
  const fixture = () => [ledger(), open('a'), finished(), open('b'), archive()]

  it.each([
    ['the ledger', 'ledger'],
    ['a Finished page', 'fin'],
    ['an open page', 'b'],
  ])('a copy of %s is an open page: ledger, open (copy included), Finished, Archive', async (_name, source) => {
    const canvas = seed(fixture())
    const copy = await actions.duplicatePage(canvas.id, source, actor)
    expect(copy?.page.ledger).toBeUndefined()
    expect(copy?.page.finished).toBeUndefined()
    const expected = (list: CanvasPageInfo[]) => {
      expect(list[0]?.id).toBe('ledger')
      expect(ids(list).slice(1, 4).sort()).toEqual(['a', 'b', copy!.page.id].sort())
      expect(ids(list).slice(4)).toEqual(['fin', 'archive'])
    }
    expected(copy!.pages)
    expected(pagesOf(canvas))
    expect(pagesOf(canvas).filter((p) => p.ledger)).toHaveLength(1)
  })

  it('a restored page comes back an open page, ahead of Finished and Archive', async () => {
    const canvas = seed(fixture())
    actions.setCanvasPages(canvas.id, [ledger(), open('a'), finished(), archive()], actor)
    const back = await actions.restorePage(canvas.id, 'b', actor)
    expect(back?.page.ledger).toBeUndefined()
    expect(ids(pagesOf(canvas))).toEqual(['ledger', 'a', 'b', 'fin', 'archive'])
  })

  it('a restored ledger page comes back without the flag', async () => {
    const canvas = seed([ledger(), open('a'), archive()])
    actions.setCanvasPages(canvas.id, [open('a'), archive()], actor)
    expect(pagesOf(canvas).some((p) => p.ledger)).toBe(false)
    actions.setPageLedger(canvas.id, 'a', true, actor)
    const back = await actions.restorePage(canvas.id, 'ledger', actor)
    expect(back?.page.ledger).toBeUndefined()
    expect(ids(pagesOf(canvas))).toEqual(['a', 'ledger', 'archive'])
    expect(
      pagesOf(canvas)
        .filter((p) => p.ledger)
        .map((p) => p.id),
    ).toEqual(['a'])
  })

  it('archiving frames makes Archive last and keeps the ledger first', () => {
    const canvas = seed([open('a'), ledger(), finished()], [frame('x', 'f1', 'a')])
    for (const f of canvas.frames) f.canvasId = canvas.id
    store.init([canvas])
    actions.archiveFrames(canvas.id, ['f1'], actor)
    expect(ids(pagesOf(canvas))).toEqual(['ledger', 'a', 'fin', 'archive'])
  })
})

/* ------------------------------------------------------------------ */
/* REST, against the real server                                        */
/* ------------------------------------------------------------------ */

describe('REST ledger route and page-list saves', () => {
  let server: Server
  let owner: Client
  let viewer: Client
  let canvasId: string
  let finishedCanvasId: string

  const route = (client: Client, pageId: string, ledgerFlag: unknown, cid = canvasId) =>
    client.put(`/api/canvases/${cid}/pages/${pageId}/ledger`, { ledger: ledgerFlag })
  const pagesNow = async (cid = canvasId) =>
    ((await (await owner.get(`/api/canvases/${cid}`)).json()) as Canvas).pages as CanvasPageInfo[]
  const savePages = async (pages: { id: string; name: string }[], cid = canvasId) =>
    owner.put(`/api/canvases/${cid}/pages`, { pages, expectedPages: plain(await pagesNow(cid)) })

  beforeAll(async () => {
    server = await startServer()
    owner = new Client(server)
    viewer = new Client(server)
    await owner.signUp('page-ledger-owner@test.dev', 'Owner')
    await viewer.signUp('page-ledger-viewer@test.dev', 'Viewer')
    canvasId = (await (await owner.post('/api/canvases', { name: 'Ledger' })).json()).id
    const first = (await pagesNow())[0]!
    expect(
      (
        await savePages([
          { id: first.id, name: 'Baseline' },
          { id: 'p-a', name: 'A' },
          { id: 'p-b', name: 'B' },
        ])
      ).status,
    ).toBe(200)
    /* a Finished page has no route yet: write one into the database and boot again */
    finishedCanvasId = (await (await owner.post('/api/canvases', { name: 'Finished' })).json()).id
    const dataDir = server.dataDir
    server.stop({ keepData: true })
    await server.stopped
    const db = new PGlite(path.join(dataDir, 'data', 'pg'))
    await db.query('UPDATE canvases SET pages = $1::jsonb WHERE id = $2', [
      JSON.stringify([open('f-open'), finished('f-done'), archive()]),
      finishedCanvasId,
    ])
    await db.close()
    server = await startServer({}, dataDir)
    owner = new Client(server)
    viewer = new Client(server)
    await owner.post('/api/auth/sign-in/email', { email: 'page-ledger-owner@test.dev', password: 'password12345' })
    await viewer.post('/api/auth/sign-in/email', { email: 'page-ledger-viewer@test.dev', password: 'password12345' })
  }, 180_000)

  afterAll(() => server?.stop())

  it('sets the ledger first and clears the old one; a repeat changes nothing', async () => {
    const [base] = await pagesNow()
    expect((await route(owner, base!.id, true)).status).toBe(200)
    expect((await pagesNow())[0]).toMatchObject({ id: base!.id, ledger: true })
    expect((await route(owner, 'p-b', true)).status).toBe(200)
    const pages = await pagesNow()
    expect(ids(pages)).toEqual(['p-b', base!.id, 'p-a'])
    expect(pages.filter((p) => p.ledger).map((p) => p.id)).toEqual(['p-b'])
    expect((await route(owner, 'p-b', true)).status).toBe(200)
    expect(await pagesNow()).toEqual(pages)
  })

  it('refuses Archive and a Finished page; 404 for an unknown page; 400 for a bad body', async () => {
    const archived = await route(owner, 'archive', true, finishedCanvasId)
    expect(archived.status).toBe(400)
    expect(((await archived.json()) as { code: string }).code).toBe('archive_page')
    const done = await route(owner, 'f-done', true, finishedCanvasId)
    expect(done.status).toBe(400)
    expect(((await done.json()) as { code: string }).code).toBe('page_finished')
    expect((await route(owner, 'nope', true)).status).toBe(404)
    expect((await route(owner, 'p-a', 'yes')).status).toBe(400)
    expect((await pagesNow(finishedCanvasId)).some((p) => p.ledger)).toBe(false)
  })

  it('a view role gets 403', async () => {
    expect((await owner.patch(`/api/canvases/${canvasId}`, { linkAccess: 'view' })).status).toBe(200)
    expect((await route(viewer, 'p-a', true)).status).toBe(403)
    expect((await owner.patch(`/api/canvases/${canvasId}`, { linkAccess: 'none' })).status).toBe(200)
    expect((await pagesNow()).find((p) => p.id === 'p-a')?.ledger).toBeUndefined()
  })

  it('an agent key is refused', async () => {
    const key = (await (await owner.post('/api/agent-keys', { name: 'ledger-forger' })).json()).secret as string
    const res = await fetch(`${server.base}/api/canvases/${canvasId}/pages/p-a/ledger`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ ledger: true }),
    })
    expect(res.status).toBeGreaterThanOrEqual(401)
    expect((await pagesNow()).find((p) => p.id === 'p-a')?.ledger).toBeUndefined()
  })

  it('a page-list save keeps the flag, puts the ledger first and takes a new page after it', async () => {
    const current = await pagesNow()
    const sent = [
      { id: 'p-new', name: 'Patterns' },
      ...current.slice(1).map(({ id, name }) => ({ id, name })),
      { id: current[0]!.id, name: current[0]!.name },
    ]
    const res = await savePages(sent)
    expect(res.status).toBe(200)
    const body = (await res.json()) as CanvasPageInfo[]
    expect(body[0]).toMatchObject({ id: 'p-b', ledger: true })
    expect(ids(body)).toEqual(['p-b', 'p-new', current[1]!.id, 'p-a'])
    expect(ids(await pagesNow())).toEqual(ids(body))
  })

  it('a page-list save that drops the ledger page is 400 ledger_kept and writes nothing', async () => {
    const before = await pagesNow()
    const res = await savePages(before.filter((p) => !p.ledger).map(({ id, name }) => ({ id, name })))
    expect(res.status).toBe(400)
    expect(((await res.json()) as { code: string }).code).toBe('ledger_kept')
    expect(await pagesNow()).toEqual(before)
  })

  it('a copy of the ledger is an open page, and the order is the same after a reload', async () => {
    const res = await owner.post(`/api/canvases/${canvasId}/pages/p-b/duplicate`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { page: CanvasPageInfo; pages: CanvasPageInfo[] }
    expect(body.page.ledger).toBeUndefined()
    expect(body.pages[0]).toMatchObject({ id: 'p-b', ledger: true })
    expect(ids(await pagesNow())).toEqual(ids(body.pages))
    expect((await pagesNow()).filter((p) => p.ledger)).toHaveLength(1)
  })

  it('a copy of a Finished page lands in the open pages, ahead of Finished', async () => {
    const res = await owner.post(`/api/canvases/${finishedCanvasId}/pages/f-done/duplicate`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { page: CanvasPageInfo; pages: CanvasPageInfo[] }
    expect(ids(body.pages)).toEqual(['f-open', body.page.id, 'f-done', 'archive'])
    expect(ids(await pagesNow(finishedCanvasId))).toEqual(ids(body.pages))
  })
})
