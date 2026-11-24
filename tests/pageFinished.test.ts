import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Canvas, CanvasPageInfo, Frame, PageSnapshot } from '../shared/types.ts'
import { Client, startServer, type Server } from './harness.ts'

/**
 * CHE-9398 L5: Move to Finished and Restore. `PUT /api/canvases/:id/pages/:pageId/finished`
 * (and MCP `set_page_finished`) sets or clears the flag. Restore puts the page at the end of the
 * open pages, then catches its frames up: token block rewritten, the components they use queued
 * for propagation, a locked or streaming frame skipped. A snapshot restore running on the page
 * makes Move to Finished answer `page_busy`.
 *
 * The first half runs the real store, actions and MCP server in this process (persistence is an
 * in-memory fake); the second half runs the real REST server.
 */

const fake = vi.hoisted(() => ({
  snaps: new Map<string, unknown>(),
  blobs: new Map<string, string>(),
  /** held while a test races Move to Finished against a restore */
  beforeSave: null as null | (() => Promise<void>),
}))

vi.mock('../server/db/persist.ts', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  const noop = () => {}
  return {
    ...Object.fromEntries(Object.keys(actual).map((key) => [key, noop])),
    saveFrameNow: async () => {},
    listFrameVersions: async () => [],
    getFrameVersion: async () => undefined,
    componentsBehind: async () => [],
    savePageSnapshot: async (snap: PageSnapshot, html: Map<string, string>) => {
      await fake.beforeSave?.()
      fake.snaps.set(snap.id, structuredClone(snap))
      for (const [hash, body] of html) fake.blobs.set(`${snap.canvasId}:${hash}`, body)
    },
    listPageSnapshots: async (canvasId: string, pageId?: string) =>
      ([...fake.snaps.values()] as PageSnapshot[]).filter(
        (s) => s.canvasId === canvasId && (!pageId || s.pageId === pageId),
      ),
    getPageSnapshot: async (canvasId: string, id: string) => {
      const snap = fake.snaps.get(id) as PageSnapshot | undefined
      return snap && snap.canvasId === canvasId ? structuredClone(snap) : undefined
    },
    getSnapshotHtml: async (canvasId: string, hashes: string[]) =>
      new Map(hashes.map((h) => [h, fake.blobs.get(`${canvasId}:${h}`) ?? ''] as const)),
  }
})
vi.mock('../server/fonts.ts', () => ({ fontsForCanvas: () => [] }))
vi.mock('../server/resident.ts', () => ({ onFeedback: () => {} }))
vi.mock('../server/distill.ts', () => ({ onDecision: () => {} }))

const actions = await import('../server/actions.ts')
const propagation = await import('../server/propagation.ts')
const { createComponentFromHtml } = await import('../server/componentActions.ts')
const { buildMcpServer } = await import('../server/mcp.ts')
const { store } = await import('../server/store.ts')
const { restoring } = await import('../server/pageState.ts')
const { erasureContext, setTaskIdentityVerifier, warmTaskIdentity } = await import('../server/writePolicy.ts')

const OWNER = 'owner-1'
const T0 = 1_700_000_000_000
const FINISHED = { at: 1, by: 'Cheese' }
const human = { name: 'Kevin', kind: 'user' as const, color: '#2743ee' }
const agent = () => actions.resolveActor({ name: 'Claude', kind: 'agent' })

const frameRow = (id: string, pageId: string, over: Partial<Frame> = {}): Frame => ({
  id,
  canvasId: 'c1',
  pageId,
  name: `Frame ${id}`,
  html: `<p>${id}</p>`,
  x: 0,
  y: 0,
  width: 320,
  height: 200,
  createdAt: T0,
  updatedAt: T0,
  updatedBy: 'alice',
  ...over,
})

const broadcasts: Array<{ type: string; [key: string]: unknown }> = []

/** c1: the ledger, two open pages, one Finished page (`old`) and Archive */
function seed(): Canvas {
  const canvas: Canvas = {
    id: 'c1',
    name: 'Move to Finished',
    ownerId: OWNER,
    createdAt: 0,
    updatedAt: 0,
    pages: [
      { id: 'led', name: 'Baseline', ledger: true },
      { id: 'p1', name: 'One' },
      { id: 'p2', name: 'Two' },
      { id: 'old', name: 'Old', finished: FINISHED },
      { id: 'archive', name: 'Archive' },
    ],
    frames: [frameRow('o1', 'p1'), frameRow('o2', 'p2'), frameRow('x1', 'old'), frameRow('l1', 'led')],
  }
  store.deleteCanvas(erasureContext(), 'c1')
  store.init([canvas])
  actions.wire(
    (_canvasId, msg) => void broadcasts.push(msg as (typeof broadcasts)[number]),
    () => {},
  )
  return store.getCanvas('c1')!
}

const pageIds = (canvasId = 'c1') => store.getCanvas(canvasId)!.pages!.map((p) => p.id)
const pageOf = (id: string, canvasId = 'c1') => store.getCanvas(canvasId)!.pages!.find((p) => p.id === id)!
const activityOf = (canvasId = 'c1') => actions.getActivity(canvasId).map((a) => a.message)
const pagesMessages = () => broadcasts.filter((b) => b.type === 'canvas:pages')

/** everything a refused call must leave alone */
function state(canvasId = 'c1') {
  const canvas = store.getCanvas(canvasId)!
  return JSON.stringify({
    frames: canvas.frames.map((f) => ({ ...f })),
    pages: canvas.pages,
    activity: actions.getActivity(canvasId).length,
    broadcasts: broadcasts.length,
    snapshots: fake.snaps.size,
  })
}

async function connect(taskId?: string) {
  const server = buildMcpServer('Owner', OWNER, 'page-finished-test', taskId)
  const client = new McpClient({ name: 'page-finished-test', version: '1.0.0' })
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

const finish = (pageId: string, name: string, canvasId = 'c1') =>
  actions.setPageFinished(canvasId, pageId, true, name, human)
const restore = (pageId: string, name: string, canvasId = 'c1') =>
  actions.setPageFinished(canvasId, pageId, false, name, human)

beforeEach(() => {
  fake.snaps.clear()
  fake.blobs.clear()
  fake.beforeSave = null
  broadcasts.length = 0
  seed()
})

afterEach(() => {
  setTaskIdentityVerifier(undefined)
})

describe('set, repeat, clear and order', () => {
  it('sets {at, by}, moves the page behind the Finished pages and ahead of Archive, and says so once', () => {
    const logged = activityOf().length
    const done = finish('p1', 'One')
    expect(done).toMatchObject({ ok: true, changed: true })
    expect(pageIds()).toEqual(['led', 'p2', 'old', 'p1', 'archive'])
    expect(pageOf('p1').finished).toEqual({ at: expect.any(Number), by: 'Kevin' })
    expect(pagesMessages()).toHaveLength(1)
    expect(activityOf().slice(0, activityOf().length - logged)).toEqual([
      expect.stringContaining('“One” moved to Finished'),
    ])
  })

  it('a repeat keeps the first value and writes, logs and broadcasts nothing', () => {
    finish('p1', 'One')
    const first = pageOf('p1').finished
    const before = state()
    const again = actions.setPageFinished('c1', 'p1', true, 'One', { ...human, name: 'Somebody else' })
    expect(again).toMatchObject({ ok: true, changed: false })
    expect(pageOf('p1').finished).toEqual(first)
    expect(state()).toBe(before)
  })

  it('clear drops the flag, puts the page at the END of the open pages, broadcasts and logs once', () => {
    const logged = activityOf().length
    const done = restore('old', 'Old')
    expect(done).toMatchObject({ ok: true, changed: true })
    expect(pageIds()).toEqual(['led', 'p1', 'p2', 'old', 'archive'])
    expect(pageOf('old').finished).toBeUndefined()
    expect(pagesMessages()).toHaveLength(1)
    expect(activityOf().slice(0, activityOf().length - logged)).toEqual([
      expect.stringContaining('“Old” restored from Finished'),
    ])
  })

  it('clearing a page that is not Finished writes, logs and broadcasts nothing', () => {
    const before = state()
    expect(restore('p1', 'One')).toMatchObject({ ok: true, changed: false })
    expect(state()).toBe(before)
  })

  it('one activity per change: finish then restore logs two lines', () => {
    const logged = activityOf().length
    finish('p2', 'Two')
    restore('p2', 'Two')
    expect(activityOf().length - logged).toBe(2)
  })

  it('the default write page (L1) moves off a page once it is Finished', async () => {
    const { defaultWritePageId } = await import('../shared/pages.ts')
    expect(defaultWritePageId(store.getCanvas('c1')!)).toBe('p1')
    finish('p1', 'One')
    expect(defaultWritePageId(store.getCanvas('c1')!)).toBe('p2')
    restore('p1', 'One')
    expect(defaultWritePageId(store.getCanvas('c1')!)).toBe('p2')
  })
})

describe('refusals', () => {
  it('a stale expectedName answers page_changed with the current pages and writes nothing', () => {
    const before = state()
    const done = finish('p1', 'Renamed meanwhile')
    expect(done).toMatchObject({ ok: false, code: 'page_changed' })
    expect((done as { pages: CanvasPageInfo[] }).pages.map((p) => p.id)).toEqual(pageIds())
    expect(state()).toBe(before)
  })

  it('the ledger page and Archive cannot be finished', () => {
    const before = state()
    expect(finish('led', 'Baseline')).toMatchObject({ ok: false, code: 'ledger_page' })
    expect(finish('archive', 'Archive')).toMatchObject({ ok: false, code: 'archive_page' })
    expect(state()).toBe(before)
  })

  it('an unknown page answers not_found', () => {
    expect(finish('nope', 'x')).toMatchObject({ ok: false, code: 'not_found' })
  })
})

describe('agent binding (assertWritable set_page_state)', () => {
  const PROJECT = 'project-1'
  const verifier = async (taskId: string) => ({
    running: taskId !== 'task-9',
    agentId: 'agent-1',
    projectId: PROJECT,
    issueId: taskId === 'task-1' ? 'issue-1' : 'issue-2',
  })

  beforeEach(async () => {
    const canvas: Canvas = {
      id: 'c2',
      name: 'Bound',
      ownerId: OWNER,
      projectId: PROJECT,
      createdAt: 0,
      updatedAt: 0,
      pages: [
        { id: 'mine', name: 'Proposal', issueId: 'issue-1' },
        { id: 'theirs', name: 'Other', issueId: 'issue-2' },
      ],
      frames: [],
    }
    store.init([canvas, store.getCanvas('c1')!])
    setTaskIdentityVerifier(verifier)
    await warmTaskIdentity('task-1')
    await warmTaskIdentity('task-9')
  })

  it('a verified agent on its own issue’s page passes', async () => {
    const out = await call(await connect('task-1'), 'set_page_finished', {
      canvas_id: 'c2',
      page_id: 'mine',
      finished: true,
      expected_name: 'Proposal',
    })
    expect(out.isError, out.text).toBe(false)
    expect(pageOf('mine', 'c2').finished).toBeTruthy()
  })

  it('an agent on another issue’s page gets policy_refused and nothing is written', async () => {
    const before = state('c2')
    const out = await call(await connect('task-1'), 'set_page_finished', {
      canvas_id: 'c2',
      page_id: 'theirs',
      finished: true,
      expected_name: 'Other',
    })
    expect(out.isError).toBe(true)
    expect(out.text).toContain('policy_refused')
    expect(state('c2')).toBe(before)
  })

  it('an unverified agent is refused', async () => {
    const before = state('c2')
    const out = await call(await connect('task-9'), 'set_page_finished', {
      canvas_id: 'c2',
      page_id: 'mine',
      finished: true,
      expected_name: 'Proposal',
    })
    expect(out.isError).toBe(true)
    expect(out.text).toContain('policy_refused')
    expect(state('c2')).toBe(before)
  })
})

describe('MCP set_page_finished', () => {
  it('finishes and restores, and reports the stale name and the Archive page as errors', async () => {
    const client = await connect()
    const done = await call(client, 'set_page_finished', {
      canvas_id: 'c1',
      page_id: 'p2',
      finished: true,
      expected_name: 'Two',
    })
    expect(done.isError, done.text).toBe(false)
    expect(pageOf('p2').finished).toBeTruthy()
    const back = await call(client, 'set_page_finished', {
      canvas_id: 'c1',
      page_id: 'p2',
      finished: false,
      expected_name: 'Two',
    })
    expect(back.isError, back.text).toBe(false)
    expect(JSON.parse(back.text)).toMatchObject({ ok: true, skipped: [] })
    const stale = await call(client, 'set_page_finished', {
      canvas_id: 'c1',
      page_id: 'p2',
      finished: true,
      expected_name: 'Old name',
    })
    expect(stale.isError).toBe(true)
    expect(stale.text).toContain('page_changed')
    const archive = await call(client, 'set_page_finished', {
      canvas_id: 'c1',
      page_id: 'archive',
      finished: true,
      expected_name: 'Archive',
    })
    expect(archive.isError).toBe(true)
    expect(archive.text).toContain('archive_page')
  })
})

describe('a page-list save cannot rename or drop a Finished page', () => {
  const plain = () => store.getCanvas('c1')!.pages!.map(({ id, name }) => ({ id, name }))

  it('MCP set_canvas_pages refuses a rename and a drop with page_finished, nothing written', async () => {
    const client = await connect()
    const before = state()
    const renamed = await call(client, 'set_canvas_pages', {
      canvas_id: 'c1',
      expectedPages: plain(),
      pages: plain().map((p) => (p.id === 'old' ? { ...p, name: 'Renamed' } : p)),
    })
    expect(renamed.isError).toBe(true)
    expect(renamed.text).toContain('page_finished')
    const dropped = await call(client, 'set_canvas_pages', {
      canvas_id: 'c1',
      expectedPages: plain(),
      pages: plain().filter((p) => p.id !== 'old'),
    })
    expect(dropped.isError).toBe(true)
    expect(dropped.text).toContain('page_finished')
    expect(state()).toBe(before)
  })

  it('a plain {id,name} save keeps the flags and renames an open page', async () => {
    const client = await connect()
    const out = await call(client, 'set_canvas_pages', {
      canvas_id: 'c1',
      expectedPages: plain(),
      pages: plain().map((p) => (p.id === 'p1' ? { ...p, name: 'Uno' } : p)),
    })
    expect(out.isError, out.text).toBe(false)
    expect(pageOf('old').finished).toEqual(FINISHED)
    expect(pageOf('led').ledger).toBe(true)
    expect(pageOf('p1').name).toBe('Uno')
  })
})

describe('Restore catches the page up', () => {
  const body = (inner: string, style = '') => `<html><head></head><body style="${style}">${inner}</body></html>`

  /** a canvas of its own: a token, an open page and a page to finish */
  function setup() {
    const canvas = store.createCanvas('catch up', 'kevin')
    canvas.pages = [
      { id: 'open', name: 'Open' },
      { id: 'work', name: 'Work' },
    ]
    actions.createTokens(canvas.id, [{ name: '--ink', type: 'color', value: '#111' }], human)
    const make = (name: string, html: string, pageId = 'work') =>
      actions.createFrame(canvas.id, { name, html, pageId }, human)!
    return { canvasId: canvas.id, make }
  }

  it('a token value changed while Finished reaches the frame at Restore', () => {
    const s = setup()
    const f = s.make('f', body('<p>f</p>', 'color:var(--ink)'))
    expect(finish('work', 'Work', s.canvasId)).toMatchObject({ ok: true })
    actions.setTokens(s.canvasId, [{ name: '--ink', value: '#222' }], human)
    expect(store.getFrame(f.id)!.html).not.toContain('#222')
    const done = restore('work', 'Work', s.canvasId)
    expect(done).toMatchObject({ ok: true, skipped: [] })
    expect(store.getFrame(f.id)!.html).toContain('#222')
    expect(store.getFrame(f.id)!.html).not.toContain('#111')
  })

  it('a component change made while Finished reaches the frame after Restore', async () => {
    const s = setup()
    const def = createComponentFromHtml(
      s.canvasId,
      { name: 'Badge', html: '<span class="b">New</span>' },
      human,
    ).component
    const f = s.make('f', body('<doop-use component="Badge"></doop-use>'))
    await propagation.whenIdle()
    expect(finish('work', 'Work', s.canvasId)).toMatchObject({ ok: true })
    const main = store.getFrame(def.mainFrameId!)!
    actions.updateFrame(main.id, { html: main.html.replace('>New<', '>Fresh<') }, human)
    await propagation.whenIdle()
    expect(store.getFrame(f.id)!.html).toContain('New')
    restore('work', 'Work', s.canvasId)
    await propagation.whenIdle()
    expect(store.getFrame(f.id)!.html).toContain('Fresh')
  })

  it('a locked frame is skipped, byte-equal and listed; an unlocked stale one is rewritten; the page is open and broadcast', () => {
    const s = setup()
    const open = s.make('open', body('<p>o</p>', 'color:var(--ink)'))
    const locked = s.make('locked', body('<p>l</p>', 'color:var(--ink)'))
    actions.updateFrame(locked.id, { locked: true }, human)
    expect(finish('work', 'Work', s.canvasId)).toMatchObject({ ok: true })
    /* fixture: both blocks go stale — the token's value moves under a Finished page */
    store.getCanvas(s.canvasId)!.tokens!.find((t) => t.name === '--ink')!.value = '#333'
    const lockedBefore = { html: store.getFrame(locked.id)!.html, updatedAt: store.getFrame(locked.id)!.updatedAt }
    broadcasts.length = 0
    const done = restore('work', 'Work', s.canvasId)
    expect(done).toMatchObject({ ok: true, changed: true })
    expect((done as { skipped: unknown[] }).skipped).toEqual([{ frameId: locked.id, reason: 'locked' }])
    expect(store.getFrame(open.id)!.html).toContain('#333')
    expect({ html: store.getFrame(locked.id)!.html, updatedAt: store.getFrame(locked.id)!.updatedAt }).toEqual(
      lockedBefore,
    )
    expect(pageOf('work', s.canvasId).finished).toBeUndefined()
    expect(pageIds(s.canvasId)).toEqual(['open', 'work'])
    const types = broadcasts.map((b) => b.type)
    expect(types[0]).toBe('canvas:pages')
    expect(types).toContain('frame:updated')
  })

  it('a frame with an open append stream is skipped and listed', () => {
    const s = setup()
    const f = s.make('f', body('<p>f</p>', 'color:var(--ink)'))
    expect(finish('work', 'Work', s.canvasId)).toMatchObject({ ok: true })
    actions.setTokens(s.canvasId, [{ name: '--ink', value: '#222' }], human)
    /* open the page, then stream into the frame before the catch-up would reach it */
    store.getCanvas(s.canvasId)!.pages = store.getCanvas(s.canvasId)!.pages!.map((p) => {
      const { finished: _f, ...rest } = p
      return rest
    })
    actions.appendFrameHtml(f.id, '<p>more', agent(), { start: true })
    const done = actions.setPageFinished(s.canvasId, 'work', true, 'Work', human)
    expect(done).toMatchObject({ ok: true })
    const back = restore('work', 'Work', s.canvasId)
    expect((back as { skipped: unknown[] }).skipped).toEqual([{ frameId: f.id, reason: 'streaming' }])
  })
})

describe('REQUIRED_TEST FP-01: Move to Finished while a snapshot restore runs', () => {
  async function snapshotP1() {
    const out = await call(await connect(), 'create_page_snapshot', { canvas_id: 'c1', page_id: 'p1', name: 'A' })
    return (JSON.parse(out.text) as { snapshot: { id: string } }).snapshot.id
  }

  it('answers page_busy with nothing written, then passes once the restore is done', async () => {
    const snapshotId = await snapshotP1()
    actions.updateFrame('o1', { html: '<p>changed since</p>' }, agent())
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    fake.beforeSave = () => gate
    const running = actions.restorePageSnapshot('c1', snapshotId, agent())
    await vi.waitFor(() => expect(restoring('c1', 'p1')).toBe(true))
    const before = state()
    const done = finish('p1', 'One')
    expect(done).toMatchObject({ ok: false, code: 'page_busy' })
    expect(state()).toBe(before)
    expect(pageOf('p1').finished).toBeUndefined()
    release()
    await running
    expect(restoring('c1', 'p1')).toBe(false)
    expect(finish('p1', 'One')).toMatchObject({ ok: true, changed: true })
  })
})

describe('REQUIRED_TEST FP-03: two overlapping restores on one page', () => {
  it('Move to Finished answers page_busy until the second restore ends', async () => {
    const out = await call(await connect(), 'create_page_snapshot', { canvas_id: 'c1', page_id: 'p1', name: 'A' })
    const snapshotId = (JSON.parse(out.text) as { snapshot: { id: string } }).snapshot.id
    const gates: Array<() => void> = []
    let calls = 0
    fake.beforeSave = () => {
      calls++
      if (calls > 2) return Promise.resolve()
      return new Promise<void>((resolve) => gates.push(resolve))
    }
    const first = actions.restorePageSnapshot('c1', snapshotId, agent())
    const second = actions.restorePageSnapshot('c1', snapshotId, agent())
    await vi.waitFor(() => expect(gates).toHaveLength(2))
    gates[0]!()
    await first
    /* the first is done; the second is still in its safety write */
    expect(restoring('c1', 'p1')).toBe(true)
    const before = state()
    expect(finish('p1', 'One')).toMatchObject({ ok: false, code: 'page_busy' })
    expect(state()).toBe(before)
    gates[1]!()
    await second
    expect(restoring('c1', 'p1')).toBe(false)
    expect(finish('p1', 'One')).toMatchObject({ ok: true, changed: true })
  })
})

/* ------------------------------------------------------------------ */
/* REST, against the real server                                        */
/* ------------------------------------------------------------------ */

describe('REST finished route and page-list saves', () => {
  let server: Server
  let owner: Client
  let viewer: Client
  let canvasId = ''

  const route = (client: Client, pageId: string, body: unknown, cid = canvasId) =>
    client.put(`/api/canvases/${cid}/pages/${pageId}/finished`, body)
  const pagesNow = async () =>
    ((await (await owner.get(`/api/canvases/${canvasId}`)).json()) as Canvas).pages as CanvasPageInfo[]
  const plain = (pages: CanvasPageInfo[]) => pages.map(({ id, name }) => ({ id, name }))
  const savePages = async (pages: { id: string; name: string }[]) =>
    owner.put(`/api/canvases/${canvasId}/pages`, { pages, expectedPages: plain(await pagesNow()) })

  beforeAll(async () => {
    server = await startServer()
    owner = new Client(server)
    viewer = new Client(server)
    await owner.signUp('page-finished-owner@test.dev', 'Owner')
    await viewer.signUp('page-finished-viewer@test.dev', 'Viewer')
    canvasId = (await (await owner.post('/api/canvases', { name: 'Finished route' })).json()).id
    const first = (await pagesNow())[0]!
    expect(
      (
        await savePages([
          { id: first.id, name: 'One' },
          { id: 'p-a', name: 'A' },
          { id: 'p-b', name: 'B' },
        ])
      ).status,
    ).toBe(200)
  }, 180_000)

  afterAll(() => server?.stop())

  it('sets, repeats, clears and reorders over REST', async () => {
    const first = await route(owner, 'p-a', { finished: true, expectedName: 'A' })
    expect(first.status).toBe(200)
    const pages = ((await first.json()) as { pages: CanvasPageInfo[] }).pages
    expect(pages.map((p) => p.id).slice(-1)).toEqual(['p-a'])
    expect(pages.find((p) => p.id === 'p-a')?.finished).toMatchObject({ by: 'Owner' })
    const stamp = pages.find((p) => p.id === 'p-a')!.finished
    const again = await route(owner, 'p-a', { finished: true, expectedName: 'A' })
    expect(again.status).toBe(200)
    expect((await pagesNow()).find((p) => p.id === 'p-a')?.finished).toEqual(stamp)
    const cleared = await route(owner, 'p-a', { finished: false, expectedName: 'A' })
    expect(cleared.status).toBe(200)
    const after = await pagesNow()
    expect(after.find((p) => p.id === 'p-a')?.finished).toBeUndefined()
    expect(after.map((p) => p.id).slice(-1)).toEqual(['p-a'])
  })

  it('answers 409 page_changed with the pages on a stale name, 400 on a bad body, 404 on an unknown page', async () => {
    const stale = await route(owner, 'p-b', { finished: true, expectedName: 'Not B' })
    expect(stale.status).toBe(409)
    const body = (await stale.json()) as { code: string; pages: CanvasPageInfo[] }
    expect(body.code).toBe('page_changed')
    expect(body.pages.map((p) => p.id)).toContain('p-b')
    expect((await pagesNow()).find((p) => p.id === 'p-b')?.finished).toBeUndefined()
    expect((await route(owner, 'p-b', { finished: 'yes', expectedName: 'B' })).status).toBe(400)
    expect((await route(owner, 'p-b', { finished: true })).status).toBe(400)
    expect((await route(owner, 'nope', { finished: true, expectedName: 'x' })).status).toBe(404)
  })

  it('answers 400 ledger_page and archive_page', async () => {
    const pages = await pagesNow()
    const ledger = await owner.put(`/api/canvases/${canvasId}/pages/p-b/ledger`, { ledger: true })
    expect(ledger.status).toBe(200)
    const ledgerRes = await route(owner, 'p-b', { finished: true, expectedName: 'B' })
    expect(ledgerRes.status).toBe(400)
    expect(((await ledgerRes.json()) as { code: string }).code).toBe('ledger_page')
    expect((await owner.put(`/api/canvases/${canvasId}/pages/p-b/ledger`, { ledger: false })).status).toBe(200)
    expect(pages.some((p) => p.id === 'archive')).toBe(false)
    const archived = await route(owner, 'archive', { finished: true, expectedName: 'Archive' })
    expect([400, 404]).toContain(archived.status)
  })

  it('a view role gets 403', async () => {
    expect((await owner.patch(`/api/canvases/${canvasId}`, { linkAccess: 'view' })).status).toBe(200)
    await viewer.post('/api/auth/sign-in/email', { email: 'page-finished-viewer@test.dev', password: 'password12345' })
    expect((await route(viewer, 'p-b', { finished: true, expectedName: 'B' })).status).toBe(403)
    expect((await owner.patch(`/api/canvases/${canvasId}`, { linkAccess: 'none' })).status).toBe(200)
    expect((await pagesNow()).find((p) => p.id === 'p-b')?.finished).toBeUndefined()
  })

  it('a page-list save that renames or drops a Finished page answers 400 page_finished; a plain {id,name} save keeps the flag', async () => {
    expect((await route(owner, 'p-b', { finished: true, expectedName: 'B' })).status).toBe(200)
    const list = plain(await pagesNow())
    const renamed = await savePages(list.map((p) => (p.id === 'p-b' ? { ...p, name: 'Renamed' } : p)))
    expect(renamed.status).toBe(400)
    expect(((await renamed.json()) as { code: string }).code).toBe('page_finished')
    const dropped = await savePages(list.filter((p) => p.id !== 'p-b'))
    expect(dropped.status).toBe(400)
    expect(((await dropped.json()) as { code: string }).code).toBe('page_finished')
    const kept = await savePages(list.map((p) => (p.id === 'p-a' ? { ...p, name: 'Alpha' } : p)))
    expect(kept.status).toBe(200)
    const after = await pagesNow()
    expect(after.find((p) => p.id === 'p-b')?.finished).toBeTruthy()
    expect(after.find((p) => p.id === 'p-a')?.name).toBe('Alpha')
  })
})
