import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Canvas, Frame, PageSnapshot } from '../shared/types.ts'

/**
 * Named page snapshots (CHE-5307) over MCP. The real store, actions and
 * snapshot code run; persistence is an in-memory fake with the same contract
 * as `server/db/persist.ts` (blobs keyed by canvas + hash).
 */

const fake = vi.hoisted(() => ({
  snaps: new Map<string, unknown>(),
  blobs: new Map<string, string>(),
  /** held while a test races a writer against the restore */
  beforeGet: null as null | (() => Promise<void>),
  beforeSave: null as null | (() => Promise<void>),
}))

vi.mock('../server/db/persist.ts', () => ({
  saveTask: () => {},
  saveFeedback: () => {},
  saveComment: () => {},
  saveActivity: () => {},
  saveDecision: () => {},
  saveProposal: () => {},
  saveCanvas: () => {},
  saveDeletedPages: () => {},
  saveFrame: () => {},
  saveFrameNow: async () => {},
  saveFrameVersion: () => {},
  deleteFrame: () => {},
  deleteCanvas: () => {},
  listFrameVersions: async () => [],
  getFrameVersion: async () => undefined,
  savePageSnapshot: async (snap: PageSnapshot, html: Map<string, string>) => {
    await fake.beforeSave?.()
    fake.snaps.set(snap.id, structuredClone(snap))
    for (const [hash, body] of html) fake.blobs.set(`${snap.canvasId}:${hash}`, body)
  },
  listPageSnapshots: async (canvasId: string, pageId?: string) =>
    ([...fake.snaps.values()] as PageSnapshot[])
      .filter((s) => s.canvasId === canvasId && (!pageId || s.pageId === pageId))
      .sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1)),
  getPageSnapshot: async (canvasId: string, id: string) => {
    await fake.beforeGet?.()
    const snap = fake.snaps.get(id) as PageSnapshot | undefined
    return snap && snap.canvasId === canvasId ? structuredClone(snap) : undefined
  },
  getSnapshotHtml: async (canvasId: string, hashes: string[]) =>
    new Map(hashes.map((h) => [h, fake.blobs.get(`${canvasId}:${h}`) ?? ''] as const)),
}))
vi.mock('../server/resident.ts', () => ({ onFeedback: () => {} }))
vi.mock('../server/distill.ts', () => ({ onDecision: () => {} }))

const actions = await import('../server/actions.ts')
const { buildMcpServer } = await import('../server/mcp.ts')
const { store } = await import('../server/store.ts')

const OWNER = 'owner-1'
const T0 = 1_700_000_000_000

function seedFrame(id: string, name: string, html: string, over: Partial<Frame> = {}): Frame {
  return {
    id,
    canvasId: 'c1',
    pageId: 'p1',
    name,
    html,
    x: 0,
    y: 0,
    width: 640,
    height: 480,
    createdAt: T0,
    updatedAt: T0,
    updatedBy: 'alice',
    ...over,
  }
}

function seed(linkAccess?: Canvas['linkAccess']) {
  const canvas: Canvas = {
    id: 'c1',
    name: 'Snapshots',
    ownerId: OWNER,
    linkAccess,
    createdAt: 0,
    updatedAt: 0,
    pages: [
      { id: 'p1', name: 'Page 1' },
      { id: 'p2', name: 'Page 2' },
    ],
    frames: [
      seedFrame('f1', 'Hero', '<h1>Hero</h1>'),
      seedFrame('f2', 'Footer', '<p>Footer</p>', { createdAt: T0 + 1 }),
      seedFrame('f3', 'Other page', '<p>elsewhere</p>', { pageId: 'p2', createdAt: T0 + 2 }),
    ],
  }
  store.deleteCanvas('c1') // the store keeps a canvas's trash across init
  store.init([canvas])
  actions.wire(
    () => {},
    () => {},
  )
}

beforeEach(() => {
  fake.snaps.clear()
  fake.blobs.clear()
  fake.beforeGet = null
  fake.beforeSave = null
  seed()
})

async function connect(userId = OWNER) {
  const server = buildMcpServer('Test Owner', userId)
  const client = new Client({ name: 'doop-snapshot-test', version: '1.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  return client
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const result = (await client.callTool({ name, arguments: { agent_name: 'Claude', ...args } })) as unknown as {
    content: Array<{ type: string; text?: string }>
    isError?: boolean
  }
  const body = result.content.map((block) => block.text ?? '').join('\n')
  // eslint-disable-next-line typescript/no-explicit-any -- tool replies are loose JSON the assertions walk
  let json: any
  try {
    json = JSON.parse(body)
  } catch {
    json = undefined
  }
  return { text: body, json, isError: !!result.isError }
}

const snapshot = (client: Client, name: string) =>
  call(client, 'create_page_snapshot', { canvas_id: 'c1', page_id: 'p1', name })
const frame = (id: string) => store.getFrame(id)!

describe('create_page_snapshot and list_page_snapshots', () => {
  it('files a named snapshot of one page and lists it with author, time and frame states, without html', async () => {
    const client = await connect()
    const made = await snapshot(client, 'before redesign')
    expect(made.isError).toBe(false)
    expect(made.json).toMatchObject({ ok: true, snapshot: { name: 'before redesign', pageId: 'p1', author: 'Claude' } })

    const listed = await call(client, 'list_page_snapshots', { canvas_id: 'c1', page_id: 'p1' })
    expect(listed.isError).toBe(false)
    expect(listed.json.snapshots).toHaveLength(1)
    const [snap] = listed.json.snapshots
    expect(snap).toMatchObject({
      id: made.json.snapshot.id,
      name: 'before redesign',
      pageName: 'Page 1',
      author: 'Claude',
    })
    expect(typeof snap.createdAt).toBe('number')
    expect(snap.frames.map((f: { frameId: string }) => f.frameId).sort()).toEqual(['f1', 'f2'])
    expect(snap.frames.find((f: { frameId: string }) => f.frameId === 'f1')).toMatchObject({
      name: 'Hero',
      width: 640,
      height: 480,
      htmlBytes: '<h1>Hero</h1>'.length,
    })
    expect(listed.text).not.toContain('<h1>Hero</h1>')
  })

  it('lists newest first and only the asked page', async () => {
    const client = await connect()
    await snapshot(client, 'one')
    await new Promise((r) => setTimeout(r, 3))
    await snapshot(client, 'two')
    await call(client, 'create_page_snapshot', { canvas_id: 'c1', page_id: 'p2', name: 'other' })
    const p1 = await call(client, 'list_page_snapshots', { canvas_id: 'c1', page_id: 'p1' })
    expect(p1.json.snapshots.map((s: { name: string }) => s.name)).toEqual(['two', 'one'])
    const all = await call(client, 'list_page_snapshots', { canvas_id: 'c1' })
    expect(all.json.snapshots).toHaveLength(3)
  })

  it('refuses an unknown page', async () => {
    const out = await call(await connect(), 'create_page_snapshot', { canvas_id: 'c1', page_id: 'nope', name: 'x' })
    expect(out.isError).toBe(true)
    expect(out.text).toMatch(/unknown page/i)
  })
})

describe('compare_page_snapshots', () => {
  it('reports frames added, removed and changed, with sizes', async () => {
    const client = await connect()
    const a = await snapshot(client, 'A')
    actions.updateFrame(
      'f2',
      { html: '<p>Footer, longer now</p>' },
      actions.resolveActor({ name: 'Claude', kind: 'agent' }),
    )
    actions.deleteFrame('f1', actions.resolveActor({ name: 'Claude', kind: 'agent' }))
    const added = actions.createFrame(
      'c1',
      { name: 'New', html: '<b>new</b>', pageId: 'p1' },
      actions.resolveActor({ name: 'Claude', kind: 'agent' }),
    )
    const b = await snapshot(client, 'B')

    const diff = await call(client, 'compare_page_snapshots', {
      canvas_id: 'c1',
      snapshot_id: a.json.snapshot.id,
      other_snapshot_id: b.json.snapshot.id,
    })
    expect(diff.isError).toBe(false)
    expect(diff.json.added.map((f: { frameId: string }) => f.frameId)).toEqual([added!.id])
    expect(diff.json.added[0]).toMatchObject({ name: 'New', htmlBytes: '<b>new</b>'.length })
    expect(diff.json.removed.map((f: { frameId: string }) => f.frameId)).toEqual(['f1'])
    expect(diff.json.removed[0]).toMatchObject({ name: 'Hero', htmlBytes: '<h1>Hero</h1>'.length })
    expect(diff.json.changed).toHaveLength(1)
    expect(diff.json.changed[0]).toMatchObject({
      frameId: 'f2',
      before: { htmlBytes: '<p>Footer</p>'.length },
      after: { htmlBytes: '<p>Footer, longer now</p>'.length },
    })
  })

  it('compares a snapshot with the live page when no second id is given', async () => {
    const client = await connect()
    const a = await snapshot(client, 'A')
    actions.updateFrame('f1', { width: 800 }, actions.resolveActor({ name: 'Claude', kind: 'agent' }))
    const diff = await call(client, 'compare_page_snapshots', { canvas_id: 'c1', snapshot_id: a.json.snapshot.id })
    expect(diff.json.changed).toHaveLength(1)
    expect(diff.json.changed[0]).toMatchObject({ frameId: 'f1', before: { width: 640 }, after: { width: 800 } })
    expect(diff.json.added).toEqual([])
    expect(diff.json.removed).toEqual([])
  })
})

describe('restore_page_snapshot', () => {
  const actor = () => actions.resolveActor({ name: 'Claude', kind: 'agent' })

  it('puts html, size and name back, and brings back a frame deleted since', async () => {
    const client = await connect()
    const a = await snapshot(client, 'A')
    actions.updateFrame('f2', { html: '<p>changed</p>', width: 100, name: 'Renamed' }, actor())
    actions.deleteFrame('f1', actor())

    const out = await call(client, 'restore_page_snapshot', { canvas_id: 'c1', snapshot_id: a.json.snapshot.id })
    expect(out.isError).toBe(false)
    expect(frame('f2')).toMatchObject({ html: '<p>Footer</p>', width: 640, name: 'Footer' })
    expect(frame('f1')).toMatchObject({ html: '<h1>Hero</h1>' })
    expect(out.json.restored.map((f: { frameId: string }) => f.frameId).sort()).toEqual(['f1', 'f2'])
    expect(out.json.skipped).toEqual([])
  })

  it('files the current state first, so the restore is reversible', async () => {
    const client = await connect()
    const a = await snapshot(client, 'A')
    actions.updateFrame('f1', { html: '<h1>Edited after A</h1>' }, actor())

    const out = await call(client, 'restore_page_snapshot', { canvas_id: 'c1', snapshot_id: a.json.snapshot.id })
    expect(frame('f1').html).toBe('<h1>Hero</h1>')
    const safety = out.json.safetySnapshot
    expect(safety).toMatchObject({ pageId: 'p1' })
    expect(safety.name).toMatch(/before restoring “A”/i)

    const back = await call(client, 'restore_page_snapshot', { canvas_id: 'c1', snapshot_id: safety.id })
    expect(back.isError).toBe(false)
    expect(frame('f1').html).toBe('<h1>Edited after A</h1>')
  })

  it('skips a locked frame, reports it and leaves its html, size and stamp alone', async () => {
    const client = await connect()
    const a = await snapshot(client, 'A')
    actions.updateFrame('f1', { html: '<h1>Locked edit</h1>', height: 300 }, actor())
    actions.updateFrame('f1', { locked: true }, actor())
    actions.updateFrame('f2', { html: '<p>changed</p>' }, actor())
    const stamp = frame('f1').updatedAt

    const out = await call(client, 'restore_page_snapshot', { canvas_id: 'c1', snapshot_id: a.json.snapshot.id })
    expect(out.isError).toBe(false)
    expect(out.json.skipped).toEqual([{ frameId: 'f1', name: 'Hero', reason: 'locked' }])
    expect(out.json.restored.map((f: { frameId: string }) => f.frameId)).toEqual(['f2'])
    expect(frame('f1')).toMatchObject({
      html: '<h1>Locked edit</h1>',
      width: 640,
      height: 300,
      updatedAt: stamp,
      locked: true,
    })
    expect(frame('f2').html).toBe('<p>Footer</p>')
  })

  it('leaves a locked frame that is in the trash in the trash', async () => {
    const client = await connect()
    const a = await snapshot(client, 'A')
    actions.updateFrame('f1', { locked: true }, actor())
    actions.deleteFrame('f1', actor())
    const out = await call(client, 'restore_page_snapshot', { canvas_id: 'c1', snapshot_id: a.json.snapshot.id })
    expect(out.json.skipped).toEqual([{ frameId: 'f1', name: 'Hero', reason: 'locked' }])
    expect(store.getFrame('f1')).toBeUndefined()
    expect(store.getDeletedFrame('f1')).toBeDefined()
  })

  it('does not take a frame that a concurrent writer locked while the snapshot was loading', async () => {
    const client = await connect()
    const a = await snapshot(client, 'A')
    actions.updateFrame('f1', { html: '<h1>Before race</h1>' }, actor())
    let release!: () => void
    fake.beforeGet = () => new Promise<void>((resolve) => (release = resolve))

    const pending = call(client, 'restore_page_snapshot', { canvas_id: 'c1', snapshot_id: a.json.snapshot.id })
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    // the writer wins the race: new html, then the lock
    actions.updateFrame('f1', { html: '<h1>Racer</h1>', width: 111 }, actor())
    actions.updateFrame('f1', { locked: true }, actor())
    const stamp = frame('f1').updatedAt
    fake.beforeGet = null
    release()

    const out = await pending
    expect(out.isError).toBe(false)
    expect(out.json.skipped).toEqual([{ frameId: 'f1', name: 'Hero', reason: 'locked' }])
    expect(frame('f1')).toMatchObject({ html: '<h1>Racer</h1>', width: 111, updatedAt: stamp })
  })

  it('does not take a frame that a writer locks while the safety snapshot is being filed, and the safety snapshot holds the racer', async () => {
    const client = await connect()
    const a = await snapshot(client, 'A')
    let release!: () => void
    let held = false
    fake.beforeSave = () => {
      if (held) return Promise.resolve()
      held = true
      return new Promise<void>((resolve) => (release = resolve))
    }

    const pending = call(client, 'restore_page_snapshot', { canvas_id: 'c1', snapshot_id: a.json.snapshot.id })
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    actions.updateFrame('f2', { html: '<p>Racer</p>' }, actor())
    actions.updateFrame('f2', { locked: true }, actor())
    release()

    const out = await pending
    expect(out.isError).toBe(false)
    expect(out.json.skipped).toEqual([{ frameId: 'f2', name: 'Footer', reason: 'locked' }])
    expect(frame('f2').html).toBe('<p>Racer</p>')
    const safety = fake.snaps.get(out.json.safetySnapshot.id) as PageSnapshot
    const racerHash = safety.frames.find((f) => f.frameId === 'f2')!.hash
    expect(fake.blobs.get(`c1:${racerHash}`)).toBe('<p>Racer</p>')
  })

  it('refuses a snapshot of another canvas', async () => {
    const client = await connect()
    const out = await call(client, 'restore_page_snapshot', { canvas_id: 'c1', snapshot_id: 'missing' })
    expect(out.isError).toBe(true)
    expect(out.text).toMatch(/unknown snapshot/i)
  })
})

describe('access follows canvas access', () => {
  it('lets a view-link visitor list and compare, but not create or restore', async () => {
    seed('view')
    const owner = await connect(OWNER)
    const a = await snapshot(owner, 'A')
    const visitor = await connect('visitor-1')

    expect((await call(visitor, 'list_page_snapshots', { canvas_id: 'c1' })).isError).toBe(false)
    expect(
      (await call(visitor, 'compare_page_snapshots', { canvas_id: 'c1', snapshot_id: a.json.snapshot.id })).isError,
    ).toBe(false)
    expect((await snapshot(visitor, 'mine')).isError).toBe(true)
    actions.updateFrame('f1', { html: '<h1>changed</h1>' }, actions.resolveActor({ name: 'x', kind: 'agent' }))
    const restore = await call(visitor, 'restore_page_snapshot', { canvas_id: 'c1', snapshot_id: a.json.snapshot.id })
    expect(restore.isError).toBe(true)
    expect(frame('f1').html).toBe('<h1>changed</h1>')
  })

  it('shows nothing to an account with no access', async () => {
    const owner = await connect(OWNER)
    const a = await snapshot(owner, 'A')
    const stranger = await connect('stranger-1')
    for (const [tool, args] of [
      ['list_page_snapshots', {}],
      ['compare_page_snapshots', { snapshot_id: a.json.snapshot.id }],
      ['restore_page_snapshot', { snapshot_id: a.json.snapshot.id }],
      ['create_page_snapshot', { page_id: 'p1', name: 'x' }],
    ] as const) {
      expect((await call(stranger, tool, { canvas_id: 'c1', ...args })).isError).toBe(true)
    }
  })
})
