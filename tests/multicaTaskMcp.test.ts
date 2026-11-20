import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { beforeEach, expect, it, vi } from 'vitest'
import * as actions from '../server/actions.ts'
import { buildMcpServer } from '../server/mcp.ts'
import { store } from '../server/store.ts'
import { MULTICA_TASK_HEADER, parseMulticaTaskId } from '../shared/pageIssue.ts'
import type { Canvas } from '../shared/types.ts'

vi.mock('../server/db/persist.ts', () => ({
  saveTask: () => {},
  saveFeedback: () => {},
  saveActivity: () => {},
  saveFrame: () => {},
  saveCanvas: () => {},
}))
vi.mock('../server/resident.ts', () => ({ onFeedback: () => {} }))

const OWNER_ID = 'owner-1'
const RUN = '01a1d675-3408-7b02-9816-b361c7e895fc'
const CANVAS: Canvas = { id: 'c1', name: 'Runs', ownerId: OWNER_ID, createdAt: 0, updatedAt: 0, frames: [] }

async function connect(multicaTaskId?: string) {
  const server = buildMcpServer('Owner', OWNER_ID, multicaTaskId)
  const client = new Client({ name: 'multica-task-test', version: '1.0.0' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await server.connect(b)
  await client.connect(a)
  return {
    client,
    close: async () => {
      await client.close()
      await server.close()
    },
  }
}

beforeEach(() => {
  vi.restoreAllMocks()
  vi.spyOn(store, 'getCanvas').mockImplementation((id: string) => (id === CANVAS.id ? CANVAS : undefined))
  vi.spyOn(actions, 'heartbeatAgent').mockImplementation(() => {})
})

it('a set_status task stores the Multica task id the call carried', async () => {
  const { client, close } = await connect(RUN)
  try {
    await client.callTool({
      name: 'set_status',
      arguments: { canvas_id: 'c1', status: 'Sketching', agent_name: 'Ana' },
    })
    const task = actions.getTasks('c1').find((t) => t.agentName === 'Ana')
    expect(task?.multicaTaskId).toBe(RUN)
  } finally {
    await close()
  }
})

it('an inferred task stores it too', async () => {
  const frame = vi.spyOn(store, 'createFrame').mockReturnValue({
    id: 'f1',
    canvasId: 'c1',
    name: 'Hero',
    html: '<p>x</p>',
    x: 0,
    y: 0,
    width: 1,
    height: 1,
    createdAt: 1,
    updatedAt: 1,
    updatedBy: 'Bo',
  })
  const { client, close } = await connect(RUN)
  try {
    await client.callTool({
      name: 'create_frame',
      arguments: { canvas_id: 'c1', name: 'Hero', html: '<p>x</p>', agent_name: 'Bo' },
    })
    expect(frame).toHaveBeenCalled()
    const task = actions.getTasks('c1').find((t) => t.agentName === 'Bo')
    expect(task?.auto).toBe(true)
    expect(task?.multicaTaskId).toBe(RUN)
  } finally {
    await close()
  }
})

it('a call without a valid id stores none', async () => {
  for (const [agent, id] of [
    ['Cy', undefined],
    ['Di', 'not-a-uuid'],
  ] as const) {
    const { client, close } = await connect(parseMulticaTaskId(id))
    try {
      await client.callTool({
        name: 'set_status',
        arguments: { canvas_id: 'c1', status: `Work ${agent}`, agent_name: agent },
      })
      expect(actions.getTasks('c1').find((t) => t.agentName === agent)?.multicaTaskId).toBeUndefined()
    } finally {
      await close()
    }
  }
})

it('no MCP tool can set a page→issue link', async () => {
  const { client, close } = await connect(RUN)
  try {
    const { tools } = await client.listTools()
    const names = tools.flatMap((t) => Object.keys((t.inputSchema as { properties?: object }).properties ?? {}))
    /* Linear's issue tools are unrelated; a Multica binding would say so */
    expect(names.filter((n) => /multica|page_issue|bind/i.test(n))).toEqual([])
    expect(tools.map((t) => t.name).filter((n) => /multica|bind|link_page|page_issue/i.test(n))).toEqual([])
  } finally {
    await close()
  }
})

it('reads the header lowercase, one uuid only', () => {
  expect(MULTICA_TASK_HEADER).toBe('x-multica-task-id')
  expect(parseMulticaTaskId(`${RUN}, ${RUN}`)).toBeUndefined()
})
