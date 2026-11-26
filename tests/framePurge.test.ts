import pg from 'pg'
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { cpSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { count, eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, describe, expect, inject, it, vi } from 'vitest'
import WebSocket from 'ws'
import { Client } from './harness.ts'
import type { Frame } from '../shared/types.ts'

/*
 * CHE-9399 step 4 (P1d): `POST /api/frames/:id/purge`, the route that wires the persist fence (P1a), the lease and
 * finalizer (P1b) and the purge transaction and probe (P1c). Written first, seen red (no route), then green.
 *
 * The REAL server boots in this process on a copy of the migrated PGlite template, so the REST routes, the store and
 * the test share one module instance. Four hooks stand in for what a PGlite test cannot do by itself:
 *  - `beforeSettle`   a held frame write: the purge waits in `settleFrameWrites` until the test releases it;
 *  - `settleTimeout`  `settleFrameWrites` gives up (`SettleTimeout`) once;
 *  - `ack`            a lost COMMIT acknowledgement: the transaction really commits (or never starts) and the caller
 *                     is told `unknown`; `probe` holds the outcome probe;
 *  - `commentGate`    holds a comment upsert before its SQL starts.
 * Everything else in persist and in purge.ts is the real module. PGlite has one connection, so a comment upsert
 * that stays open while the purge takes its SHARE lock (T14 e2 to e4) needs real PostgreSQL: set DOOP_TEST_PG_URL to
 * an empty database and the whole file runs there (those cases are skipped otherwise).
 * "A restart agrees" is asserted on the rows a restart would read: the same Postgres tables (the child-process
 * reboot of T1 and T6 is in tests/framePurgeReboot.test.ts).
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
  const dir = mkdtempSync(join(tmpdir(), 'doop-purge-route-'))
  Object.assign(process.env, {
    PORT: String(port),
    BETTER_AUTH_URL: `http://localhost:${port}`,
    DATABASE_URL: process.env.DOOP_TEST_PG_URL ?? '',
    POSTHOG_KEY: '',
    VITE_POSTHOG_KEY: '',
    DOOP_WRITE_BOUNDARY: 'throw',
  })
  delete process.env.NODE_ENV
  return {
    port,
    dir,
    /** runs (and is awaited) before every `settleFrameWrites` until a test clears it */
    beforeSettle: null as null | (() => Promise<void>),
    /** make the next `settleFrameWrites` reject with `SettleTimeout` */
    settleTimeout: false,
    /** the next purge transaction: `committed` really commits and then reports `unknown` with its receipt;
     *  `before` reports `unknown` without a receipt and without running the transaction */
    ack: null as null | 'committed' | 'before',
    /** holds the outcome probe until released */
    probe: null as null | Promise<void>,
    /** how often the probe was asked */
    probeCalls: 0,
    /** holds each comment upsert (its call into persist) until it resolves */
    commentGate: null as null | Promise<void>,
    /** how often the purge transaction ran */
    purgeCalls: 0,
  }
})

vi.mock('../server/db/persist.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/db/persist.ts')>()
  return {
    ...actual,
    settleFrameWrites: async (...args: Parameters<typeof actual.settleFrameWrites>) => {
      await rig.beforeSettle?.()
      if (rig.settleTimeout) {
        rig.settleTimeout = false
        throw new actual.SettleTimeout(args[0], args[1]?.timeoutMs ?? 0)
      }
      return actual.settleFrameWrites(...args)
    },
    saveComment: (...args: Parameters<typeof actual.saveComment>) => {
      const gate = rig.commentGate
      if (!gate) return actual.saveComment(...args)
      void gate.then(() => actual.saveComment(...args))
    },
  }
})
vi.mock('../server/db/purge.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/db/purge.ts')>()
  return {
    ...actual,
    purgeTrashedFrame: async (...args: Parameters<typeof actual.purgeTrashedFrame>) => {
      rig.purgeCalls++
      const mode = rig.ack
      rig.ack = null
      if (mode === 'before') return { outcome: 'unknown' as const, error: new Error('connection terminated') }
      const result = await actual.purgeTrashedFrame(...args)
      if (mode === 'committed' && result.outcome === 'committed')
        return { outcome: 'unknown' as const, receipt: result.receipt, error: new Error('connection terminated') }
      return result
    },
    resolvePurgeOutcome: async (...args: Parameters<typeof actual.resolvePurgeOutcome>) => {
      rig.probeCalls++
      const gate = rig.probe
      await gate
      return actual.resolvePurgeOutcome(...args)
    },
  }
})
vi.mock('../server/resident.ts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  onFeedback: () => {},
}))
vi.mock('../server/distill.ts', () => ({ onDecision: () => {} }))

const { store } = await import('../server/store.ts')
const actions = await import('../server/actions.ts')
const persist = await import('../server/db/persist.ts')
const schema = await import('../server/db/schema.ts')
const { canvasPages } = await import('../shared/pages.ts')
const { buildMcpServer } = await import('../server/mcp.ts')
/* the route's timing knobs; absent until the route exists, so a red run fails on the missing route, not here */
const timing = await import('../server/framePurge.ts').then(
  (m) => m.purgeTiming as { settleTimeoutMs: number; outcomeWaitMs: number; probe: { delaysMs?: number[] } },
  () => undefined,
)

/** set: the whole file runs on real PostgreSQL (an empty database) and the lock cases of T14 run too */
const PG_URL = process.env.DOOP_TEST_PG_URL

const live = { base: `http://localhost:${rig.port}`, port: rig.port }
let ownerId = ''
let owner: Client
let canvasId = ''
let pageId = ''
let mcp: McpClient
let seq = 0

beforeAll(async () => {
  if (!PG_URL) cpSync(inject('templateDir'), rig.dir, { recursive: true }) // PGlite; else the empty database at DOOP_TEST_PG_URL
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
  owner = await new Client(live as never).signUp(`purge-route-owner-${Date.now()}@test.dev`, 'Owner')
  const session = (await (await owner.get('/api/auth/get-session')).json()) as { user: { id: string } }
  ownerId = session.user.id
  const canvas = await (await owner.post('/api/canvases', { name: 'Purge route' })).json()
  canvasId = canvas.id
  pageId = canvas.pages[0].id
  const server = buildMcpServer('Owner', ownerId)
  mcp = new McpClient({ name: 'purge-route-test', version: '1.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await mcp.connect(clientTransport)
  if (timing) {
    timing.outcomeWaitMs = 400
    timing.probe.delaysMs = [20, 20, 20]
  }
}, 120_000)

afterEach(() => {
  rig.beforeSettle = null
  rig.settleTimeout = false
  rig.ack = null
  rig.probe = null
  rig.commentGate = null
  vi.restoreAllMocks()
})
afterAll(() => {
  rig.beforeSettle = null
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

const db = async () => (await import('../server/db/index.ts')).db

async function makeFrame(name: string, html = `<p>${name}</p>`, onPage = pageId): Promise<Frame> {
  const res = await owner.post(`/api/canvases/${canvasId}/frames`, { name, html, pageId: onPage })
  expect(res.status).toBe(200)
  return res.json()
}

/** a frame in the Trash, deleted through the REST route, with versions, write keys and asset refs seeded */
async function makeTrashed(name: string, opts: { seed?: boolean; onPage?: string } = {}) {
  const frame = await makeFrame(name, `<p>${name}</p>`, opts.onPage)
  const seeded = opts.seed === false ? undefined : await seedRows(frame.id)
  expect((await owner.delete(`/api/frames/${frame.id}`)).status).toBe(200)
  const inTrash = store.getDeletedFrame(frame.id)!
  expect(inTrash.deletedAt).toBeTypeOf('number')
  if (seeded) await seedAssets(frame.id, seeded)
  /* a copy: the store mutates its own object when the frame is restored or deleted again */
  return { frame: { ...inTrash }, seeded }
}

/** two versions and two write keys that name `frameId` (and the ids of two asset refs, see `seedAssets`) */
async function seedRows(frameId: string) {
  const d = await db()
  const n = ++seq
  const versionIds = [`v1-${frameId}-${n}`, `v2-${frameId}-${n}`]
  await d.insert(schema.frameVersions).values(
    versionIds.map((id) => ({
      id,
      frameId,
      canvasId,
      html: `<p>${id}</p>`,
      width: 640,
      height: 480,
      savedAt: 1,
      savedBy: 'Owner',
    })),
  )
  const writeKeyIds = [`k1-${n}`, `k2-${n}`]
  await d.insert(schema.frameWriteKeys).values(
    writeKeyIds.map((key, i) => ({
      frameId,
      key,
      payloadHash: 'h',
      versionId: versionIds[i]!,
      result: { updatedAt: 1, htmlBytes: 1 },
      createdAt: 1,
    })),
  )
  return { versionIds, writeKeyIds, assetRefIds: [`a1-${n}`, `a2-${n}`] }
}

/** asset refs are written for a frame that is in the Trash too, but a delete drops the live ones: seed them after it */
async function seedAssets(frameId: string, seeded: { assetRefIds: string[] }) {
  /* the frame's own save rewrites its asset refs from its html: let it land first */
  await flush()
  await settle(100)
  await (await db()).insert(schema.assetRefs).values(seeded.assetRefIds.map((assetId) => ({ assetId, frameId })))
}

/** the rows that name a frame, as a restart would read them */
async function rowsOf(frameId: string) {
  const d = await db()
  const [frameRows, versions, keys, refs, comments] = await Promise.all([
    d.select().from(schema.frames).where(eq(schema.frames.id, frameId)),
    d
      .select({ id: schema.frameVersions.id })
      .from(schema.frameVersions)
      .where(eq(schema.frameVersions.frameId, frameId)),
    d
      .select({ key: schema.frameWriteKeys.key })
      .from(schema.frameWriteKeys)
      .where(eq(schema.frameWriteKeys.frameId, frameId)),
    d.select({ id: schema.assetRefs.assetId }).from(schema.assetRefs).where(eq(schema.assetRefs.frameId, frameId)),
    d.select({ id: schema.comments.id }).from(schema.comments).where(eq(schema.comments.frameId, frameId)),
  ])
  return {
    frame: frameRows[0],
    versionIds: versions.map((v) => v.id).sort(),
    writeKeyIds: keys.map((k) => k.key).sort(),
    assetRefIds: refs.map((r) => r.id).sort(),
    commentIds: comments.map((c) => c.id).sort(),
  }
}

const purge = (frame: Pick<Frame, 'id' | 'deletedAt'>, client: Client = owner, deletedAt: unknown = frame.deletedAt) =>
  client.post(`/api/frames/${frame.id}/purge`, { deletedAt })

const trashed = (frameId: string) => store.listTrash(canvasId).frames.find((f) => f.id === frameId)

/** F is still in the Trash, not marked purging, and every row that names it is there */
async function expectIntact(frame: Frame, seeded?: Awaited<ReturnType<typeof seedRows>>) {
  expect(trashed(frame.id)).toBeDefined()
  expect(trashed(frame.id)).not.toHaveProperty('purging')
  expect(store.isPurging(frame.id)).toBe(false)
  const rows = await rowsOf(frame.id)
  expect(rows.frame?.id).toBe(frame.id)
  expect(rows.frame?.deletedAt).toBe(frame.deletedAt)
  if (seeded) {
    expect(rows.versionIds).toEqual([...seeded.versionIds].sort())
    expect(rows.writeKeyIds).toEqual([...seeded.writeKeyIds].sort())
    expect(rows.assetRefIds).toEqual([...seeded.assetRefIds].sort())
  }
}

async function expectGone(frame: Frame) {
  expect(store.getDeletedFrame(frame.id)).toBeUndefined()
  expect(store.getFrame(frame.id)).toBeUndefined()
  expect(trashed(frame.id)).toBeUndefined()
  const rows = await rowsOf(frame.id)
  expect(rows.frame).toBeUndefined()
  expect(rows.versionIds).toEqual([])
  expect(rows.writeKeyIds).toEqual([])
  expect(rows.assetRefIds).toEqual([])
}

/** a socket in the canvas room that records every message */
function openPeer(client: Client = owner) {
  const messages: Array<Record<string, any>> = [] // eslint-disable-line typescript/no-explicit-any -- loose wire JSON
  const ws = new WebSocket(`ws://localhost:${rig.port}/ws`, { headers: { Cookie: client.header() } })
  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('peer did not join')), 8000)
    ws.on('message', (data) => {
      const message = JSON.parse(String(data))
      messages.push(message)
      if (message.type === 'init') {
        clearTimeout(timer)
        resolve()
      }
    })
    ws.on('error', reject)
  })
  ws.on('open', () =>
    ws.send(JSON.stringify({ type: 'join', canvasId, clientId: `peer-${Math.random()}`, name: 'Peer', kind: 'user' })),
  )
  return {
    messages,
    ready,
    of: (type: string, frameId: string) => messages.filter((m) => m.type === type && m.frameId === frameId),
    close: () => ws.close(),
  }
}

const flush = () => persist.flush((id) => store.getFrame(id) ?? store.getDeletedFrame(id))
const settle = (ms = 80) => new Promise((r) => setTimeout(r, ms))
const deferred = () => {
  let release!: () => void
  const promise = new Promise<void>((r) => (release = r))
  return { promise, release }
}

describe('T1 purge removes the frame and its rows', () => {
  it('deletes the frame row, versions, write keys and asset refs; the frame and its versions are gone', async () => {
    const { frame, seeded } = await makeTrashed('t1')
    const keep = await makeFrame('t1 other')
    const keepRows = await seedRows(keep.id)
    await seedAssets(keep.id, keepRows)
    const res = await purge(frame)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    await expectGone(frame)
    expect(seeded!.versionIds).toHaveLength(2)
    /* the versions route answers 404 for a purged frame (a reboot reads the same tables: tests/framePurgeReboot.test.ts) */
    expect((await owner.get(`/api/frames/${frame.id}/versions`)).status).toBe(404)
    expect(
      (await owner.get(`/api/canvases/${canvasId}/trash`).then((r) => r.json())).frames.map((f: Frame) => f.id),
    ).not.toContain(frame.id)
    /* a neighbour on the same canvas keeps everything */
    const rows = await rowsOf(keep.id)
    expect(rows.frame?.id).toBe(keep.id)
    expect(rows.versionIds).toEqual([...keepRows.versionIds].sort())
    expect(rows.writeKeyIds).toEqual([...keepRows.writeKeyIds].sort())
    expect(rows.assetRefIds).toEqual([...keepRows.assetRefIds].sort())
  }, 30_000)
})

describe('T2 purge keeps every other table', () => {
  it('leaves comments, comment_events, page_snapshots, snapshot_blobs, activity (plus a forever line), attestations, decisions, memory references and approvals', async () => {
    const other = await makeFrame('t2 other')
    const c = await owner.post(`/api/frames/${other.id}/comments`, {
      text: 'on the other frame',
      x: 1,
      y: 2,
      snippet: '',
    })
    expect(c.status).toBe(200)
    const { frame } = await makeTrashed('t2')
    const snap = await call('create_page_snapshot', { canvas_id: canvasId, page_id: pageId, name: 't2 snapshot' })
    expect(snap.isError).toBe(false)
    const d = await db()
    await d.insert(schema.designAttestations).values({
      id: `t2-att-${Date.now()}`,
      runId: 'run',
      canvasId,
      pageId,
      frameId: frame.id,
      frameUpdatedAt: 1,
      ruleset: 'r',
      inputs: { recon: [], start: null },
      result: 'complete',
      missing: [],
      createdAt: 1,
      createdBy: 'Owner',
    })
    await d.insert(schema.decisions).values({
      id: `t2-dec-${Date.now()}`,
      canvasId,
      text: 't',
      source: 's',
      frameId: frame.id,
      fromName: 'Owner',
      at: 1,
    })
    await d.insert(schema.memoryReferences).values({
      id: `t2-mem-${Date.now()}`,
      canvasId,
      frameId: frame.id,
      title: 't',
      html: '<p/>',
      width: 1,
      height: 1,
      pinnedBy: 'Owner',
      pinnedAt: 1,
    })
    await d
      .insert(schema.automationApprovals)
      .values({ automationId: `t2-auto-${Date.now()}`, frameId: frame.id, approvedAt: 1 })
    await flush()
    const tables = [
      schema.comments,
      schema.commentEvents,
      schema.pageSnapshots,
      schema.snapshotBlobs,
      schema.designAttestations,
      schema.decisions,
      schema.memoryReferences,
      schema.automationApprovals,
    ]
    const counts = async () => Promise.all(tables.map(async (t) => (await d.select({ n: count() }).from(t))[0]!.n))
    const before = await counts()
    expect(before.every((n) => n > 0)).toBe(true)
    const activityBefore = (await d.select({ n: count() }).from(schema.activity))[0]!.n

    expect((await purge(frame)).status).toBe(200)

    expect(await counts()).toEqual(before)
    const lines = await d.select().from(schema.activity).where(eq(schema.activity.frameId, frame.id))
    expect(lines.map((l) => l.message)).toContain('deleted frame “t2” forever')
    expect((await d.select({ n: count() }).from(schema.activity))[0]!.n).toBeGreaterThan(activityBefore)
  }, 30_000)
})

describe('T3 stale confirmation', () => {
  it('delete, restore, delete again: the first deletedAt is 409 stale_confirmation and every row stays', async () => {
    const { frame: first, seeded } = await makeTrashed('t3')
    await settle(5) // a later clock tick, so the second delete stamps a new deletedAt
    expect((await owner.post(`/api/frames/${first.id}/restore`)).status).toBe(200)
    await settle(5)
    expect((await owner.delete(`/api/frames/${first.id}`)).status).toBe(200)
    const second = { ...store.getDeletedFrame(first.id)! }
    await (await db()).delete(schema.assetRefs).where(eq(schema.assetRefs.frameId, first.id))
    await seedAssets(first.id, seeded!)
    expect(second.deletedAt).not.toBe(first.deletedAt)
    const res = await purge(first)
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ code: 'stale_confirmation', deletedAt: second.deletedAt })
    await expectIntact(second, seeded)
    /* a body with no deletedAt is refused too */
    expect((await purge(second, owner, null)).status).toBe(400)
    await expectIntact(second, seeded)
    expect((await purge(second)).status).toBe(200)
  }, 30_000)
})

describe('T4 restore race', () => {
  it('(a) restore first, then purge: 409 not_in_trash; an unknown id is 404', async () => {
    const { frame } = await makeTrashed('t4a')
    expect((await owner.post(`/api/frames/${frame.id}/restore`)).status).toBe(200)
    const res = await purge(frame)
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ code: 'not_in_trash' })
    expect((await purge({ id: 'no-such-frame', deletedAt: 1 })).status).toBe(404)
  }, 30_000)

  it('(b) while the purge waits in settle, the five restore callers refuse natively and change nothing', async () => {
    const restFrame = await makeTrashed('t4b rest frame')
    const mcpFrame = await makeTrashed('t4b mcp frame')
    const snapFrame = await makeFrame('t4b snap frame')
    const snapshot = await call('create_page_snapshot', { canvas_id: canvasId, page_id: pageId, name: 't4b snapshot' })
    expect(snapshot.isError).toBe(false)
    expect((await owner.delete(`/api/frames/${snapFrame.id}`)).status).toBe(200)
    const pageOf = async (name: string) => {
      const id = `page-${name}`
      const pages = canvasPages(store.getCanvas(canvasId)!)
      expect(
        (await owner.put(`/api/canvases/${canvasId}/pages`, { pages: [...pages, { id, name }], expectedPages: pages }))
          .status,
      ).toBe(200)
      const made = await makeTrashed(`${name} frame`, { onPage: id })
      const kept = canvasPages(store.getCanvas(canvasId)!)
      expect(
        (
          await owner.put(`/api/canvases/${canvasId}/pages`, {
            pages: kept.filter((p) => p.id !== id),
            expectedPages: kept,
          })
        ).status,
      ).toBe(200)
      return { id, frame: made.frame }
    }
    const restPage = await pageOf('t4b rest page')
    const mcpPage = await pageOf('t4b mcp page')

    const targets = [
      restFrame.frame,
      mcpFrame.frame,
      restPage.frame,
      mcpPage.frame,
      { ...store.getDeletedFrame(snapFrame.id)! },
    ]
    const hold = deferred()
    let reached = 0
    rig.beforeSettle = async () => {
      reached++
      await hold.promise
    }
    const pending = targets.map((target) =>
      purge(target).then(async (r) => ({ status: r.status, body: await r.json() })),
    )
    for (let i = 0; i < 200 && reached < targets.length; i++) await settle(20)
    expect(reached).toBe(targets.length)
    expect(targets.every((t) => store.isPurging(t.id))).toBe(true)

    const rowsBefore = JSON.stringify(await (await db()).select().from(schema.frames).orderBy(schema.frames.id))
    const unchanged = async () =>
      expect(JSON.stringify(await (await db()).select().from(schema.frames).orderBy(schema.frames.id))).toBe(rowsBefore)

    const restFrameRes = await owner.post(`/api/frames/${restFrame.frame.id}/restore`)
    expect(restFrameRes.status).toBe(409)
    expect(await restFrameRes.json()).toMatchObject({ code: 'purge_in_progress' })
    const restPageRes = await owner.post(`/api/canvases/${canvasId}/pages/${restPage.id}/restore`)
    expect(restPageRes.status).toBe(409)
    expect(await restPageRes.json()).toMatchObject({ code: 'purge_in_progress' })
    const mcpFrameOut = await call('restore_frame', { frame_id: mcpFrame.frame.id })
    expect(mcpFrameOut.isError).toBe(true)
    expect(mcpFrameOut.text).toMatch(/^Error: purge_in_progress:/)
    const mcpPageOut = await call('restore_page', { canvas_id: canvasId, page_id: mcpPage.id })
    expect(mcpPageOut.isError).toBe(true)
    expect(mcpPageOut.text).toMatch(/^Error: purge_in_progress:/)
    const snapOut = await call('restore_page_snapshot', {
      canvas_id: canvasId,
      snapshot_id: snapshot.json!.snapshot.id,
    })
    expect(snapOut.isError).toBe(true)
    expect(snapOut.text).toMatch(/^Error: purge_in_progress:/)
    await unchanged()
    for (const t of targets) expect(store.getDeletedFrame(t.id)).toBeDefined()

    hold.release()
    for (const p of pending) expect((await p).status).toBe(200)
    for (const t of targets) await expectGone(t)
  }, 90_000)

  it('(c) deleted_at changed in Postgres between reserve and transaction: 409, F stays in Trash, rows kept', async () => {
    const { frame, seeded } = await makeTrashed('t4c')
    const hold = deferred()
    const reached = deferred()
    rig.beforeSettle = async () => {
      reached.release()
      await hold.promise
    }
    const pending = purge(frame)
    await reached.promise
    await (
      await db()
    )
      .update(schema.frames)
      .set({ deletedAt: frame.deletedAt! + 7 })
      .where(eq(schema.frames.id, frame.id))
    hold.release()
    const res = await pending
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ code: 'stale_confirmation' })
    expect(store.isPurging(frame.id)).toBe(false)
    expect(trashed(frame.id)).toBeDefined()
    const rows = await rowsOf(frame.id)
    expect(rows.frame).toBeDefined()
    expect(rows.versionIds).toEqual([...seeded!.versionIds].sort())
  }, 30_000)
})

describe('T5 access', () => {
  it('(a) a view link, a comment link and a non-member are refused at entry; nothing changes', async () => {
    const { frame, seeded } = await makeTrashed('t5a')
    const stranger = await new Client(live as never).signUp(`t5a-${Date.now()}@test.dev`, 'Stranger')
    expect((await purge(frame, stranger)).status).toBe(403) // private canvas
    for (const level of ['view', 'comment'] as const) {
      expect((await owner.patch(`/api/canvases/${canvasId}`, { linkAccess: level })).status).toBe(200)
      const res = await purge(frame, stranger)
      expect(res.status).toBe(403)
      await expectIntact(frame, seeded)
    }
    expect((await owner.patch(`/api/canvases/${canvasId}`, { linkAccess: 'none' })).status).toBe(200)
    /* signed out */
    expect(
      (
        await fetch(`${live.base}/api/frames/${frame.id}/purge`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ deletedAt: frame.deletedAt }),
        })
      ).status,
    ).toBe(401)
    await expectIntact(frame, seeded)
  }, 30_000)

  it('(b) the member is removed while the purge waits in settle: 403 access_lost, rows kept, F restorable', async () => {
    const { frame, seeded } = await makeTrashed('t5b')
    const email = `t5b-${Date.now()}@test.dev`
    const member = await new Client(live as never).signUp(email, 'Member')
    const memberId = ((await (await member.get('/api/auth/get-session')).json()) as { user: { id: string } }).user.id
    expect((await owner.post(`/api/canvases/${canvasId}/members`, { email })).status).toBe(200)
    const hold = deferred()
    const reached = deferred()
    rig.beforeSettle = async () => {
      reached.release()
      await hold.promise
    }
    const pending = purge(frame, member)
    await reached.promise
    expect((await owner.delete(`/api/canvases/${canvasId}/members/${memberId}`)).status).toBe(200)
    hold.release()
    const res = await pending
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ code: 'access_lost' })
    await expectIntact(frame, seeded)
    expect((await owner.post(`/api/frames/${frame.id}/restore`)).status).toBe(200)
  }, 30_000)

  it('(c) a link editor loses edit when the share link is lowered to view: 403 access_lost, rows kept', async () => {
    const { frame, seeded } = await makeTrashed('t5c')
    expect((await owner.patch(`/api/canvases/${canvasId}`, { linkAccess: 'edit' })).status).toBe(200)
    const visitor = await new Client(live as never).signUp(`t5c-${Date.now()}@test.dev`, 'Visitor')
    const hold = deferred()
    const reached = deferred()
    rig.beforeSettle = async () => {
      reached.release()
      await hold.promise
    }
    const pending = purge(frame, visitor)
    await reached.promise
    expect((await owner.patch(`/api/canvases/${canvasId}`, { linkAccess: 'view' })).status).toBe(200)
    hold.release()
    const res = await pending
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ code: 'access_lost' })
    await expectIntact(frame, seeded)
    expect((await owner.patch(`/api/canvases/${canvasId}`, { linkAccess: 'none' })).status).toBe(200)
  }, 30_000)
})

describe('T6 no resurrection', () => {
  it('edit then delete inside the debounce window, purge at once: no frame row and no orphan version row appear later', async () => {
    const frame = await makeFrame('t6', '<p>one</p>')
    const actor = actions.resolveActor({ name: 'Ada', kind: 'user' })
    actions.updateFrame(frame.id, { html: '<p>two</p>' }, actor)
    expect((await owner.delete(`/api/frames/${frame.id}`)).status).toBe(200)
    const gone = { ...store.getDeletedFrame(frame.id)! }
    expect((await purge(gone)).status).toBe(200)
    await settle(1500) // longer than the frame debounce
    await flush()
    await expectGone(gone)
  }, 30_000)
})

describe('T7 snapshot after purge', () => {
  it('restore_page_snapshot on a snapshot that held F skips it; the snapshot row is unchanged', async () => {
    const frame = await makeFrame('t7 frame')
    const kept = await makeFrame('t7 kept')
    const snap = await call('create_page_snapshot', { canvas_id: canvasId, page_id: pageId, name: 't7 snapshot' })
    expect(snap.isError).toBe(false)
    expect((await owner.delete(`/api/frames/${frame.id}`)).status).toBe(200)
    const gone = { ...store.getDeletedFrame(frame.id)! }
    const d = await db()
    const rowBefore = JSON.stringify(
      await d.select().from(schema.pageSnapshots).where(eq(schema.pageSnapshots.id, snap.json!.snapshot.id)),
    )
    expect((await purge(gone)).status).toBe(200)
    const out = await call('restore_page_snapshot', { canvas_id: canvasId, snapshot_id: snap.json!.snapshot.id })
    expect(out.isError).toBe(false)
    expect(JSON.stringify(out.json!.restored ?? [])).not.toContain(frame.id)
    expect(store.getFrame(frame.id)).toBeUndefined()
    expect(store.getDeletedFrame(frame.id)).toBeUndefined()
    expect(store.getFrame(kept.id)).toBeDefined()
    expect(
      JSON.stringify(
        await d.select().from(schema.pageSnapshots).where(eq(schema.pageSnapshots.id, snap.json!.snapshot.id)),
      ),
    ).toBe(rowBefore)
  }, 30_000)
})

describe('T8 guards', () => {
  const root = process.cwd()
  const read = (rel: string) => readFileSync(path.join(root, rel), 'utf8')

  it('the delete guard allows exactly persist.ts and purge.ts; the persist.ts delete count stays 3', () => {
    const guard = read('tests/frameTrashPersist.test.ts')
    expect(guard).toMatch(/'server\/db\/purge\.ts':/)
    expect([...guard.matchAll(/^\s+'server\/[^']+': /gm)]).toHaveLength(2)
    expect(read('server/db/persist.ts').match(/\.delete\(\s*t\.(frames|frameVersions|pages)\b/g)).toHaveLength(3)
  })

  it('no MCP or resident source names or reaches purgeTrashedFrame, the purge route handler or the finalizer', () => {
    const dir = path.join(root, 'server')
    const files = readdirSync(dir).filter((f) => f === 'mcp.ts' || /^resident.*\.ts$/.test(f))
    expect(files).toContain('mcp.ts')
    for (const f of files) {
      const text = read(`server/${f}`)
      expect(text, f).not.toMatch(
        /purgeTrashedFrame|resolvePurgeOutcome|runFramePurge|framePurge|beginPurge|finishCommitted|purge_frame/,
      )
    }
    expect(
      readdirSync(path.join(root, 'server'))
        .filter((f) => f.endsWith('.ts'))
        .filter((f) => /purgeTrashedFrame/.test(read(`server/${f}`)))
        .sort(),
    ).toEqual(['framePurge.ts'])
  })

  it('an agent key gets 401 from the route and the route handler does not touch the MCP surface', async () => {
    const { frame, seeded } = await makeTrashed('t8')
    const key = (await (await owner.post('/api/agent-keys', { name: 't8-key' })).json()) as { secret: string }
    const res = await fetch(`${live.base}/api/frames/${frame.id}/purge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key.secret}` },
      body: JSON.stringify({ deletedAt: frame.deletedAt }),
    })
    expect([401, 403]).toContain(res.status)
    await expectIntact(frame, seeded)
    const tools = (await mcp.listTools()).tools.map((t) => t.name)
    expect(tools.filter((name) => /purge|delete_forever/i.test(name))).toEqual([])
  }, 30_000)

  it('a component main frame cannot be purged (409 component_main), and every row stays', async () => {
    const { frame, seeded } = await makeTrashed('t8 main')
    const canvas = store.getCanvas(canvasId)!
    const before = canvas.components
    canvas.components = [
      { id: 't8-main', mainFrameId: frame.id } as unknown as NonNullable<typeof canvas.components>[0],
    ]
    try {
      const res = await purge(frame)
      expect(res.status).toBe(409)
      expect(await res.json()).toMatchObject({ code: 'component_main' })
      await expectIntact(frame, seeded)
    } finally {
      canvas.components = before
    }
  }, 30_000)
})

describe('T9 lifecycle', () => {
  it('(a) the client aborts while the purge waits in settle, then the transaction conflicts: F in Trash, not purging, restorable', async () => {
    const { frame, seeded } = await makeTrashed('t9a')
    const hold = deferred()
    const reached = deferred()
    rig.beforeSettle = async () => {
      reached.release()
      await hold.promise
    }
    const abort = new AbortController()
    const pending = fetch(`${live.base}/api/frames/${frame.id}/purge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: owner.header() },
      body: JSON.stringify({ deletedAt: frame.deletedAt }),
      signal: abort.signal,
    }).catch(() => 'aborted')
    await reached.promise
    abort.abort()
    expect(await pending).toBe('aborted')
    await (
      await db()
    )
      .update(schema.frames)
      .set({ deletedAt: frame.deletedAt! + 3 })
      .where(eq(schema.frames.id, frame.id))
    hold.release()
    for (let i = 0; i < 100 && store.isPurging(frame.id); i++) await settle(20)
    expect(store.isPurging(frame.id)).toBe(false)
    expect(trashed(frame.id)).toBeDefined()
    expect(trashed(frame.id)).not.toHaveProperty('purging')
    expect((await rowsOf(frame.id)).versionIds).toEqual([...seeded!.versionIds].sort())
    expect((await owner.post(`/api/frames/${frame.id}/restore`)).status).toBe(200)
  }, 30_000)

  it('(b) the client aborts, then the transaction commits: F gone from memory and Postgres', async () => {
    const { frame } = await makeTrashed('t9b')
    const hold = deferred()
    const reached = deferred()
    rig.beforeSettle = async () => {
      reached.release()
      await hold.promise
    }
    const abort = new AbortController()
    const pending = fetch(`${live.base}/api/frames/${frame.id}/purge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: owner.header() },
      body: JSON.stringify({ deletedAt: frame.deletedAt }),
      signal: abort.signal,
    }).catch(() => 'aborted')
    await reached.promise
    abort.abort()
    expect(await pending).toBe('aborted')
    hold.release()
    for (let i = 0; i < 100 && store.getDeletedFrame(frame.id); i++) await settle(20)
    await expectGone(frame)
  }, 30_000)

  it('(c) the broadcast throws after commit: F stays gone and the answer is 200', async () => {
    const { frame } = await makeTrashed('t9c')
    const peer = openPeer()
    await peer.ready
    /* only the purge's own message throws: an unrelated timer broadcast must not hit the spy */
    const realSend = WebSocket.prototype.send
    vi.spyOn(WebSocket.prototype, 'send').mockImplementation(function (
      this: WebSocket,
      ...args: Parameters<WebSocket['send']>
    ) {
      if (String(args[0]).includes('frame:purged')) throw new Error('socket exploded')
      return realSend.apply(this, args)
    })
    const res = await purge(frame)
    vi.restoreAllMocks()
    peer.close()
    expect(res.status).toBe(200)
    await expectGone(frame)
  }, 30_000)

  it('(d) settle times out: 503 purge_timeout, F in Trash, the held write lands afterwards', async () => {
    const { frame, seeded } = await makeTrashed('t9d')
    rig.settleTimeout = true
    const res = await purge(frame)
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ code: 'purge_timeout' })
    await expectIntact(frame, seeded)
    /* the write that was held lands: an edit queued now still reaches Postgres */
    await settle(50)
    expect((await purge(frame)).status).toBe(200)
  }, 30_000)
})

describe('T11 a Trash frame whose canvas html is not loaded', () => {
  it('purges without a false stale_confirmation', async () => {
    const { frame } = await makeTrashed('t11')
    store.evictIdle(0, Date.now() + 3_600_000)
    const res = await purge(frame)
    expect(res.status).toBe(200)
    await expectGone(frame)
  }, 30_000)
})

describe('T12 lost acknowledgement end to end', () => {
  it('(a) committed: 200 or 503 purge_outcome_unknown; finalizer ran once with the exact receipt; peers got one frame:purged; neighbours intact', async () => {
    const { frame, seeded } = await makeTrashed('t12a')
    const neighbour = await makeFrame('t12a neighbour')
    const neighbourRows = await seedRows(neighbour.id)
    await seedAssets(neighbour.id, neighbourRows)
    const peer = openPeer()
    await peer.ready
    const finish = vi.spyOn(actions, 'finishCommitted')
    rig.ack = 'committed'
    const res = await purge(frame)
    expect([200, 503]).toContain(res.status)
    if (res.status === 503) expect(await res.json()).toMatchObject({ code: 'purge_outcome_unknown' })
    for (let i = 0; i < 100 && store.getDeletedFrame(frame.id); i++) await settle(20)
    await expectGone(frame)
    expect(rig.probeCalls).toBeGreaterThan(0)
    expect(finish).toHaveBeenCalledTimes(1)
    const receipt = finish.mock.calls[0]![1]
    expect(receipt).toMatchObject({ frameId: frame.id, canvasId, deletedAt: frame.deletedAt })
    expect([...receipt.versionIds].sort()).toEqual([...seeded!.versionIds].sort())
    expect([...receipt.writeKeyIds].sort()).toEqual([...seeded!.writeKeyIds].sort())
    expect([...receipt.assetRefIds].sort()).toEqual([...seeded!.assetRefIds].sort())
    await settle(100)
    expect(peer.of('frame:purged', frame.id)).toHaveLength(1)
    peer.close()
    const rows = await rowsOf(neighbour.id)
    expect(rows.frame?.id).toBe(neighbour.id)
    expect(rows.versionIds).toEqual([...neighbourRows.versionIds].sort())
    expect(rows.writeKeyIds).toEqual([...neighbourRows.writeKeyIds].sort())
    expect(rows.assetRefIds).toEqual([...neighbourRows.assetRefIds].sort())
  }, 30_000)

  it('(a2) restores answer 409 and a held write is dropped while the probe has not answered', async () => {
    const { frame } = await makeTrashed('t12a2')
    const gate = deferred()
    rig.probe = gate.promise
    rig.ack = 'committed'
    const res = await purge(frame)
    expect(res.status).toBe(503)
    expect(store.isPurging(frame.id)).toBe(true)
    const restore = await owner.post(`/api/frames/${frame.id}/restore`)
    expect(restore.status).toBe(409)
    expect(await restore.json()).toMatchObject({ code: 'purge_in_progress' })
    persist.saveFrame({ ...frame, html: '<p>held</p>', updatedAt: Date.now() } as Frame)
    gate.release()
    for (let i = 0; i < 100 && store.getDeletedFrame(frame.id); i++) await settle(20)
    await settle(1200)
    await expectGone(frame)
  }, 30_000)

  it('(b) rolled back within 10 s: 409 purge_not_applied; F in Trash, not purging, restorable; purging true then false; no frame:purged', async () => {
    const { frame, seeded } = await makeTrashed('t12b')
    const peer = openPeer()
    await peer.ready
    rig.ack = 'before'
    const res = await purge(frame)
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ code: 'purge_not_applied' })
    await expectIntact(frame, seeded)
    await settle(100)
    const states = peer.of('trash:purge_state', frame.id).map((m) => m.purging)
    expect(states).toEqual([true, false])
    expect(peer.of('frame:purged', frame.id)).toHaveLength(0)
    peer.close()
    expect((await owner.post(`/api/frames/${frame.id}/restore`)).status).toBe(200)
  }, 30_000)

  it('(e) rollback after the 503: the probe is held past the wait; later it answers rolled_back and the same socket gets purging false', async () => {
    const { frame, seeded } = await makeTrashed('t12e')
    const peer = openPeer()
    await peer.ready
    const gate = deferred()
    rig.probe = gate.promise
    rig.ack = 'before'
    const res = await purge(frame)
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ code: 'purge_outcome_unknown' })
    const during = (await (await owner.get(`/api/canvases/${canvasId}/trash`)).json()).frames.find(
      (f: Frame) => f.id === frame.id,
    )
    expect(during).toMatchObject({ purging: true })
    gate.release()
    for (let i = 0; i < 100 && store.isPurging(frame.id); i++) await settle(20)
    await settle(100)
    expect(peer.of('trash:purge_state', frame.id).map((m) => m.purging)).toEqual([true, false])
    peer.close()
    const after = (await (await owner.get(`/api/canvases/${canvasId}/trash`)).json()).frames.find(
      (f: Frame) => f.id === frame.id,
    )
    expect(after).toBeDefined()
    expect(after).not.toHaveProperty('purging')
    await expectIntact(frame, seeded)
    expect((await owner.post(`/api/frames/${frame.id}/restore`)).status).toBe(200)
  }, 30_000)

  it('(d) path equivalence: COMMIT resolved and a lost acknowledgement resolved by the probe leave the same state', async () => {
    const run = async (ack: 'committed' | null) => {
      const { frame, seeded } = await makeTrashed(`t12d ${ack ?? 'plain'}`)
      const peer = openPeer()
      await peer.ready
      rig.ack = ack
      await purge(frame)
      for (let i = 0; i < 100 && store.getDeletedFrame(frame.id); i++) await settle(20)
      await settle(100)
      const rows = await rowsOf(frame.id)
      const out = {
        memory: {
          deleted: !!store.getDeletedFrame(frame.id),
          live: !!store.getFrame(frame.id),
          trash: !!trashed(frame.id),
        },
        peer: peer.messages.filter((m) => m.frameId === frame.id).map((m) => `${m.type}:${m.purging ?? ''}`),
        rows: {
          frame: !!rows.frame,
          versions: rows.versionIds.length,
          keys: rows.writeKeyIds.length,
          refs: rows.assetRefIds.length,
        },
        seeded: seeded!.versionIds.length,
      }
      peer.close()
      return out
    }
    const plain = await run(null)
    const lost = await run('committed')
    expect(lost).toEqual(plain)
    expect(plain.rows).toEqual({ frame: false, versions: 0, keys: 0, refs: 0 })
  }, 60_000)
})

describe('T14 comments refuse', () => {
  const commentRow = async (id: string) =>
    (await (await db()).select().from(schema.comments).where(eq(schema.comments.id, id)))[0]

  async function commentOn(frame: Frame, text: string) {
    const res = await owner.post(`/api/frames/${frame.id}/comments`, { text, x: 5, y: 6, snippet: 'snip' })
    expect(res.status).toBe(200)
    const comment = (await res.json()) as { id: string }
    for (let i = 0; i < 100 && !(await commentRow(comment.id)); i++) await settle(20)
    expect(await commentRow(comment.id)).toBeDefined()
    return comment
  }

  it('(a) a root comment on F made before the delete: 409 has_comments, nothing deleted', async () => {
    const frame = await makeFrame('t14a')
    const seeded = await seedRows(frame.id)
    const root = await commentOn(frame, 'root')
    expect((await owner.delete(`/api/frames/${frame.id}`)).status).toBe(200)
    const gone = { ...store.getDeletedFrame(frame.id)! }
    await seedAssets(frame.id, seeded)
    const res = await purge(gone)
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ code: 'has_comments' })
    await expectIntact(gone, seeded)
    expect((await rowsOf(frame.id)).commentIds).toEqual([root.id])
  }, 30_000)

  it('(b) a reply on F whose root is in memory: 409 has_comments', async () => {
    const frame = await makeFrame('t14b')
    const seeded = await seedRows(frame.id)
    const root = await commentOn(frame, 'root')
    const reply = await owner.post(`/api/comments/${root.id}/replies`, { text: 'reply' })
    expect(reply.status).toBe(200)
    expect((await owner.delete(`/api/frames/${frame.id}`)).status).toBe(200)
    const gone = { ...store.getDeletedFrame(frame.id)! }
    await seedAssets(frame.id, seeded)
    const res = await purge(gone)
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ code: 'has_comments' })
    await expectIntact(gone, seeded)
  }, 30_000)

  it('(c) the thread is outside the memory window and only Postgres has it: still 409 has_comments', async () => {
    const frame = await makeFrame('t14c')
    const seeded = await seedRows(frame.id)
    const root = await commentOn(frame, 'root')
    expect((await owner.delete(`/api/frames/${frame.id}`)).status).toBe(200)
    const gone = { ...store.getDeletedFrame(frame.id)! }
    await seedAssets(frame.id, seeded)
    const list = actions.getComments(canvasId)
    list.splice(0, list.length, ...list.filter((c) => c.id !== root.id && c.parentId !== root.id))
    expect(actions.commentsOnFrame(canvasId, frame.id)).toBe(false)
    const res = await purge(gone)
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ code: 'has_comments' })
    await expectIntact(gone, seeded)
    expect((await rowsOf(frame.id)).commentIds).toEqual([root.id])
  }, 30_000)

  it('(d) a thread moved onto F just before F was deleted, its upsert held: 409 has_comments (memory); trimmed from memory, still 409 (the row)', async () => {
    const from = await makeFrame('t14d from')
    const frame = await makeFrame('t14d target')
    const seeded = await seedRows(frame.id)
    const root = await commentOn(from, 'root')
    const gate = deferred()
    rig.commentGate = gate.promise
    const move = await owner.patch(`/api/comments/${root.id}/anchor`, {
      frameId: frame.id,
      x: 7,
      y: 8,
      snippet: 'moved',
    })
    expect(move.status).toBe(200)
    expect((await owner.delete(`/api/frames/${frame.id}`)).status).toBe(200)
    const gone = { ...store.getDeletedFrame(frame.id)! }
    await seedAssets(frame.id, seeded)
    /* memory names F: refused at once */
    expect(actions.commentsOnFrame(canvasId, frame.id)).toBe(true)
    let res = await purge(gone)
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ code: 'has_comments' })
    /* trimmed from memory: the row (still on `from`) and the registry cannot see F, so the purge commits only if
       the held upsert has not moved a row to F; this thread's row still names `from` */
    const list = actions.getComments(canvasId)
    list.splice(0, list.length, ...list.filter((c) => c.id !== root.id))
    expect((await commentRow(root.id))?.frameId).toBe(from.id)
    await expectIntact(gone, seeded)
    gate.release()
    await settle(200)
    /* the upsert landed: the row now names F, so the purge is refused by the row */
    expect((await commentRow(root.id))?.frameId).toBe(frame.id)
    res = await purge(gone)
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ code: 'has_comments' })
    await expectIntact(gone, seeded)
  }, 30_000)

  it('(e1) a thread moved from F to G, both upserts held before their SQL starts: 409 has_comments, rows still on F; released and landed, a retry answers 200', async () => {
    const f = await makeFrame('t14e1 f')
    const g = await makeFrame('t14e1 g')
    const seeded = await seedRows(f.id)
    const root = await commentOn(f, 'root')
    const reply = (await (await owner.post(`/api/comments/${root.id}/replies`, { text: 'reply' })).json()) as {
      id: string
    }
    for (let i = 0; i < 100 && !(await commentRow(reply.id)); i++) await settle(20)
    const beforeRoot = await commentRow(root.id)
    const beforeReply = await commentRow(reply.id)
    const gate = deferred()
    rig.commentGate = gate.promise
    expect(
      (await owner.patch(`/api/comments/${root.id}/anchor`, { frameId: g.id, x: 9, y: 9, snippet: 'to g' })).status,
    ).toBe(200)
    expect((await owner.delete(`/api/frames/${f.id}`)).status).toBe(200)
    const gone = { ...store.getDeletedFrame(f.id)! }
    await seedAssets(f.id, seeded)
    /* memory now says G; the rows still say F, and no write for F is counted */
    expect(actions.commentsOnFrame(canvasId, f.id)).toBe(false)
    expect(persist.commentWritesPending(f.id)).toBe(0)
    const res = await purge(gone)
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ code: 'has_comments' })
    expect(await commentRow(root.id)).toEqual(beforeRoot)
    expect(await commentRow(reply.id)).toEqual(beforeReply)
    await expectIntact(gone, seeded)
    gate.release()
    for (
      let i = 0;
      i < 100 && ((await commentRow(root.id))?.frameId !== g.id || (await commentRow(reply.id))?.frameId !== g.id);
      i++
    )
      await settle(20)
    expect((await commentRow(root.id))?.frameId).toBe(g.id)
    expect((await commentRow(reply.id))?.frameId).toBe(g.id)
    const retry = await purge(gone)
    expect(retry.status).toBe(200)
    await expectGone(gone)
    expect((await rowsOf(g.id)).commentIds).toEqual([root.id, reply.id].sort())
  }, 30_000)

  it('(e5) both upserts landed before the purge: 200, the thread whole on G', async () => {
    const f = await makeFrame('t14e5 f')
    const g = await makeFrame('t14e5 g')
    const root = await commentOn(f, 'root')
    const reply = (await (await owner.post(`/api/comments/${root.id}/replies`, { text: 'reply' })).json()) as {
      id: string
    }
    for (let i = 0; i < 100 && !(await commentRow(reply.id)); i++) await settle(20)
    expect(
      (await owner.patch(`/api/comments/${root.id}/anchor`, { frameId: g.id, x: 3, y: 4, snippet: 'to g' })).status,
    ).toBe(200)
    for (
      let i = 0;
      i < 100 && ((await commentRow(root.id))?.frameId !== g.id || (await commentRow(reply.id))?.frameId !== g.id);
      i++
    )
      await settle(20)
    expect((await owner.delete(`/api/frames/${f.id}`)).status).toBe(200)
    const gone = { ...store.getDeletedFrame(f.id)! }
    expect((await purge(gone)).status).toBe(200)
    await expectGone(gone)
    const rows = await rowsOf(g.id)
    expect(rows.commentIds).toEqual([root.id, reply.id].sort())
  }, 30_000)

  it('(f) a new comment POST on F while F is in Trash answers 410 with no purge running', async () => {
    const { frame } = await makeTrashed('t14f')
    const calls = rig.purgeCalls
    const res = await owner.post(`/api/frames/${frame.id}/comments`, { text: 'late', x: 1, y: 1, snippet: '' })
    expect(res.status).toBe(410)
    expect(store.isPurging(frame.id)).toBe(false)
    expect(rig.purgeCalls).toBe(calls) // no purge transaction ran
  }, 30_000)

  /* the Postgres-only orderings: an upsert OPEN in another transaction when the purge takes its SHARE lock */
  describe.skipIf(!PG_URL)('lock orderings (PostgreSQL)', () => {
    let pool: pg.Pool
    beforeAll(() => {
      pool = new pg.Pool({ connectionString: PG_URL })
    })
    afterAll(async () => {
      await pool?.end()
    })

    /** an upsert of `id` that has run its statement and not committed: it holds the row and a ROW EXCLUSIVE table lock */
    async function openUpsert(id: string, to: string) {
      const client = await pool.connect()
      await client.query('begin')
      await client.query('update comments set frame_id = $2 where id = $1', [id, to])
      let ended = false
      const end = async (how: 'commit' | 'rollback') => {
        if (ended) return
        ended = true
        await client.query(how)
        client.release()
      }
      return { commit: () => end('commit'), rollback: () => end('rollback') }
    }
    const landed = (id: string, to: string) => pool.query('update comments set frame_id = $2 where id = $1', [id, to])
    const frameOfRow = async (id: string) => (await commentRow(id))?.frameId

    /** F (to be purged) and G; a thread R + P on F whose move to G is held in memory */
    async function threadMovedInMemory(tag: string) {
      const f = await makeFrame(`${tag} f`)
      const g = await makeFrame(`${tag} g`)
      const seeded = await seedRows(f.id)
      const root = await commentOn(f, 'root')
      const reply = (await (await owner.post(`/api/comments/${root.id}/replies`, { text: 'reply' })).json()) as {
        id: string
      }
      for (let i = 0; i < 100 && !(await commentRow(reply.id)); i++) await settle(20)
      const gate = deferred()
      rig.commentGate = gate.promise
      expect(
        (await owner.patch(`/api/comments/${root.id}/anchor`, { frameId: g.id, x: 2, y: 2, snippet: 'g' })).status,
      ).toBe(200)
      expect((await owner.delete(`/api/frames/${f.id}`)).status).toBe(200)
      const gone = { ...store.getDeletedFrame(f.id)! }
      await seedAssets(f.id, seeded)
      expect(actions.commentsOnFrame(canvasId, f.id)).toBe(false)
      return { f, g, gone, seeded, root: root.id, reply: reply.id, gate }
    }

    /** the purge is waiting on the open upsert: not answered yet */
    async function purgeBehind(frame: Frame) {
      let early = ''
      const result = purge(frame).then(async (r) => {
        early = `${r.status} ${JSON.stringify(await r.clone().json())}`
        return r
      })
      await settle(400)
      expect(early).toBe('') // not answered while the upsert is open
      return { result }
    }

    async function landsAndRetries(t: Awaited<ReturnType<typeof threadMovedInMemory>>) {
      t.gate.release()
      for (let i = 0; i < 100 && ((await frameOfRow(t.root)) !== t.g.id || (await frameOfRow(t.reply)) !== t.g.id); i++)
        await settle(20)
      expect((await purge(t.gone)).status).toBe(200)
      await expectGone(t.gone)
      expect(await frameOfRow(t.root)).toBe(t.g.id)
      expect(await frameOfRow(t.reply)).toBe(t.g.id)
    }

    it('(e2) R open at lock time, P not started: waits, then 409 has_comments; R on G, P on F; then P lands and a retry answers 200', async () => {
      const t = await threadMovedInMemory('t14e2')
      const open = await openUpsert(t.root, t.g.id)
      const behind = await purgeBehind(t.gone)
      await open.commit()
      const res = await behind.result
      expect(res.status).toBe(409)
      expect(await res.json()).toMatchObject({ code: 'has_comments' })
      expect(await frameOfRow(t.root)).toBe(t.g.id)
      expect(await frameOfRow(t.reply)).toBe(t.f.id)
      await expectIntact(t.gone, t.seeded)
      await landsAndRetries(t)
    }, 30_000)

    it('(e3) P open at lock time, R not started: waits, then 409 has_comments; P on G, R on F; then R lands and a retry answers 200', async () => {
      const t = await threadMovedInMemory('t14e3')
      const open = await openUpsert(t.reply, t.g.id)
      const behind = await purgeBehind(t.gone)
      await open.commit()
      const res = await behind.result
      expect(res.status).toBe(409)
      expect(await res.json()).toMatchObject({ code: 'has_comments' })
      expect(await frameOfRow(t.reply)).toBe(t.g.id)
      expect(await frameOfRow(t.root)).toBe(t.f.id)
      await expectIntact(t.gone, t.seeded)
      await landsAndRetries(t)
    }, 30_000)

    it('(e4) R landed, P (the last outstanding upsert) open at lock time: the purge waits for P, then answers 200', async () => {
      const t = await threadMovedInMemory('t14e4')
      await landed(t.root, t.g.id)
      const open = await openUpsert(t.reply, t.g.id)
      const behind = await purgeBehind(t.gone)
      await open.commit()
      expect((await behind.result).status).toBe(200)
      await expectGone(t.gone)
      t.gate.release()
      await settle(300)
      expect(await frameOfRow(t.root)).toBe(t.g.id)
      expect(await frameOfRow(t.reply)).toBe(t.g.id)
    }, 30_000)

    it('(e2r) the open upsert rolls back: its row stays on F, so the purge is refused', async () => {
      const t = await threadMovedInMemory('t14e2r')
      await landed(t.reply, t.g.id)
      const open = await openUpsert(t.root, t.g.id)
      const behind = await purgeBehind(t.gone)
      await open.rollback()
      const res = await behind.result
      expect(res.status).toBe(409)
      expect(await res.json()).toMatchObject({ code: 'has_comments' })
      expect(await frameOfRow(t.root)).toBe(t.f.id)
      await expectIntact(t.gone, t.seeded)
      await landsAndRetries(t)
    }, 30_000)
  })
})
