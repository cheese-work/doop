import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { ARCHIVE_PAGE_ID } from '../shared/pages.ts'
import type { Canvas, CanvasPageInfo, Frame } from '../shared/types.ts'
import { Client, startServer, type Server } from './harness.ts'

/**
 * Archive over REST and MCP (CHE-9308 S2): both paths record where a frame came from in the same
 * store call, a repeated archive keeps the first origin (FP-01), and unarchive puts the frame back.
 * REST runs against a real server and database; the MCP half runs the real store with no database.
 */

vi.mock('../server/db/persist.ts', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return Object.fromEntries(Object.keys(actual).map((key) => [key, () => {}]))
})
vi.mock('../server/resident.ts', () => ({ onFeedback: () => {} }))
vi.mock('../server/distill.ts', () => ({ onDecision: () => {} }))

let server: Server
let owner: Client

beforeAll(async () => {
  server = await startServer()
  owner = new Client(server)
  await owner.signUp('archiverest@test.dev', 'Archive Rest Owner')
}, 70_000)

afterAll(() => server?.stop())

interface ArchiveReply {
  pages: CanvasPageInfo[]
  frames: Array<Pick<Frame, 'id' | 'pageId' | 'hidden' | 'archiveOrigin'>>
}

/** a canvas with pages P1 and P2, and one frame on P1 (hidden when asked) */
async function seed(opts: { hidden?: boolean } = {}) {
  const canvas: Canvas = await (await owner.post('/api/canvases', { name: 'Archive REST' })).json()
  const pages = [
    { id: 'p1', name: 'Page 1' },
    { id: 'p2', name: 'Page 2' },
  ]
  const put = await owner.put(`/api/canvases/${canvas.id}/pages`, { pages, expectedPages: canvas.pages })
  expect(put.status).toBe(200)
  const frame: Frame = await (
    await owner.post(`/api/canvases/${canvas.id}/frames`, { name: 'Hero', pageId: 'p1', hidden: opts.hidden })
  ).json()
  return { canvasId: canvas.id, frameId: frame.id }
}

const archive = (canvasId: string, frameIds: string[]) =>
  owner.post(`/api/canvases/${canvasId}/frames/archive`, { frameIds })
const unarchive = (frameId: string, body: Record<string, unknown> = {}) =>
  owner.post(`/api/frames/${frameId}/unarchive`, body)

async function read(canvasId: string, frameId: string): Promise<Frame> {
  const canvas: Canvas = await (await owner.get(`/api/canvases/${canvasId}`)).json()
  return canvas.frames.find((f) => f.id === frameId)!
}

describe('archive over REST', () => {
  it('moves the frame to the Archive page, hides it and records its origin and hidden', async () => {
    const { canvasId, frameId } = await seed({ hidden: true })
    const before = Date.now()
    const res = await archive(canvasId, [frameId])
    expect(res.status).toBe(200)
    const body = (await res.json()) as ArchiveReply
    expect(body.pages.at(-1)?.id).toBe(ARCHIVE_PAGE_ID)
    const frame = await read(canvasId, frameId)
    expect(frame).toMatchObject({ pageId: ARCHIVE_PAGE_ID, hidden: true })
    expect(frame.archiveOrigin).toMatchObject({ pageId: 'p1', hidden: true, by: 'Archive Rest Owner' })
    expect(frame.archiveOrigin!.archivedAt).toBeGreaterThanOrEqual(before)
    expect(body.frames[0]).toMatchObject({ id: frameId, archiveOrigin: { pageId: 'p1', hidden: true } })
  })

  it('answers 404 when none of the frames is on the canvas, and 400 for a bad body', async () => {
    const { canvasId } = await seed()
    expect((await archive(canvasId, ['nope'])).status).toBe(404)
    expect((await owner.post(`/api/canvases/${canvasId}/frames/archive`, { frameIds: [] })).status).toBe(400)
    expect((await owner.post(`/api/canvases/${canvasId}/frames/archive`, {})).status).toBe(400)
  })

  it('FP-01: the same archive sent twice (first reply dropped) keeps the first origin, and Undo restores both', async () => {
    const { canvasId, frameId } = await seed({ hidden: false })
    await archive(canvasId, [frameId]) // the reply to this one never reached the client
    const first = (await read(canvasId, frameId)).archiveOrigin!
    expect(first).toMatchObject({ pageId: 'p1', hidden: false })

    const retry = await archive(canvasId, [frameId]) // the client sends it again
    expect(retry.status).toBe(200)
    const afterRetry = await read(canvasId, frameId)
    expect(afterRetry.archiveOrigin).toEqual(first) // not {pageId:'archive', hidden:true}
    expect(afterRetry).toMatchObject({ pageId: ARCHIVE_PAGE_ID, hidden: true })

    const undo = await unarchive(frameId) // Undo = unarchive to origin
    expect(undo.status).toBe(200)
    const restored = await read(canvasId, frameId)
    expect(restored).toMatchObject({ pageId: 'p1', hidden: false })
    expect(restored.archiveOrigin).toBeUndefined()
  })
})

describe('unarchive over REST', () => {
  it('moves the frame to a chosen page, restores hidden and clears the origin', async () => {
    const { canvasId, frameId } = await seed({ hidden: true })
    await archive(canvasId, [frameId])
    const res = await unarchive(frameId, { pageId: 'p2' })
    expect(res.status).toBe(200)
    const frame = await read(canvasId, frameId)
    expect(frame).toMatchObject({ pageId: 'p2', hidden: true })
    expect(frame.archiveOrigin).toBeUndefined()
  })

  it('answers 409 origin_missing and moves nothing when the origin page is gone and no page is given', async () => {
    const { canvasId, frameId } = await seed()
    await archive(canvasId, [frameId])
    const canvas: Canvas = await (await owner.get(`/api/canvases/${canvasId}`)).json()
    const pages = canvas.pages!.filter((p) => p.id !== 'p1')
    expect((await owner.put(`/api/canvases/${canvasId}/pages`, { pages, expectedPages: canvas.pages })).status).toBe(
      200,
    )
    const before = await read(canvasId, frameId)

    const res = await unarchive(frameId)
    expect(res.status).toBe(409)
    expect(((await res.json()) as { code: string }).code).toBe('origin_missing')
    expect(await read(canvasId, frameId)).toEqual(before)

    expect((await unarchive(frameId, { pageId: 'p2' })).status).toBe(200) // a chosen page still works
    expect(await read(canvasId, frameId)).toMatchObject({ pageId: 'p2' })
  })

  it('answers 404 for an unknown frame or page, and leaves a frame that is not archived alone', async () => {
    const { canvasId, frameId } = await seed()
    expect((await unarchive('nope')).status).toBe(404)
    const before = await read(canvasId, frameId)
    expect((await unarchive(frameId, { pageId: 'p2' })).status).toBe(200) // not archived: nothing to do
    expect(await read(canvasId, frameId)).toEqual(before)

    await archive(canvasId, [frameId])
    expect((await unarchive(frameId, { pageId: 'gone' })).status).toBe(404)
    expect((await read(canvasId, frameId)).pageId).toBe(ARCHIVE_PAGE_ID)
  })

  it('drops the origin when any other writer moves the frame off the Archive', async () => {
    const { canvasId, frameId } = await seed()
    await archive(canvasId, [frameId])
    expect((await read(canvasId, frameId)).archiveOrigin).toBeDefined()
    expect((await owner.patch(`/api/frames/${frameId}`, { pageId: 'p2', hidden: false })).status).toBe(200)
    const frame = await read(canvasId, frameId)
    expect(frame).toMatchObject({ pageId: 'p2' })
    expect(frame.archiveOrigin).toBeUndefined()
  })

  it('keeps trash restore on its own route', async () => {
    const { canvasId, frameId } = await seed()
    expect((await owner.delete(`/api/frames/${frameId}`)).status).toBe(200)
    expect((await unarchive(frameId)).status).toBe(404) // a deleted frame is not archived
    expect((await owner.post(`/api/frames/${frameId}/restore`)).status).toBe(200)
    expect((await read(canvasId, frameId)).pageId).toBe('p1')
  })
})

describe('archive_frames over MCP', () => {
  it('records the origin and hidden in the same call, and keeps them on a repeat', async () => {
    const { store } = await import('../server/store.ts')
    const actions = await import('../server/actions.ts')
    const { buildMcpServer } = await import('../server/mcp.ts')
    const { systemContext } = await import('../server/writePolicy.ts')
    actions.wire(
      () => {},
      () => {},
    )
    const canvas: Canvas = {
      id: 'mcp-c1',
      name: 'MCP',
      ownerId: 'owner-1',
      createdAt: 0,
      updatedAt: 0,
      pages: [{ id: 'p1', name: 'Page 1' }],
      frames: [],
    }
    store.init([canvas])
    const frame = store.createFrame(systemContext(), 'mcp-c1', { name: 'Hero', html: '<h1>a</h1>', pageId: 'p1' }, 'T')!

    const mcp = buildMcpServer('Owner', 'owner-1')
    const client = new McpClient({ name: 'archive-test', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await mcp.connect(serverTransport)
    await client.connect(clientTransport)
    const call = () =>
      client.callTool({
        name: 'archive_frames',
        arguments: { canvas_id: 'mcp-c1', frame_ids: [frame.id], agent_name: 'Claude' },
      })
    try {
      expect(((await call()) as { isError?: boolean }).isError).toBeFalsy()
      const first = store.getFrame(frame.id)!.archiveOrigin
      expect(first).toMatchObject({ pageId: 'p1', hidden: false, by: 'Claude' })
      expect(store.getFrame(frame.id)).toMatchObject({ pageId: ARCHIVE_PAGE_ID, hidden: true })

      expect(((await call()) as { isError?: boolean }).isError).toBeFalsy()
      expect(store.getFrame(frame.id)!.archiveOrigin).toEqual(first)
    } finally {
      await client.close()
      await mcp.close()
    }
  }, 30_000)
})
