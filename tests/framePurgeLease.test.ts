import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { cpSync } from 'node:fs'
import { count } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest'
import { Client } from './harness.ts'
import type { Actor, ElementComment, Frame, ServerMessage } from '../shared/types.ts'

/*
 * CHE-9399 step 2 (P1b): the purge lease, its finalizer, the restore refusals and the `purge_frame` write op.
 * No route calls `beginPurge` yet, so a test opens the lease itself (the "test hook"): the REAL server boots in
 * this process (so the REST routes and the store share one module instance with the test), on a copy of the
 * migrated PGlite template. Only `savePageSnapshot` and `commentWritesPending` get a hook; everything else in
 * persist is the real module.
 */

const rig = await vi.hoisted(async () => {
  const { createServer } = await import('node:net')
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const port = await new Promise<number>((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      probe.close(() => resolve(typeof address === 'object' && address ? address.port : 0))
    })
  })
  const dir = mkdtempSync(join(tmpdir(), 'doop-purge-lease-'))
  Object.assign(process.env, {
    PORT: String(port),
    BETTER_AUTH_URL: `http://localhost:${port}`,
    DATABASE_URL: '',
    POSTHOG_KEY: '',
    VITE_POSTHOG_KEY: '',
    DOOP_WRITE_BOUNDARY: 'throw',
  })
  delete process.env.NODE_ENV
  return {
    port,
    dir,
    /** runs inside `savePageSnapshot`, once, while a restore waits for its safety snapshot */
    duringSave: null as null | (() => void),
    /** per-frame override of `persist.commentWritesPending` */
    pendingComments: new Map<string, number>(),
  }
})

vi.mock('../server/db/persist.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/db/persist.ts')>()
  return {
    ...actual,
    savePageSnapshot: async (...args: Parameters<typeof actual.savePageSnapshot>) => {
      const hook = rig.duringSave
      rig.duringSave = null
      hook?.()
      return actual.savePageSnapshot(...args)
    },
    commentWritesPending: (frameId: string) => rig.pendingComments.get(frameId) ?? actual.commentWritesPending(frameId),
  }
})
vi.mock('../server/resident.ts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  onFeedback: () => {},
}))
vi.mock('../server/distill.ts', () => ({ onDecision: () => {} }))

const { store, PurgeInProgressError } = await import('../server/store.ts')
const actions = await import('../server/actions.ts')
const { assertWritable, systemContext, userContext, FrameLockedError, PolicyRefused } =
  await import('../server/writePolicy.ts')
const { transaction, WriteBoundaryError } = await import('../server/journal.ts')
const persist = await import('../server/db/persist.ts')
const { pageSnapshots, snapshotBlobs, frames: frameRows } = await import('../server/db/schema.ts')
const { canvasPages } = await import('../shared/pages.ts')
const { buildMcpServer } = await import('../server/mcp.ts')

type Lease = ReturnType<typeof store.beginPurge>
type PurgeEvent = Parameters<Parameters<typeof store.beginPurge>[4]>[0]

const ctxOf = () => userContext(ownerId)
let ownerId = ''
let owner: Client
let canvasId = ''
let pageId = ''
let mcp: McpClient
const live = { base: `http://localhost:${rig.port}`, port: rig.port }

beforeAll(async () => {
  cpSync(inject('templateDir'), rig.dir, { recursive: true })
  process.chdir(rig.dir) // PGlite lives in <cwd>/data
  await import('../server/index.ts')
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(`${live.base}/healthz`)).ok) break
    } catch {
      /* not up yet */
    }
    if (i > 600) throw new Error('server did not boot')
    await new Promise((r) => setTimeout(r, 50))
  }
  owner = await new Client(live as never).signUp('purge-owner@test.dev', 'Owner')
  const session = (await (await owner.get('/api/auth/get-session')).json()) as { user: { id: string } }
  ownerId = session.user.id
  const canvas = await (await owner.post('/api/canvases', { name: 'Purge lease' })).json()
  canvasId = canvas.id
  pageId = canvas.pages[0].id
  const server = buildMcpServer('Owner', ownerId)
  mcp = new McpClient({ name: 'purge-lease-test', version: '1.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await mcp.connect(clientTransport)
}, 120_000)

afterAll(() => {
  rig.duringSave = null
})

async function call(name: string, args: Record<string, unknown>) {
  const result = (await mcp.callTool({ name, arguments: { agent_name: 'Claude', ...args } })) as unknown as {
    content: Array<{ type: string; text?: string }>
    isError?: boolean
  }
  const text = result.content.map((block) => block.text ?? '').join('\n')
  let json: Record<string, any> | undefined // eslint-disable-line typescript/no-explicit-any -- loose tool JSON
  try {
    json = JSON.parse(text)
  } catch {
    json = undefined
  }
  return { text, json, isError: !!result.isError }
}

/** a live frame, made through the REST route */
async function makeFrame(name: string, html = `<p>${name}</p>`, onPage = pageId): Promise<Frame> {
  const res = await owner.post(`/api/canvases/${canvasId}/frames`, { name, html, pageId: onPage })
  expect(res.status).toBe(200)
  return res.json()
}

/** a frame in the Trash, deleted through the REST route */
async function makeTrashed(name: string, onPage = pageId): Promise<Frame> {
  const frame = await makeFrame(name, `<p>${name}</p>`, onPage)
  expect((await owner.delete(`/api/frames/${frame.id}`)).status).toBe(200)
  return store.getDeletedFrame(frame.id)!
}

function lease(frame: Frame, hasComments: () => boolean = () => false, notify: (e: PurgeEvent) => void = () => {}) {
  return transaction(() => store.beginPurge(ctxOf(), frame.id, frame.deletedAt!, hasComments, notify))
}

const receiptOf = (frame: Frame) => ({
  frameId: frame.id,
  canvasId: frame.canvasId,
  deletedAt: frame.deletedAt!,
  versionIds: [],
  writeKeyIds: [],
  assetRefIds: [],
})

/** everything a refused restore must leave alone: rows, memory, Trash, snapshots and blobs */
async function stateOf() {
  const { db } = await import('../server/db/index.ts')
  const [snapshots] = await db.select({ n: count() }).from(pageSnapshots)
  const [blobs] = await db.select({ n: count() }).from(snapshotBlobs)
  const rows = (await db.select().from(frameRows)).sort((a, b) => (a.id < b.id ? -1 : 1))
  return JSON.stringify({
    snapshots: snapshots!.n,
    blobs: blobs!.n,
    rows,
    memory: store.getCanvas(canvasId)!.frames,
    trash: store.listTrash(canvasId),
  })
}

const safetySnapshots = async () =>
  (await persist.listPageSnapshots(canvasId)).filter((s) => s.name.startsWith('before restoring'))

describe('T4u restore refusals while a lease is open', () => {
  it('(a) each caller answers its own native refusal and changes nothing; after release each succeeds', async () => {
    /* one trashed frame per caller: REST frame, REST page, MCP frame, MCP page, MCP snapshot */
    const restFrame = await makeTrashed('rest frame')
    const mcpFrame = await makeTrashed('mcp frame')
    const snapFrame = await makeFrame('snap frame')
    const snapshot = await call('create_page_snapshot', {
      canvas_id: canvasId,
      page_id: pageId,
      name: 'with snap frame',
    })
    expect(snapshot.isError).toBe(false)
    expect((await owner.delete(`/api/frames/${snapFrame.id}`)).status).toBe(200)

    const pageOf = async (name: string) => {
      const id = `page-${name}`
      const pages = canvasPages(store.getCanvas(canvasId)!)
      expect(
        (await owner.put(`/api/canvases/${canvasId}/pages`, { pages: [...pages, { id, name }], expectedPages: pages }))
          .status,
      ).toBe(200)
      const frame = await makeTrashed(`${name} frame`, id)
      const kept = canvasPages(store.getCanvas(canvasId)!)
      expect(
        (
          await owner.put(`/api/canvases/${canvasId}/pages`, {
            pages: kept.filter((p) => p.id !== id),
            expectedPages: kept,
          })
        ).status,
      ).toBe(200)
      return { id, frame }
    }
    const restPage = await pageOf('rest page')
    const mcpPage = await pageOf('mcp page')

    const leases = [restFrame, mcpFrame, restPage.frame, mcpPage.frame, store.getDeletedFrame(snapFrame.id)!].map((f) =>
      lease(f),
    )
    const before = await stateOf()
    const unchanged = async () => expect(await stateOf()).toBe(before)

    const restFrameRes = await owner.post(`/api/frames/${restFrame.id}/restore`)
    expect(restFrameRes.status).toBe(409) // not 423: PurgeInProgressError is not a PolicyRefused
    expect(await restFrameRes.json()).toEqual({
      error: `purge_in_progress: frame ${restFrame.id} is being deleted forever; nothing changed`,
      code: 'purge_in_progress',
    })
    await unchanged()

    const restPageRes = await owner.post(`/api/canvases/${canvasId}/pages/${restPage.id}/restore`)
    expect(restPageRes.status).toBe(409)
    expect(await restPageRes.json()).toMatchObject({ code: 'purge_in_progress' })
    await unchanged()

    const mcpFrameOut = await call('restore_frame', { frame_id: mcpFrame.id })
    expect(mcpFrameOut.isError).toBe(true)
    expect(mcpFrameOut.text).toBe(
      `Error: purge_in_progress: frame ${mcpFrame.id} is being deleted forever; nothing changed`,
    )
    await unchanged()

    const mcpPageOut = await call('restore_page', { canvas_id: canvasId, page_id: mcpPage.id })
    expect(mcpPageOut.isError).toBe(true)
    expect(mcpPageOut.text).toMatch(/^Error: purge_in_progress:/)
    await unchanged()

    const snapOut = await call('restore_page_snapshot', {
      canvas_id: canvasId,
      snapshot_id: snapshot.json!.snapshot.id,
    })
    expect(snapOut.isError).toBe(true)
    expect(snapOut.text).toMatch(/^Error: purge_in_progress:/)
    await unchanged()
    for (const f of [restFrame, mcpFrame, restPage.frame, mcpPage.frame, snapFrame]) {
      expect(store.getDeletedFrame(f.id)).toBeDefined() // still in Trash
    }

    for (const l of leases) l.release()
    expect((await owner.post(`/api/frames/${restFrame.id}/restore`)).status).toBe(200)
    expect((await owner.post(`/api/canvases/${canvasId}/pages/${restPage.id}/restore`)).status).toBe(200)
    expect((await call('restore_frame', { frame_id: mcpFrame.id })).isError).toBe(false)
    expect((await call('restore_page', { canvas_id: canvasId, page_id: mcpPage.id })).isError).toBe(false)
    const snapAfter = await call('restore_page_snapshot', {
      canvas_id: canvasId,
      snapshot_id: snapshot.json!.snapshot.id,
    })
    expect(snapAfter.isError).toBe(false)
    expect(store.getFrame(snapFrame.id)).toBeDefined()
  }, 60_000)

  it('(b) a lease opened while the safety snapshot is filed skips that frame, restores the rest, files once', async () => {
    const kept = await makeFrame('kept', '<p>old kept</p>')
    const gone = await makeFrame('gone', '<p>old gone</p>')
    const snap = await call('create_page_snapshot', { canvas_id: canvasId, page_id: pageId, name: 'b' })
    expect((await owner.delete(`/api/frames/${gone.id}`)).status).toBe(200)
    actions.updateFrame(kept.id, { html: '<p>changed kept</p>' }, actions.resolveActor({ name: 'Ada', kind: 'user' }))
    const trashed = store.getDeletedFrame(gone.id)!
    const filedBefore = (await safetySnapshots()).length
    let opened: Lease | undefined
    rig.duringSave = () => {
      opened = lease(trashed)
    }
    const out = await call('restore_page_snapshot', { canvas_id: canvasId, snapshot_id: snap.json!.snapshot.id })
    expect(out.isError).toBe(false)
    expect(out.json!.skipped).toContainEqual({ frameId: gone.id, name: 'gone', reason: 'purging' })
    expect(store.getDeletedFrame(gone.id)).toBe(trashed) // unchanged, still in Trash
    expect(store.getFrame(gone.id)).toBeUndefined()
    expect(store.getFrame(kept.id)!.html).toBe('<p>old kept</p>') // the rest applied
    expect((await safetySnapshots()).length - filedBefore).toBe(1)
    opened!.release()
  }, 30_000)

  it('(c) a purge that commits while the safety snapshot is filed: filed again, frame skipped as absent', async () => {
    const gone = await makeFrame('gone c', '<p>old</p>')
    const snap = await call('create_page_snapshot', { canvas_id: canvasId, page_id: pageId, name: 'c' })
    expect((await owner.delete(`/api/frames/${gone.id}`)).status).toBe(200)
    const trashed = store.getDeletedFrame(gone.id)!
    const filedBefore = (await safetySnapshots()).length
    rig.duringSave = () => {
      const l = lease(trashed)
      actions.finishCommitted(l, receiptOf(trashed))
    }
    const out = await call('restore_page_snapshot', { canvas_id: canvasId, snapshot_id: snap.json!.snapshot.id })
    expect(out.isError).toBe(false)
    expect(JSON.stringify(out.json!.skipped)).not.toContain(gone.id)
    expect(JSON.stringify(out.json!.restored)).not.toContain(gone.id)
    expect(store.getFrame(gone.id)).toBeUndefined()
    expect(store.getDeletedFrame(gone.id)).toBeUndefined()
    expect((await safetySnapshots()).length - filedBefore).toBe(2)
  }, 30_000)
})

describe('T4v purge-state broadcasts', () => {
  it('sends purging true at beginPurge and false at release, and a throwing notify does not stop release', async () => {
    const f = await makeTrashed('state')
    const sent: PurgeEvent[] = []
    const l = lease(
      f,
      () => false,
      (e) => sent.push(e),
    )
    expect(sent).toEqual([{ type: 'trash:purge_state', frameId: f.id, canvasId, purging: true }])
    expect(store.listTrash(canvasId).frames.find((x) => x.id === f.id)).toMatchObject({ purging: true })
    l.release()
    expect(sent.at(-1)).toEqual({ type: 'trash:purge_state', frameId: f.id, canvasId, purging: false })
    expect(store.listTrash(canvasId).frames.find((x) => x.id === f.id)).not.toHaveProperty('purging')
    await expect(l.outcome).resolves.toBe('kept')

    const g = await makeTrashed('state throws')
    const boom = lease(
      g,
      () => false,
      () => {
        throw new Error('socket gone')
      },
    )
    expect(() => boom.release()).not.toThrow()
    expect(store.listTrash(canvasId).frames.find((x) => x.id === g.id)).not.toHaveProperty('purging')
    await expect(boom.outcome).resolves.toBe('kept')
    expect(() => lease(g)).not.toThrow() // the mark and the fence are gone: a new lease opens
  })
})

describe('T8u the purge_frame write op', () => {
  const frame = { id: 'f', locked: false } as Frame
  const canvas = () => store.getCanvas(canvasId)!

  it('refuses an agent, a sync key and the system; a user passes', () => {
    const target = () => ({ canvas: canvas(), frame, pageIds: [pageId] })
    expect(() => assertWritable({ kind: 'agent' }, 'purge_frame', target())).toThrow(PolicyRefused)
    expect(() => assertWritable({ kind: 'agent', origin: 'mcp' }, 'purge_frame', target())).toThrow(PolicyRefused)
    expect(() => assertWritable({ kind: 'agent', origin: 'sync' }, 'purge_frame', target())).toThrow(PolicyRefused)
    expect(() => assertWritable(systemContext(), 'purge_frame', target())).toThrow(PolicyRefused)
    expect(() => assertWritable(userContext('someone'), 'purge_frame', target())).not.toThrow()
  })

  it('applies the lock rule to a user', () => {
    const locked = { id: 'f', locked: true } as Frame
    expect(() => assertWritable(userContext('someone'), 'purge_frame', { canvas: canvas(), frame: locked })).toThrow(
      FrameLockedError,
    )
  })

  it('beginPurge refuses an agent context before any change', async () => {
    const f = await makeTrashed('agent refused')
    expect(() =>
      transaction(() =>
        store.beginPurge(
          { kind: 'agent' },
          f.id,
          f.deletedAt!,
          () => false,
          () => {},
        ),
      ),
    ).toThrow(PolicyRefused)
    expect(store.listTrash(canvasId).frames.find((x) => x.id === f.id)).not.toHaveProperty('purging')
  })
})

describe('T12u the finalizer', () => {
  it('runs once, survives a throwing broadcast, and takes the frame out of the Trash', async () => {
    const f = await makeTrashed('finalize')
    const sent: PurgeEvent[] = []
    let throwOnPurged = true
    const l = lease(
      f,
      () => false,
      (e) => {
        sent.push(e)
        if (e.type === 'frame:purged' && throwOnPurged) throw new Error('socket gone')
      },
    )
    const first = actions.finishCommitted(l, receiptOf(f))
    const second = actions.finishCommitted(l, receiptOf(f))
    expect(second).toBe(first)
    expect(sent.filter((e) => e.type === 'frame:purged')).toEqual([{ type: 'frame:purged', frameId: f.id, canvasId }])
    expect(sent.at(-1)!.type).toBe('frame:purged')
    expect(store.listTrash(canvasId).frames.some((x) => x.id === f.id)).toBe(false)
    expect(store.getDeletedFrame(f.id)).toBeUndefined()
    await expect(l.outcome).resolves.toBe('purged')
    expect(l.receipt).toEqual(receiptOf(f))
    throwOnPurged = false
    expect(actions.getActivity(canvasId).filter((a) => a.message === `deleted frame “${f.name}” forever`)).toHaveLength(
      1,
    )
    l.release() // after the commit a release is a no-op
    await expect(l.outcome).resolves.toBe('purged')
  })

  it('removes only the same frame object from the Trash', async () => {
    const f = await makeTrashed('same object')
    const l = lease(f)
    /* the Trash entry is replaced by another frame object with the same id: the finalizer leaves it */
    const entry = (store as unknown as { trash: Map<string, { frames: Frame[] }> }).trash.get(canvasId)!
    const swapped = { ...f }
    entry.frames = entry.frames.map((x) => (x === f ? swapped : x))
    actions.finishCommitted(l, receiptOf(f))
    expect(store.getDeletedFrame(f.id)).toBe(swapped)
    entry.frames = entry.frames.filter((x) => x !== swapped)
    ;(store as unknown as { deletedIndex: Map<string, string> }).deletedIndex.delete(f.id)
  })
})

describe('T12u finalizer: receipt, rollback and boundary', () => {
  const activityOf = (f: Frame) =>
    actions.getActivity(canvasId).filter((a) => a.message === `deleted frame “${f.name}” forever`)

  it('a receipt set before COMMIT is not a completion marker: the finalizer still finishes once', async () => {
    const f = await makeTrashed('pre-commit receipt')
    const l = lease(f)
    l.receipt = receiptOf(f) // what the commit path sets before COMMIT
    expect(store.purgeFinalized(l)).toBe(false)
    actions.finishCommitted(l, receiptOf(f))
    expect(store.purgeFinalized(l)).toBe(true)
    expect(store.getDeletedFrame(f.id)).toBeUndefined()
    await expect(l.outcome).resolves.toBe('purged')
    expect(activityOf(f)).toHaveLength(1)
    actions.finishCommitted(l, receiptOf(f))
    expect(activityOf(f)).toHaveLength(1)
  })

  it('a finalizer inside an outer transaction that is rolled back keeps its activity line and its outcome', async () => {
    const f = await makeTrashed('outer rollback')
    const l = lease(f)
    expect(() =>
      transaction(() => {
        actions.finishCommitted(l, receiptOf(f))
        throw new Error('outer failed')
      }),
    ).toThrow('outer failed')
    expect(store.getDeletedFrame(f.id)).toBeUndefined()
    await expect(l.outcome).resolves.toBe('purged')
    expect(activityOf(f)).toHaveLength(1)
  })

  it('beginPurge outside any write boundary throws before any change', async () => {
    const f = await makeTrashed('no boundary')
    expect(() =>
      store.beginPurge(
        ctxOf(),
        f.id,
        f.deletedAt!,
        () => false,
        () => {},
      ),
    ).toThrow(WriteBoundaryError)
    expect(store.isPurging(f.id)).toBe(false)
    lease(f).release() // the fence was never raised, so a clean lease opens and closes
  })

  it('beginPurge refuses a component main frame before fencing, and changes nothing', async () => {
    const f = await makeTrashed('component main')
    const canvas = store.getCanvas(canvasId)!
    const before = JSON.stringify(store.listTrash(canvasId))
    const sent: PurgeEvent[] = []
    canvas.components = [{ id: 'cmp-main', mainFrameId: f.id } as unknown as NonNullable<typeof canvas.components>[0]]
    try {
      expect(() =>
        transaction(() =>
          store.beginPurge(
            ctxOf(),
            f.id,
            f.deletedAt!,
            () => false,
            (e) => sent.push(e),
          ),
        ),
      ).toThrow(/component_main/)
      expect(store.isPurging(f.id)).toBe(false)
      expect(sent).toEqual([])
      expect(JSON.stringify(store.listTrash(canvasId))).toBe(before)
    } finally {
      delete canvas.components
    }
    lease(f).release() // no fence was left behind, and once the main is gone the purge may open
  })
})

describe('T14a beginPurge refuses frames with comments', () => {
  const frameInTrash = (id: string) => store.listTrash(canvasId).frames.find((x) => x.id === id)

  async function expectRefused(f: Frame, hasComments: () => boolean) {
    const sent: PurgeEvent[] = []
    expect(() => lease(f, hasComments, (e) => sent.push(e))).toThrow(/has_comments/)
    expect(sent).toEqual([]) // nothing sent
    expect(frameInTrash(f.id)).not.toHaveProperty('purging')
    expect(store.getDeletedFrame(f.id)).toBe(frameInTrash(f.id) && store.getDeletedFrame(f.id))
  }

  /** no mark and no fence left behind: a clean lease opens at once */
  const expectClean = (f: Frame) => lease(f).release()

  it('a hasComments callback that says yes', async () => {
    const f = await makeTrashed('callback')
    await expectRefused(f, () => true)
    expectClean(f)
  })

  it('an in-memory root or reply with frameId === F (actions.commentsOnFrame)', async () => {
    const f = await makeTrashed('memory comments')
    expect(actions.commentsOnFrame(canvasId, f.id)).toBe(false)
    const root = (await actions.addCanvasComment(canvasId, { pageId, x: 1, y: 1, text: 'note' }, 'Ada'))!
    const list = actions.getComments(canvasId)
    const onFrame = { ...root, id: 'synthetic-root', frameId: f.id } satisfies ElementComment
    list.push(onFrame)
    try {
      expect(actions.commentsOnFrame(canvasId, f.id)).toBe(true)
      expect(actions.commentsOnFrame('another-canvas', f.id)).toBe(false)
      await expectRefused(f, () => actions.commentsOnFrame(canvasId, f.id))
    } finally {
      list.splice(list.indexOf(onFrame), 1)
    }
    const reply = { ...root, id: 'synthetic-reply', parentId: root.id, frameId: f.id } satisfies ElementComment
    list.push(reply)
    try {
      expect(actions.commentsOnFrame(canvasId, f.id)).toBe(true)
      await expectRefused(f, () => actions.commentsOnFrame(canvasId, f.id))
    } finally {
      list.splice(list.indexOf(reply), 1)
    }
    expect(actions.commentsOnFrame(canvasId, f.id)).toBe(false)
    expectClean(f)
  })

  it('a comment write still on its way to the database (commentWritesPending > 0)', async () => {
    const f = await makeTrashed('pending comment')
    rig.pendingComments.set(f.id, 1)
    try {
      await expectRefused(f, () => false)
    } finally {
      rig.pendingComments.delete(f.id)
    }
    expectClean(f)
  })

  it('refusals other than comments: not in Trash, stale deletedAt, already purging', async () => {
    const f = await makeTrashed('other refusals')
    const liveFrame = await makeFrame('live')
    expect(() =>
      transaction(() =>
        store.beginPurge(
          ctxOf(),
          liveFrame.id,
          1,
          () => false,
          () => {},
        ),
      ),
    ).toThrow(/not_in_trash/)
    expect(() =>
      transaction(() =>
        store.beginPurge(
          ctxOf(),
          f.id,
          f.deletedAt! + 1,
          () => false,
          () => {},
        ),
      ),
    ).toThrow(/stale_confirmation/)
    const l = lease(f)
    expect(() => lease(f)).toThrow(PurgeInProgressError)
    l.release()
  })
})

export type { Actor, ServerMessage }
