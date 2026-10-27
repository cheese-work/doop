import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as actions from '../server/actions.ts'
import { buildMcpServer } from '../server/mcp.ts'
import { store } from '../server/store.ts'
import type { Canvas, Frame } from '../shared/types.ts'
import { stubEnv, unstubAllEnvs } from './envStub.ts'

vi.mock('../server/db/persist.ts', () => ({
  saveTask: () => {},
  saveFeedback: () => {},
  saveComment: () => {},
  saveActivity: () => {},
  saveDecision: () => {},
  saveProposal: () => {},
  saveFrame: () => {},
}))
vi.mock('../server/resident.ts', () => ({ onFeedback: () => {} }))
vi.mock('../server/distill.ts', () => ({ onDecision: () => {} }))

const CANVAS: Canvas = {
  id: 'c1',
  name: 'Fence',
  ownerId: 'owner-1',
  createdAt: 0,
  updatedAt: 0,
  frames: [],
}

const T0 = 1_700_000_000_000
let frame: Frame

function makeFrame(): Frame {
  return {
    id: 'f1',
    canvasId: CANVAS.id,
    name: 'Hero',
    html: '<h1>Hi</h1>',
    x: 0,
    y: 0,
    width: 640,
    height: 480,
    createdAt: 0,
    updatedAt: T0,
    updatedBy: 'alice',
  }
}

async function connect() {
  const server = buildMcpServer('Test Owner', CANVAS.ownerId)
  const client = new Client({ name: 'doop-fence-test', version: '1.0.0' })
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
  const result = (await client.callTool({ name, arguments: args })) as unknown as {
    content: Array<{ type: string; text?: string }>
    isError?: boolean
  }
  return { text: result.content.map((block) => block.text ?? '').join('\n'), isError: !!result.isError }
}

let updateFrame: ReturnType<typeof vi.spyOn>
let appendFrameHtml: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  vi.restoreAllMocks()
  frame = makeFrame()
  vi.spyOn(store, 'getCanvas').mockImplementation((id: string) => (id === CANVAS.id ? CANVAS : undefined))
  vi.spyOn(store, 'getFrame').mockImplementation((id: string) => (id === frame.id ? frame : undefined))
  vi.spyOn(actions, 'heartbeatAgent').mockImplementation(() => {})
  vi.spyOn(actions, 'takeFeedbackFor').mockReturnValue([])
  /* like the store: a write moves updatedAt forward */
  updateFrame = vi.spyOn(actions, 'updateFrame').mockImplementation((_id, patch) => {
    frame = { ...frame, ...patch, updatedAt: frame.updatedAt + 1 }
    return frame
  })
  appendFrameHtml = vi.spyOn(actions, 'appendFrameHtml').mockImplementation(() => frame)
})

afterEach(() => {
  unstubAllEnvs()
})

const write = (extra: Record<string, unknown> = {}) => ({
  frame_id: 'f1',
  html: '<p>new</p>',
  agent_name: 'Claude',
  ...extra,
})

describe('set_frame_html expected_updated_at', () => {
  it('writes when the version matches', async () => {
    const { client, close } = await connect()
    try {
      const out = await call(client, 'set_frame_html', write({ expected_updated_at: new Date(T0).toISOString() }))
      expect(out.isError).toBe(false)
      expect(updateFrame).toHaveBeenCalledTimes(1)
    } finally {
      await close()
    }
  })

  it('refuses a stale version, names the current updatedAt and writes nothing', async () => {
    const { client, close } = await connect()
    try {
      const out = await call(client, 'set_frame_html', write({ expected_updated_at: new Date(T0 - 5).toISOString() }))
      expect(out.isError).toBe(true)
      expect(out.text).toContain(new Date(T0).toISOString())
      expect(updateFrame).not.toHaveBeenCalled()
    } finally {
      await close()
    }
  })

  it('lets exactly one of two writers from the same read succeed', async () => {
    const { client, close } = await connect()
    try {
      const read = new Date(T0).toISOString()
      const [a, b] = await Promise.all([
        call(client, 'set_frame_html', write({ html: '<p>a</p>', expected_updated_at: read })),
        call(client, 'set_frame_html', write({ html: '<p>b</p>', expected_updated_at: read })),
      ])
      expect([a.isError, b.isError].sort()).toEqual([false, true])
      expect(updateFrame).toHaveBeenCalledTimes(1)
    } finally {
      await close()
    }
  })

  it('rejects a value that is not a timestamp', async () => {
    const { client, close } = await connect()
    try {
      const out = await call(client, 'set_frame_html', write({ expected_updated_at: 'yesterday' }))
      expect(out.isError).toBe(true)
      expect(updateFrame).not.toHaveBeenCalled()
    } finally {
      await close()
    }
  })

  it('still writes without it when DOOP_MCP_REQUIRE_FENCE is unset', async () => {
    const { client, close } = await connect()
    try {
      const out = await call(client, 'set_frame_html', write())
      expect(out.isError).toBe(false)
      expect(updateFrame).toHaveBeenCalledTimes(1)
    } finally {
      await close()
    }
  })
})

describe('DOOP_MCP_REQUIRE_FENCE=1', () => {
  beforeEach(() => stubEnv('DOOP_MCP_REQUIRE_FENCE', '1'))

  it('refuses set_frame_html without expected_updated_at', async () => {
    const { client, close } = await connect()
    try {
      const out = await call(client, 'set_frame_html', write())
      expect(out.isError).toBe(true)
      expect(out.text).toContain('expected_updated_at')
      expect(updateFrame).not.toHaveBeenCalled()
    } finally {
      await close()
    }
  })

  it('accepts set_frame_html with a matching expected_updated_at', async () => {
    const { client, close } = await connect()
    try {
      const out = await call(client, 'set_frame_html', write({ expected_updated_at: new Date(T0).toISOString() }))
      expect(out.isError).toBe(false)
      expect(updateFrame).toHaveBeenCalledTimes(1)
    } finally {
      await close()
    }
  })

  it('refuses every append_frame_html call', async () => {
    const { client, close } = await connect()
    try {
      const out = await call(client, 'append_frame_html', {
        frame_id: 'f1',
        html_chunk: '<p>x</p>',
        start: true,
        done: true,
        agent_name: 'Claude',
      })
      expect(out.isError).toBe(true)
      expect(appendFrameHtml).not.toHaveBeenCalled()
    } finally {
      await close()
    }
  })
})

describe('append_frame_html without the fence flag', () => {
  it('still streams', async () => {
    const { client, close } = await connect()
    try {
      const out = await call(client, 'append_frame_html', {
        frame_id: 'f1',
        html_chunk: '<p>x</p>',
        start: true,
        done: true,
        agent_name: 'Claude',
      })
      expect(out.isError).toBe(false)
      expect(appendFrameHtml).toHaveBeenCalledTimes(1)
    } finally {
      await close()
    }
  })
})
