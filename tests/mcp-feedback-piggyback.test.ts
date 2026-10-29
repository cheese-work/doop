import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as actions from '../server/actions.ts'
import { buildMcpServer } from '../server/mcp.ts'
import { store } from '../server/store.ts'
import type { Canvas, Frame, TaskFeedback } from '../shared/types.ts'
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
  name: 'Piggyback',
  ownerId: 'owner-1',
  createdAt: 0,
  updatedAt: 0,
  frames: [],
}

const FRAME: Frame = {
  id: 'f1',
  canvasId: CANVAS.id,
  name: 'Hero',
  html: '<h1>Hi</h1>',
  x: 0,
  y: 0,
  width: 640,
  height: 480,
  createdAt: 0,
  updatedAt: 1,
  updatedBy: 'alice',
}

const FEEDBACK: TaskFeedback = {
  id: 'fb1',
  taskId: 't1',
  canvasId: CANVAS.id,
  agentName: 'Claude',
  from: 'alice',
  text: 'make it bigger',
  at: 1,
}

async function connect() {
  const server = buildMcpServer('Test Owner', CANVAS.ownerId)
  const client = new Client({ name: 'doop-piggyback-test', version: '1.0.0' })
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

async function callText(client: Client, name: string, args: Record<string, unknown>): Promise<string> {
  const result = (await client.callTool({ name, arguments: args })) as unknown as {
    content: Array<{ type: string; text?: string }>
  }
  return result.content.map((block) => block.text ?? '').join('\n')
}

let takeFeedback: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  vi.restoreAllMocks()
  vi.spyOn(store, 'getCanvas').mockImplementation((id: string) => (id === CANVAS.id ? CANVAS : undefined))
  vi.spyOn(store, 'getFrame').mockImplementation((id: string) => (id === FRAME.id ? FRAME : undefined))
  vi.spyOn(actions, 'heartbeatAgent').mockImplementation(() => {})
  vi.spyOn(actions, 'updateFrame').mockImplementation(() => FRAME)
  takeFeedback = vi.spyOn(actions, 'takeFeedbackFor').mockReturnValue([FEEDBACK])
})

afterEach(() => {
  unstubAllEnvs()
})

describe('DOOP_MCP_FEEDBACK_PIGGYBACK', () => {
  it('appends task feedback to a mutating tool result by default', async () => {
    const { client, close } = await connect()
    try {
      const out = await callText(client, 'set_frame_html', {
        frame_id: FRAME.id,
        html: '<p>x</p>',
        agent_name: 'Claude',
      })
      expect(out).toContain('HUMAN FEEDBACK')
      expect(takeFeedback).toHaveBeenCalled()
    } finally {
      await close()
    }
  })

  it('leaves task feedback unclaimed when set to 0', async () => {
    stubEnv('DOOP_MCP_FEEDBACK_PIGGYBACK', '0')
    const { client, close } = await connect()
    try {
      const out = await callText(client, 'set_frame_html', {
        frame_id: FRAME.id,
        html: '<p>x</p>',
        agent_name: 'Claude',
      })
      expect(out).not.toContain('HUMAN FEEDBACK')
      expect(takeFeedback).not.toHaveBeenCalled()
    } finally {
      await close()
    }
  })

  it('still claims feedback on an explicit get_feedback call when set to 0', async () => {
    stubEnv('DOOP_MCP_FEEDBACK_PIGGYBACK', '0')
    const { client, close } = await connect()
    try {
      const out = await callText(client, 'get_feedback', { canvas_id: CANVAS.id, agent_name: 'Claude' })
      expect(out).toContain('make it bigger')
      expect(takeFeedback).toHaveBeenCalledTimes(1)
    } finally {
      await close()
    }
  })
})
