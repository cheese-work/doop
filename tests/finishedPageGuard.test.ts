import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { PGlite } from '@electric-sql/pglite'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Canvas, CanvasPageInfo, Frame, PageSnapshot } from '../shared/types.ts'
import { Client, startServer, type Server } from './harness.ts'

/**
 * CHE-9398 L3: a Finished page refuses every frame write, from every actor
 * and every path, except the lock-only patch the design lifecycle sends. A
 * snapshot restore on a Finished page is refused before it files anything.
 *
 * The first half runs the real store, actions and MCP server in this process
 * (persistence is an in-memory fake); the second half runs the real REST
 * server and design-sync endpoint on a database seeded with a Finished page,
 * since no route sets the flag yet.
 */

const fake = vi.hoisted(() => ({
  snaps: new Map<string, unknown>(),
  blobs: new Map<string, string>(),
  /** held while a test races a writer against a restore */
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
vi.mock('../server/resident.ts', () => ({ onFeedback: () => {} }))
vi.mock('../server/distill.ts', () => ({ onDecision: () => {} }))

const actions = await import('../server/actions.ts')
const { buildMcpServer } = await import('../server/mcp.ts')
const { store, FrameLockedError } = await import('../server/store.ts')
const { PageFinishedError, restoring } = await import('../server/pageState.ts')
const { erasureContext, setLockOwners, setTaskIdentityVerifier, systemContext, userContext, warmTaskIdentity } =
  await import('../server/writePolicy.ts')

const sys = systemContext()
const OWNER = 'owner-1'
const T0 = 1_700_000_000_000
const FINISHED = { at: 1, by: 'Cheese' }
const actor = { name: 'Tester', kind: 'agent' as const, color: '#888888' }

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

const broadcasts: unknown[] = []

/** c1: an open page `p1` and a Finished page `fin`, each with frames; `t1` waits in the trash from `fin` */
function seed(): Canvas {
  const canvas: Canvas = {
    id: 'c1',
    name: 'Finished guard',
    ownerId: OWNER,
    createdAt: 0,
    updatedAt: 0,
    pages: [
      { id: 'p1', name: 'Open' },
      { id: 'fin', name: 'Done' },
    ],
    frames: [
      frameRow('o1', 'p1', { x: 0 }),
      frameRow('f1', 'fin', { x: 0 }),
      frameRow('f2', 'fin', { x: 400 }),
      frameRow('f3', 'fin', { x: 800, locked: true }),
      frameRow('t1', 'fin', { x: 1200 }),
    ],
  }
  store.deleteCanvas(erasureContext(), 'c1') // the store keeps a canvas's trash across init (a locked frame needs erasure)
  store.init([canvas])
  actions.wire(
    (_canvasId, msg) => void broadcasts.push(msg),
    () => {},
  )
  actions.deleteFrame('t1', actor)
  setFinished(true)
  return store.getCanvas('c1')!
}

/** flip the flag the way the page lifecycle will (no route sets it yet) */
function setFinished(on: boolean, pageId = 'fin', canvasId = 'c1') {
  const canvas = store.getCanvas(canvasId)!
  canvas.pages = canvas.pages!.map((page) => {
    if (page.id !== pageId) return page
    const { finished: _finished, ...rest } = page
    return on ? { ...rest, finished: FINISHED } : rest
  })
}

async function connect(taskId?: string) {
  const server = buildMcpServer('Owner', OWNER, 'finished-guard-test', taskId)
  const client = new McpClient({ name: 'finished-guard-test', version: '1.0.0' })
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

/** everything a refused write must leave alone */
function state(canvasId = 'c1') {
  const canvas = store.getCanvas(canvasId)!
  return JSON.stringify({
    frames: canvas.frames.map((f) => ({ ...f })),
    pages: canvas.pages,
    trash: store.listTrash(canvasId).frames.map((f) => ({ ...f })),
    activity: actions.getActivity(canvasId).length,
    broadcasts: broadcasts.length,
    snapshots: fake.snaps.size,
  })
}

const FINISHED_TEXT = /Finished.*Restore the page first/

beforeEach(() => {
  fake.snaps.clear()
  fake.blobs.clear()
  fake.beforeSave = null
  broadcasts.length = 0
  setLockOwners([OWNER])
  seed()
})

afterEach(() => {
  setTaskIdentityVerifier(undefined)
})

describe('a Finished page refuses frame writes over MCP and in the store', () => {
  const refused: Array<[string, string, Record<string, unknown>]> = [
    ['create_frame', 'create_frame', { canvas_id: 'c1', pageId: 'fin', name: 'New', html: '<p>x</p>' }],
    ['update_frame (rename)', 'update_frame', { frame_id: 'f1', name: 'Renamed' }],
    ['update_frame (move)', 'update_frame', { frame_id: 'f1', y: 600 }],
    ['update_frame, move into the page', 'update_frame', { frame_id: 'o1', pageId: 'fin', x: 0, y: 1000 }],
    ['update_frame, move out of the page', 'update_frame', { frame_id: 'f1', pageId: 'p1', x: 0, y: 1000 }],
    ['set_frame_html', 'set_frame_html', { frame_id: 'f1', html: '<p>new</p>' }],
    ['delete_frame', 'delete_frame', { frame_id: 'f1' }],
    ['archive_frames', 'archive_frames', { canvas_id: 'c1', frame_ids: ['f1'] }],
    ['archive_frames, one open and one Finished', 'archive_frames', { canvas_id: 'c1', frame_ids: ['o1', 'f1'] }],
    ['restore_frame (trash)', 'restore_frame', { frame_id: 't1' }],
    ['set_page_background', 'set_page_background', { canvas_id: 'c1', page_id: 'fin', color: '#112233' }],
    ['set_prototype_start', 'set_prototype_start', { canvas_id: 'c1', pageId: 'fin', frame_id: 'f1' }],
  ]

  it.each(refused)('%s is refused and writes nothing', async (_name, tool, args) => {
    const client = await connect()
    const before = state()
    const out = await call(client, tool, args)
    expect(out.isError, out.text).toBe(true)
    expect(out.text).toMatch(FINISHED_TEXT)
    expect(state()).toBe(before)
  })

  it.each(refused)('%s passes once finished is cleared', async (_name, tool, args) => {
    setFinished(false)
    const client = await connect()
    const out = await call(client, tool, args)
    expect(out.isError, out.text).toBe(false)
  })

  it('a direct store.updateFrame by the system throws PageFinishedError and writes nothing', () => {
    const before = state()
    expect(() => store.updateFrame(sys, 'f1', { name: 'x' }, 'T')).toThrow(PageFinishedError)
    expect(() => store.updateFrame(sys, 'o1', { pageId: 'fin' }, 'T')).toThrow(PageFinishedError)
    expect(() => store.createFrame(sys, 'c1', { name: 'x', pageId: 'fin' }, 'T')).toThrow(PageFinishedError)
    expect(() => store.deleteFrame(sys, 'f1')).toThrow(PageFinishedError)
    expect(() => store.restoreFrame('t1')).toThrow(PageFinishedError)
    expect(() => store.setPageBackground('c1', 'fin', '#112233')).toThrow(PageFinishedError)
    expect(() => store.setFlowStart('c1', 'fin', 'f1')).toThrow(PageFinishedError)
    expect(state()).toBe(before)
  })

  it('the refusal is a PolicyRefused with code page_finished', () => {
    try {
      store.updateFrame(sys, 'f1', { name: 'x' }, 'T')
      expect.unreachable()
    } catch (e) {
      expect(e).toBeInstanceOf(PageFinishedError)
      expect(e).toMatchObject({ code: 'page_finished' })
      expect((e as Error).message).toMatch(FINISHED_TEXT)
    }
  })

  it('a locked frame on a Finished page still answers the lock refusal first', async () => {
    expect(() => store.updateFrame(sys, 'f3', { name: 'x' }, 'T')).toThrow(FrameLockedError)
    const before = state()
    const out = await call(await connect(), 'update_frame', { frame_id: 'f3', name: 'x' })
    expect(out.isError).toBe(true)
    expect(out.text).toContain('is locked')
    expect(state()).toBe(before)
  })
})

describe('lock and unlock are not frozen', () => {
  it('lock_frame_if_version (attested) locks a frame on a Finished page', async () => {
    const out = await call(await connect(), 'lock_frame_if_version', {
      frame_id: 'f1',
      attested_updated_at: new Date(T0).toISOString(),
      attestation_id: 'att-1',
    })
    expect(out.isError, out.text).toBe(false)
    expect(store.getFrame('f1')?.locked).toBe(true)
  })

  it('an owner unlock passes on a Finished page', () => {
    const frame = store.updateFrame(userContext(OWNER), 'f3', { locked: false }, 'Owner')
    expect(frame?.locked).toBe(false)
  })
})

describe('lock-only: the lifecycle call locks a frame on a Finished page', () => {
  const PROJECT = 'project-1'
  const verifier = async (taskId: string) => ({
    running: true,
    agentId: 'agent-1',
    projectId: PROJECT,
    issueId: taskId === 'task-1' ? 'issue-1' : 'issue-2',
  })

  /** c2: bound to a project; `bound` is the proposal page of issue-1 (Finished), `other` belongs to issue-2 */
  function seedBound() {
    const canvas: Canvas = {
      id: 'c2',
      name: 'Bound',
      ownerId: OWNER,
      projectId: PROJECT,
      createdAt: 0,
      updatedAt: 0,
      pages: [
        { id: 'bound', name: 'Proposal', issueId: 'issue-1', finished: FINISHED },
        { id: 'other', name: 'Other', issueId: 'issue-2' },
      ],
      frames: ['l1', 'l2', 'l3', 'l4', 'l5'].map((id, i) => frameRow(id, 'bound', { canvasId: 'c2', x: i * 400 })),
    }
    store.init([canvas])
  }

  beforeEach(async () => {
    seedBound()
    setTaskIdentityVerifier(verifier)
    await warmTaskIdentity('task-1')
    await warmTaskIdentity('task-2')
  })

  it('MCP update_frame {frame_id, locked:true, agent_name} from the agent bound to the page locks', async () => {
    const out = await call(await connect('task-1'), 'update_frame', { frame_id: 'l1', locked: true })
    expect(out.isError, out.text).toBe(false)
    expect(store.getFrame('l1')?.locked).toBe(true)
  })

  it.each([
    ['locked + name', { frame_id: 'l2', locked: true, name: 'Renamed' }],
    ['locked + pageId', { frame_id: 'l3', locked: true, pageId: 'other' }],
    ['locked + y', { frame_id: 'l4', locked: true, y: 1000 }],
  ])('MCP update_frame with %s is refused page_finished, nothing written', async (_name, args) => {
    const before = state('c2')
    const out = await call(await connect('task-1'), 'update_frame', args)
    expect(out.isError, out.text).toBe(true)
    expect(out.text).toMatch(FINISHED_TEXT)
    expect(state('c2')).toBe(before)
    expect(store.getFrame(args.frame_id as string)?.locked).toBeFalsy()
  })

  it('the same lock-only call from an agent on another issue stays policy_refused', async () => {
    const before = state('c2')
    const out = await call(await connect('task-2'), 'update_frame', { frame_id: 'l5', locked: true })
    expect(out.isError).toBe(true)
    expect(out.text).toContain('policy_refused')
    expect(out.text).not.toMatch(FINISHED_TEXT)
    expect(state('c2')).toBe(before)
  })

  it('an already locked frame is not lock-only: the lock refusal answers', async () => {
    store.updateFrame(sys, 'l1', { locked: true }, 'T')
    const out = await call(await connect('task-1'), 'update_frame', { frame_id: 'l1', locked: true })
    expect(out.isError).toBe(true)
    expect(out.text).toContain('is locked')
  })
})

describe('REQUIRED_TEST FP-01: a refused restore writes nothing', () => {
  const agent = () => actions.resolveActor({ name: 'Claude', kind: 'agent' })

  async function snapshotP1() {
    const out = await call(await connect(), 'create_page_snapshot', { canvas_id: 'c1', page_id: 'p1', name: 'A' })
    return (JSON.parse(out.text) as { snapshot: { id: string } }).snapshot.id
  }

  it('FP-01: MCP restore_page_snapshot on a Finished page whose frame changed returns the Finished refusal', async () => {
    const client = await connect()
    const snapshotId = await snapshotP1()
    actions.updateFrame('o1', { html: '<p>changed since</p>' }, agent())
    setFinished(true, 'p1')
    const before = state()
    const out = await call(client, 'restore_page_snapshot', { canvas_id: 'c1', snapshot_id: snapshotId })
    expect(out.isError, out.text).toBe(true)
    expect(out.text).toMatch(FINISHED_TEXT)
    /* no safety snapshot filed, the frame row, activity and broadcasts unchanged */
    expect(fake.snaps.size).toBe(1)
    expect(state()).toBe(before)
    expect(store.getFrame('o1')?.html).toBe('<p>changed since</p>')
    expect(restoring('c1', 'p1')).toBe(false)
  })

  it('a restore that moves a frame now on another Finished page skips it and reports page_finished', async () => {
    store.getCanvas('c1')!.pages!.push({ id: 'p2', name: 'Second' })
    store.createFrame(sys, 'c1', { name: 'o2', pageId: 'p1', x: 400, y: 0, html: '<p>o2</p>' }, 'T')
    const o2 = store.getCanvas('c1')!.frames.find((f) => f.name === 'o2')!
    const client = await connect()
    const snapshotId = await snapshotP1()
    /* o1 leaves for p2 and o2 is edited; then p2 finishes */
    actions.updateFrame('o1', { pageId: 'p2', x: 0, y: 0 }, agent())
    actions.updateFrame(o2.id, { html: '<p>o2 changed</p>' }, agent())
    setFinished(true, 'p2')
    const out = await call(client, 'restore_page_snapshot', { canvas_id: 'c1', snapshot_id: snapshotId })
    expect(out.isError, out.text).toBe(false)
    const body = JSON.parse(out.text) as { skipped: Array<{ frameId: string; reason: string }> }
    expect(body.skipped).toEqual([expect.objectContaining({ frameId: 'o1', reason: 'page_finished' })])
    expect(store.getFrame('o1')?.pageId).toBe('p2')
    expect(store.getFrame(o2.id)?.html).toBe('<p>o2</p>')
  })

  it('the in-flight counter returns to 0 after two overlapping restores, one of which throws SnapshotError', async () => {
    const client = await connect()
    const snapshotId = await snapshotP1()
    let calls = 0
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    let churn = false
    fake.beforeSave = async () => {
      calls++
      if (calls === 1) return gate /* restore 1 stays in its safety write */
      if (churn) store.updateFrame(sys, 'o1', { html: `<p>churn ${calls}</p>` }, 'T')
    }
    const first = call(client, 'restore_page_snapshot', { canvas_id: 'c1', snapshot_id: snapshotId })
    await vi.waitFor(() => expect(restoring('c1', 'p1')).toBe(true))
    churn = true
    const second = await call(client, 'restore_page_snapshot', { canvas_id: 'c1', snapshot_id: snapshotId })
    expect(second.isError, second.text).toBe(true)
    expect(second.text).toMatch(/keeps changing/)
    /* the failed restore counted itself out; the paused one still counts */
    expect(restoring('c1', 'p1')).toBe(true)
    churn = false
    release()
    const firstOut = await first
    expect(firstOut.isError, firstOut.text).toBe(false)
    expect(restoring('c1', 'p1')).toBe(false)
  })
})

/* ------------------------------------------------------------------ */
/* REST and design sync, against the real server on a seeded database  */
/* ------------------------------------------------------------------ */

describe('REST and design sync on a Finished page', () => {
  let server: Server
  let owner: Client
  let canvasId = ''
  let secret = ''
  const ids: Record<string, string> = {}
  const FIN = 'fin'
  const OPEN = 'open'

  beforeAll(async () => {
    server = await startServer({ SYNC_PAGE_INTERVAL_MS: '0' })
    owner = new Client(server)
    await owner.signUp('finishedguard@test.dev', 'Finished Guard')
    const canvas = await (await owner.post('/api/canvases', { name: 'REST Finished' })).json()
    canvasId = canvas.id
    const fresh = (await (await owner.get(`/api/canvases/${canvasId}`)).json()) as Canvas
    expect(
      (
        await owner.put(`/api/canvases/${canvasId}/pages`, {
          pages: [
            { id: OPEN, name: 'Open' },
            { id: FIN, name: 'Done' },
          ],
          expectedPages: fresh.pages,
        })
      ).status,
    ).toBe(200)
    const make = async (key: string, pageId: string, extra: Record<string, unknown> = {}) => {
      const res = await owner.post(`/api/canvases/${canvasId}/frames`, {
        name: key,
        html: `<p>${key}</p>`,
        pageId,
        ...extra,
      })
      expect(res.status).toBe(200)
      ids[key] = ((await res.json()) as { id: string }).id
    }
    await make('open', OPEN, { x: 0, y: 0 })
    for (const [i, key] of ['edit', 'move', 'del', 'lockOnly', 'lockHtml', 'lockName', 'lockPage', 'held'].entries())
      await make(key, FIN, { x: 400 * (i + 1), y: 0 })
    await make('trashed', FIN, { x: 4000, y: 0 })
    expect((await owner.delete(`/api/frames/${ids.trashed}`)).status).toBe(200)
    expect((await owner.patch(`/api/frames/${ids.held}`, { locked: true })).status).toBe(200)
    /* a design-sync screen, moved to the Finished page */
    secret = (
      (await (await owner.post(`/api/canvases/${canvasId}/sync-keys`, { name: 'App' })).json()) as { secret: string }
    ).secret
    const synced = await fetch(`${server.base}/ingest/${secret}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ page: '/home', html: '<h1>one</h1>', title: 'Home' }),
    })
    expect(synced.status).toBe(200)
    ids.synced = ((await synced.json()) as { frameId: string }).frameId
    expect((await owner.patch(`/api/frames/${ids.synced}`, { pageId: FIN, x: 9000, y: 0 })).status).toBe(200)

    /* the page flag has no route yet: write it into the database and boot again */
    const dataDir = server.dataDir
    server.stop({ keepData: true })
    await server.stopped
    const db = new PGlite(path.join(dataDir, 'data', 'pg'))
    const pages: CanvasPageInfo[] = [
      { id: OPEN, name: 'Open' },
      { id: FIN, name: 'Done', finished: FINISHED },
    ]
    await db.query('UPDATE canvases SET pages = $1::jsonb WHERE id = $2', [JSON.stringify(pages), canvasId])
    await db.close()
    server = await startServer({ SYNC_PAGE_INTERVAL_MS: '0' }, dataDir)
    owner = new Client(server)
    expect(
      (await owner.post('/api/auth/sign-in/email', { email: 'finishedguard@test.dev', password: 'password12345' }))
        .status,
    ).toBe(200)
  }, 180_000)

  afterAll(() => server?.stop())

  const canvasNow = async () => (await (await owner.get(`/api/canvases/${canvasId}`)).json()) as Canvas
  const rowsOf = (canvas: Canvas) => JSON.stringify(canvas.frames.map((f) => ({ ...f })))
  const trashIds = async () =>
    ((await (await owner.get(`/api/canvases/${canvasId}/trash`)).json()) as { frames: { id: string }[] }).frames.map(
      (f) => f.id,
    )

  async function expectFinished(res: Response) {
    expect(res.status).toBe(409)
    const body = (await res.json()) as { code: string; error: string }
    expect(body.code).toBe('page_finished')
    expect(body.error).toMatch(FINISHED_TEXT)
  }

  it('create, update, move into, move out of and delete answer 409 page_finished; nothing changes', async () => {
    const before = rowsOf(await canvasNow())
    await expectFinished(await owner.post(`/api/canvases/${canvasId}/frames`, { name: 'New', pageId: FIN }))
    await expectFinished(await owner.patch(`/api/frames/${ids.edit}`, { name: 'Renamed' }))
    await expectFinished(await owner.patch(`/api/frames/${ids.edit}`, { html: '<p>new</p>' }))
    await expectFinished(await owner.patch(`/api/frames/${ids.open}`, { pageId: FIN }))
    await expectFinished(await owner.patch(`/api/frames/${ids.move}`, { pageId: OPEN }))
    await expectFinished(await owner.delete(`/api/frames/${ids.del}`))
    expect(rowsOf(await canvasNow())).toBe(before)
  })

  it('trash restore onto a Finished page is refused and the frame stays in the trash', async () => {
    await expectFinished(await owner.post(`/api/frames/${ids.trashed}/restore`))
    expect(await trashIds()).toContain(ids.trashed)
  })

  it('background and flow start on a Finished page answer 409 page_finished', async () => {
    await expectFinished(await owner.put(`/api/canvases/${canvasId}/pages/${FIN}/background`, { color: '#112233' }))
    await expectFinished(await owner.put(`/api/canvases/${canvasId}/pages/${FIN}/flow-start`, { frameId: ids.edit }))
    const pages = (await canvasNow()).pages!
    expect(pages.find((p) => p.id === FIN)).toEqual({ id: FIN, name: 'Done', finished: FINISHED })
  })

  it('REST PATCH {locked:true} locks a frame on a Finished page', async () => {
    const res = await owner.patch(`/api/frames/${ids.lockOnly}`, { locked: true })
    expect(res.status).toBe(200)
    expect(((await res.json()) as Frame).locked).toBe(true)
  })

  it.each([
    ['html', 'lockHtml', { locked: true, html: '<p>sneaky</p>' }],
    ['name', 'lockName', { locked: true, name: 'Sneaky' }],
    ['pageId', 'lockPage', { locked: true, pageId: OPEN }],
  ])('REST PATCH {locked:true, %s} is refused page_finished and locks nothing', async (_name, key, body) => {
    const before = rowsOf(await canvasNow())
    await expectFinished(await owner.patch(`/api/frames/${ids[key]}`, body))
    expect(rowsOf(await canvasNow())).toBe(before)
  })

  it('a locked frame on a Finished page answers 423 first', async () => {
    const res = await owner.patch(`/api/frames/${ids.held}`, { name: 'x' })
    expect(res.status).toBe(423)
    expect(((await res.json()) as { code: string }).code).toBe('policy_refused')
  })

  it('design sync skips a screen on a Finished page, as it skips a locked one', async () => {
    const before = rowsOf(await canvasNow())
    const res = await fetch(`${server.base}/ingest/${secret}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ page: '/home', html: '<h1>two</h1>', title: 'Home' }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, frameId: ids.synced, finished: true })
    expect(rowsOf(await canvasNow())).toBe(before)
  })

  it('an open page in the same canvas still takes writes', async () => {
    const res = await owner.patch(`/api/frames/${ids.open}`, { name: 'Still open' })
    expect(res.status).toBe(200)
  })
})
