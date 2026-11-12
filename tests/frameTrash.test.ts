import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as actions from '../server/actions.ts'
import { buildMcpServer } from '../server/mcp.ts'
import { store } from '../server/store.ts'
import { ARCHIVE_PAGE_ID } from '../shared/pages.ts'
import type { Canvas } from '../shared/types.ts'

/**
 * Soft delete (CHE-5306) without a database: the persist layer is a no-op
 * recorder, so what is tested is the in-memory contract every writer shares.
 */

const saved = vi.hoisted(() => ({ frames: [] as Array<{ id: string; deletedAt?: number }> }))
vi.mock('../server/db/persist.ts', async (importOriginal) => {
  /* every persist export becomes a no-op, so only the store's own state is under test */
  const actual = await importOriginal<Record<string, unknown>>()
  const noop = () => {}
  return {
    ...Object.fromEntries(Object.keys(actual).map((key) => [key, noop])),
    saveFrame: (frame: { id: string; deletedAt?: number }) =>
      saved.frames.push({ id: frame.id, deletedAt: frame.deletedAt }),
    getFrameVersion: async () => ({ id: 'v1', html: '<p>old</p>', width: 100, height: 100, savedBy: 'x', savedAt: 0 }),
  }
})
vi.mock('../server/resident.ts', () => ({ onFeedback: () => {} }))
vi.mock('../server/distill.ts', () => ({ onDecision: () => {} }))

const OWNER = 'owner-1'
const actor = { name: 'Tester', kind: 'agent' as const, color: '#888888' }
let canvas: Canvas
/* a fresh canvas id per test: the store keeps trash by canvas id */
let cid = ''
let seeded = 0

function seed() {
  cid = `c${++seeded}`
  canvas = {
    id: cid,
    name: 'Trash',
    ownerId: OWNER,
    createdAt: 0,
    updatedAt: 0,
    pages: [
      { id: 'p1', name: 'Page 1' },
      { id: 'p2', name: 'Page 2' },
    ],
    frames: [],
  }
  store.canvases.clear()
  store.init([canvas])
  return {
    a: store.createFrame(cid, { name: 'Hero', html: '<h1>a</h1>', pageId: 'p1' }, 'Tester')!,
    b: store.createFrame(cid, { name: 'Footer', html: '<h1>b</h1>', pageId: 'p1' }, 'Tester')!,
    c: store.createFrame(cid, { name: 'Other', html: '<h1>c</h1>', pageId: 'p2' }, 'Tester')!,
  }
}

async function connect() {
  const server = buildMcpServer('Owner', OWNER)
  const client = new Client({ name: 'trash-test', version: '1.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  return client
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const result = (await client.callTool({ name, arguments: args })) as unknown as {
    content: Array<{ type: string; text?: string }>
    isError?: boolean
  }
  return { text: result.content.map((block) => block.text ?? '').join('\n'), isError: !!result.isError }
}

beforeEach(() => {
  saved.frames.length = 0
})

describe('frame soft delete', () => {
  it('hides a deleted frame from the canvas and keeps it restorable', () => {
    const { a } = seed()
    actions.deleteFrame(a.id, actor)
    expect(store.getFrame(a.id)).toBeUndefined()
    expect(canvas.frames.map((f) => f.id)).not.toContain(a.id)
    expect(store.getDeletedFrame(a.id)?.name).toBe('Hero')
    /* the row is kept and marked, never removed */
    expect(saved.frames.at(-1)).toMatchObject({ id: a.id, deletedAt: expect.any(Number) })

    const back = actions.restoreFrame(a.id, actor)
    expect(back?.id).toBe(a.id)
    expect(back?.html).toBe('<h1>a</h1>')
    expect(back?.deletedAt).toBeUndefined()
    expect(store.getFrame(a.id)).toBeDefined()
    expect(store.getDeletedFrame(a.id)).toBeUndefined()
  })
})

describe('a deleted frame refuses every writer', () => {
  /* the writers: add a new frame write path to this list or it is untested */
  const writers: Array<[string, (id: string) => unknown]> = [
    [
      'actions.updateFrame (set/edit html, resize, move, rename)',
      (id) => actions.updateFrame(id, { html: '<p>x</p>' }, actor),
    ],
    ['actions.updateFrame (resize)', (id) => actions.updateFrame(id, { width: 10, height: 10 }, actor)],
    ['actions.appendFrameHtml', (id) => actions.appendFrameHtml(id, '<p>x</p>', actor)],
    ['actions.restoreFrameVersion', (id) => actions.restoreFrameVersion(id, 'v1', actor)],
    ['actions.setFrameApproval', (id) => actions.setFrameApproval(id, true, { id: 'u', name: 'U' })],
    ['store.updateFrame (the shared funnel)', (id) => store.updateFrame(id, { name: 'x' }, 'Tester')],
  ]

  it.each(writers)('%s throws naming the frame', async (_label, write) => {
    const { a } = seed()
    actions.deleteFrame(a.id, actor)
    let thrown: unknown
    try {
      await write(a.id)
    } catch (e) {
      thrown = e
    }
    expect((thrown as Error | undefined)?.message).toMatch(/Hero/)
    expect((thrown as Error | undefined)?.message).toMatch(/deleted/)
  })

  const tools: Array<[string, (id: string) => Record<string, unknown>]> = [
    ['set_frame_html', (id) => ({ frame_id: id, html: '<p>x</p>', agent_name: 'C' })],
    ['append_frame_html', (id) => ({ frame_id: id, html_chunk: '<p>x</p>', agent_name: 'C' })],
    ['edit_frame_html', (id) => ({ frame_id: id, old_str: 'a', new_str: 'b', agent_name: 'C' })],
    ['update_frame', (id) => ({ frame_id: id, width: 10, agent_name: 'C' })],
    ['restore_frame_version', (id) => ({ frame_id: id, version_id: 'v1', agent_name: 'C' })],
  ]

  it.each(tools)('MCP %s names the frame and says it is deleted', async (name, args) => {
    const { a } = seed()
    actions.deleteFrame(a.id, actor)
    const out = await call(await connect(), name, args(a.id))
    expect(out.isError).toBe(true)
    expect(out.text).toMatch(/Hero/)
    expect(out.text).toMatch(/deleted/)
  })
})

describe('page soft delete', () => {
  it('restores a deleted page with its deleted frames', () => {
    const { a, b, c } = seed()
    actions.deleteFrame(a.id, actor)
    actions.deleteFrame(b.id, actor)
    actions.setCanvasPages(cid, [{ id: 'p2', name: 'Page 2' }], actor)
    expect(canvas.pages!.map((p) => p.id)).toEqual(['p2'])
    expect(store.getDeletedPage(cid, 'p1')?.name).toBe('Page 1')

    const out = actions.restorePage(cid, 'p1', actor)
    expect(out?.page.id).toBe('p1')
    expect(out?.frames.map((f) => f.id).sort()).toEqual([a.id, b.id].sort())
    expect(canvas.pages!.map((p) => p.id)).toContain('p1')
    expect(store.getFrame(a.id)?.pageId).toBe('p1')
    expect(store.getFrame(c.id)).toBeDefined()
  })
})

describe('archive', () => {
  it('moves frames to a last-placed Archive page and hides them', () => {
    const { a, b } = seed()
    const out = actions.archiveFrames(cid, [a.id, b.id], actor)
    expect(out?.moved).toEqual([a.id, b.id])
    const pages = canvas.pages!
    expect(pages.at(-1)).toMatchObject({ id: ARCHIVE_PAGE_ID, name: 'Archive' })
    expect(store.getFrame(a.id)).toMatchObject({ pageId: ARCHIVE_PAGE_ID, hidden: true })
    expect(store.getFrame(b.id)).toMatchObject({ pageId: ARCHIVE_PAGE_ID, hidden: true })
  })

  it('keeps the Archive page last when a page is added after it', () => {
    const { a } = seed()
    actions.archiveFrames(cid, [a.id], actor)
    actions.setCanvasPages(cid, [...canvas.pages!, { id: 'p3', name: 'Page 3' }], actor)
    expect(canvas.pages!.at(-1)?.id).toBe(ARCHIVE_PAGE_ID)
    expect(canvas.pages!.map((p) => p.id)).toContain('p3')
  })

  it('the archive_frames MCP tool does it in one step', async () => {
    const { a } = seed()
    const out = await call(await connect(), 'archive_frames', { canvas_id: cid, frame_ids: [a.id], agent_name: 'C' })
    expect(out.isError).toBe(false)
    expect(store.getFrame(a.id)).toMatchObject({ pageId: ARCHIVE_PAGE_ID, hidden: true })
  })
})
