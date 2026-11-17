import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Canvas, Frame } from '../shared/types'
import { conflicts, freeSpot } from '../server/frameLayout.ts'
import { Client, startServer, type Server } from './harness.ts'

/* CHE-6119: an agent's direct doop write (MCP create_frame / update_frame) never leaves frames overlapping */
let server: Server
let owner: Client
let agent: McpClient

beforeAll(async () => {
  server = await startServer()
  owner = await new Client(server).signUp('overlap@test.dev', 'Overlap Owner')
  const { secret } = await (await owner.post('/api/agent-keys', { name: 'Design agent' })).json()
  agent = new McpClient({ name: 'overlap-test', version: '1.0.0' })
  await agent.connect(
    new StreamableHTTPClientTransport(new URL('/mcp', server.base), {
      requestInit: { headers: { Authorization: `Bearer ${secret}` } },
    }),
  )
}, 60_000)

afterAll(async () => {
  await agent?.close()
  server?.stop()
})

async function call(name: string, args: Record<string, unknown>) {
  const result = await agent.callTool({ name, arguments: { agent_name: 'Designer', ...args } })
  const text = (result.content as { type: string; text?: string }[]).find((c) => c.type === 'text')!.text!
  return { isError: !!result.isError, text }
}

async function frames(canvasId: string): Promise<Frame[]> {
  return ((await (await owner.get(`/api/canvases/${canvasId}`)).json()) as Canvas).frames
}

function overlapping(fs: Frame[]) {
  return fs.flatMap((a, i) => fs.slice(i + 1).flatMap((b) => (conflicts(a, [b]).length ? [[a.id, b.id]] : [])))
}

describe('frameLayout', () => {
  const f = (id: string, x: number, y: number, w = 100, h = 100) => ({ id, name: id, x, y, width: w, height: h })

  it('flags intersecting and too-close boxes, ignores clear, hidden and self', () => {
    const others = [f('a', 0, 0), { ...f('h', 0, 0), hidden: true }]
    expect(conflicts({ x: 50, y: 50, width: 100, height: 100 }, others).map((o) => o.id)).toEqual(['a'])
    expect(conflicts({ x: 120, y: 0, width: 100, height: 100 }, others)).toHaveLength(1) // 20px gap < 40
    expect(conflicts({ x: 140, y: 0, width: 100, height: 100 }, others)).toHaveLength(0) // 40px gap
    expect(conflicts({ x: 0, y: 0, width: 100, height: 100 }, others, 'a')).toHaveLength(0)
  })

  it('places a new frame below the lowest visible frame', () => {
    expect(freeSpot([f('a', 10, 20), f('b', 300, 50, 100, 400)])).toEqual({ x: 10, y: 530 })
    expect(freeSpot([])).toEqual({ x: 120, y: 120 })
  })
})

describe('agent writes through MCP', () => {
  it('create_frame at an overlapping x/y lands in free space and says so', async () => {
    const canvas: Canvas = await (await owner.post('/api/canvases', { name: 'Create' })).json()
    const a = JSON.parse((await call('create_frame', { canvas_id: canvas.id, name: 'A', html: '', x: 0, y: 0 })).text)
    const b = JSON.parse(
      (await call('create_frame', { canvas_id: canvas.id, name: 'B', html: '', x: 100, y: 100 })).text,
    )
    expect(a.frame.x).toBe(0)
    expect(b.placement).toMatch(/placed in free space/)
    expect(overlapping(await frames(canvas.id))).toEqual([])
  })

  it('update_frame refuses a move or resize onto another frame, accepts a clear one, and a rename always passes', async () => {
    const canvas: Canvas = await (await owner.post('/api/canvases', { name: 'Move' })).json()
    const ids: string[] = []
    for (const [name, x] of [
      ['A', 0],
      ['B', 1000],
    ] as const) {
      const r = JSON.parse((await call('create_frame', { canvas_id: canvas.id, name, html: '', x, y: 0 })).text)
      ids.push(r.frame.id)
    }
    const [a, b] = ids as [string, string]

    const onto = await call('update_frame', { frame_id: b, x: 100, y: 100 })
    expect(onto.isError).toBe(true)
    expect(onto.text).toMatch(/may not overlap/)
    expect(onto.text).toContain(a)
    const grow = await call('update_frame', { frame_id: a, width: 1200 })
    expect(grow.isError).toBe(true)

    const clear = await call('update_frame', { frame_id: b, x: 2000, y: 0 })
    expect(clear.isError).toBe(false)
    expect((await call('update_frame', { frame_id: a, name: 'A2' })).isError).toBe(false)
    expect(overlapping(await frames(canvas.id))).toEqual([])
  })
})
