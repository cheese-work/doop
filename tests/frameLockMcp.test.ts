import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Canvas, Frame, FrameVersion } from '../shared/types.ts'

/**
 * The lock and the conditional write, seen from an agent over MCP. The real
 * store and actions run; only persistence is mocked.
 */

const version: FrameVersion = {
  id: 'v1',
  frameId: 'f1',
  canvasId: 'c1',
  html: '<h1>Older</h1>',
  width: 320,
  height: 200,
  savedAt: 1,
  savedBy: 'Ada',
  htmlBytes: 14,
}
vi.mock('../server/db/persist.ts', () => ({
  saveTask: () => {},
  saveFeedback: () => {},
  saveComment: () => {},
  saveActivity: () => {},
  saveDecision: () => {},
  saveProposal: () => {},
  saveCanvas: () => {},
  saveFrame: () => {},
  saveFrameNow: async () => {},
  saveFrameVersion: () => {},
  deleteFrame: () => {},
  listFrameVersions: async () => [],
  getFrameVersion: async () => version,
}))
vi.mock('../server/resident.ts', () => ({ onFeedback: () => {} }))
vi.mock('../server/distill.ts', () => ({ onDecision: () => {} }))

const actions = await import('../server/actions.ts')
const { buildMcpServer } = await import('../server/mcp.ts')
const { store } = await import('../server/store.ts')

const T0 = 1_700_000_000_000
const OWNER = 'owner-1'
let frame: Frame

beforeEach(() => {
  const canvas: Canvas = {
    id: 'c1',
    name: 'Lock',
    ownerId: OWNER,
    createdAt: 0,
    updatedAt: 0,
    pages: [{ id: 'p1', name: 'Page 1' }],
    frames: [
      {
        id: 'f1',
        canvasId: 'c1',
        pageId: 'p1',
        name: 'Hero',
        html: '<h1>Original</h1>',
        x: 0,
        y: 0,
        width: 640,
        height: 480,
        createdAt: 0,
        updatedAt: T0,
        updatedBy: 'alice',
        locked: true,
      },
    ],
  }
  store.init([canvas])
  actions.wire(
    () => {},
    () => {},
  )
  frame = canvas.frames[0]!
})

afterEach(() => {
  vi.restoreAllMocks()
})

async function connect() {
  const server = buildMcpServer('Test Owner', OWNER)
  const client = new Client({ name: 'doop-lock-test', version: '1.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  return {
    client,
    close: async () => {
      await client.close()
      await server.close()
    },
  }
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const result = (await client.callTool({ name, arguments: { agent_name: 'Claude', ...args } })) as unknown as {
    content: Array<{ type: string; text?: string }>
    isError?: boolean
  }
  return { text: result.content.map((block) => block.text ?? '').join('\n'), isError: !!result.isError }
}

const untouched = () => {
  expect(frame).toMatchObject({ html: '<h1>Original</h1>', width: 640, height: 480, updatedAt: T0 })
}

describe('a locked frame over MCP', () => {
  it.each([
    ['set_frame_html', { html: '<p>x</p>' }],
    ['edit_frame_html', { old_str: 'Original', new_str: 'Changed' }],
    ['append_frame_html', { html_chunk: '<p>x</p>', start: true }],
    ['append_frame_html', { html_chunk: '<p>x</p>' }],
    ['update_frame', { width: 10 }],
    ['update_frame', { height: 10 }],
    ['restore_frame_version', { version_id: 'v1' }],
  ])('refuses %s %j, naming the frame and saying it is locked', async (tool, args) => {
    const { client, close } = await connect()
    try {
      const out = await call(client, tool, { frame_id: 'f1', ...args })
      expect(out.isError).toBe(true)
      expect(out.text).toMatch(/Hero/)
      expect(out.text).toMatch(/f1/)
      expect(out.text).toMatch(/locked/)
      untouched()
    } finally {
      await close()
    }
  })

  it('still renames, moves and unlocks, then takes HTML again', async () => {
    const { client, close } = await connect()
    try {
      expect((await call(client, 'update_frame', { frame_id: 'f1', name: 'Renamed', x: 40, y: 50 })).isError).toBe(
        false,
      )
      expect(frame).toMatchObject({ name: 'Renamed', x: 40, y: 50, html: '<h1>Original</h1>', locked: true })
      expect((await call(client, 'update_frame', { frame_id: 'f1', locked: false })).isError).toBe(false)
      expect(frame.locked).toBe(false)
      expect((await call(client, 'set_frame_html', { frame_id: 'f1', html: '<p>after</p>' })).isError).toBe(false)
      expect(frame.html).toBe('<p>after</p>')
    } finally {
      await close()
    }
  })

  it('refuses an unlock that carries a size change', async () => {
    const { client, close } = await connect()
    try {
      const out = await call(client, 'update_frame', { frame_id: 'f1', locked: false, width: 10 })
      expect(out.isError).toBe(true)
      expect(out.text).toMatch(/locked/)
      expect(frame.locked).toBe(true)
      untouched()
    } finally {
      await close()
    }
  })
})

describe('expected_updated_at over MCP', () => {
  beforeEach(() => {
    frame.locked = false
  })
  const stamp = () => new Date(frame.updatedAt).toISOString()

  it.each([
    ['edit_frame_html', { old_str: 'Original', new_str: 'Changed' }],
    ['append_frame_html', { html_chunk: '<p>x</p>', start: true }],
    ['set_frame_html', { html: '<p>x</p>' }],
  ])('%s refuses a stale version and writes nothing', async (tool, args) => {
    const { client, close } = await connect()
    try {
      const out = await call(client, tool, {
        frame_id: 'f1',
        ...args,
        expected_updated_at: new Date(T0 - 5).toISOString(),
      })
      expect(out.isError).toBe(true)
      expect(out.text).toMatch(/changed since you read it|changed since/i)
      untouched()
    } finally {
      await close()
    }
  })

  it('edit_frame_html and append_frame_html accept the current version', async () => {
    const { client, close } = await connect()
    try {
      const edit = await call(client, 'edit_frame_html', {
        frame_id: 'f1',
        old_str: 'Original',
        new_str: 'Changed',
        expected_updated_at: stamp(),
      })
      expect(edit.isError).toBe(false)
      const append = await call(client, 'append_frame_html', {
        frame_id: 'f1',
        html_chunk: '<p>tail</p>',
        expected_updated_at: stamp(),
      })
      expect(append.isError).toBe(false)
      expect(frame.html).toBe('<h1>Changed</h1><p>tail</p>')
    } finally {
      await close()
    }
  })

  it('rejects an expected_updated_at that is not a timestamp', async () => {
    const { client, close } = await connect()
    try {
      const out = await call(client, 'edit_frame_html', {
        frame_id: 'f1',
        old_str: 'Original',
        new_str: 'Changed',
        expected_updated_at: 'yesterday',
      })
      expect(out.isError).toBe(true)
      expect(out.text).toMatch(/ISO timestamp/)
      untouched()
    } finally {
      await close()
    }
  })

  it('lets two agents that read the same version write once, so no update is lost', async () => {
    const { client, close } = await connect()
    try {
      const expected_updated_at = stamp()
      const first = await call(client, 'edit_frame_html', {
        frame_id: 'f1',
        old_str: 'Original',
        new_str: 'First',
        expected_updated_at,
      })
      const second = await call(client, 'append_frame_html', {
        frame_id: 'f1',
        html_chunk: '<p>Second</p>',
        expected_updated_at,
      })
      expect([first.isError, second.isError]).toEqual([false, true])
      expect(frame.html).toBe('<h1>First</h1>')
    } finally {
      await close()
    }
  })
})
