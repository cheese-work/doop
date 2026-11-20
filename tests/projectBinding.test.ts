import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, startServer, type Server } from './harness.ts'

/**
 * CHE-5860 (CHE-5793 step 13): the project binding table. A canvas editor binds a Multica
 * project UUID to one canvas, once; an agent key then cannot create a second canvas for that
 * project (`project-bound`), and an agent key that can edit a bound canvas must name a project
 * (`project-required`). Real server, real /mcp, an agent key as the bearer.
 */

const BOUND = '5e621e12-eeb4-40a5-9571-25657d5b0ec5'
const FREE = '7a1d3f00-0000-4000-8000-000000000001'
const NAMED = '7a1d3f00-0000-4000-8000-000000000002'

let server: Server
let editor: Client
let stranger: Client
let editorKey: string
let strangerKey: string
let boundCanvas: string
let legacyCanvas: string

beforeAll(async () => {
  server = await startServer()
  editor = new Client(server)
  stranger = new Client(server)
  await editor.signUp('binding-editor@test.dev', 'Editor')
  await stranger.signUp('binding-stranger@test.dev', 'Stranger')
  editorKey = ((await (await editor.post('/api/agent-keys', { name: 'k' })).json()) as { secret: string }).secret
  strangerKey = ((await (await stranger.post('/api/agent-keys', { name: 'k' })).json()) as { secret: string }).secret
  boundCanvas = ((await (await editor.post('/api/canvases', { name: 'Multica design' })).json()) as { id: string }).id
  legacyCanvas = ((await (await editor.post('/api/canvases', { name: 'CHE-1 design' })).json()) as { id: string }).id
}, 150_000)

afterAll(() => server?.stop())

type Tool = { isError?: boolean; content: { text: string }[] }

async function callTool(secret: string, name: string, args: Record<string, unknown>): Promise<Tool> {
  const res = await fetch(`${server.base}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${secret}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  })
  return ((await res.json()) as { result: Tool }).result
}

const createCanvas = (secret: string, args: Record<string, unknown>) =>
  callTool(secret, 'create_canvas', { name: 'New', agent_name: 'Ana', ...args })

describe('project binding table', () => {
  it('creates the first canvas for an unbound project', async () => {
    const res = await createCanvas(editorKey, { project_id: FREE })
    expect(res.isError).toBeFalsy()
    expect(JSON.parse(res.content[0]!.text)).toHaveProperty('id')
  })

  it('lets a canvas editor bind a project once, and only a canvas editor', async () => {
    expect(
      (
        await stranger.req(`/api/projects/${BOUND}/canvas`, {
          method: 'PUT',
          body: JSON.stringify({ canvasId: boundCanvas }),
        })
      ).status,
    ).toBe(403)
    const ok = await editor.req(`/api/projects/${BOUND}/canvas`, {
      method: 'PUT',
      body: JSON.stringify({ canvasId: boundCanvas }),
    })
    expect(ok.status).toBe(200)
    expect(await ok.json()).toMatchObject({ projectId: BOUND, canvasId: boundCanvas })
    const again = await editor.req(`/api/projects/${BOUND}/canvas`, {
      method: 'PUT',
      body: JSON.stringify({ canvasId: legacyCanvas }),
    })
    expect(again.status).toBe(409)
    expect(await again.json()).toMatchObject({ error: 'project-bound', canvasId: boundCanvas })
    const read = await editor.get(`/api/projects/${BOUND}/canvas`)
    expect(await read.json()).toMatchObject({ projectId: BOUND, canvasId: boundCanvas })
  })

  it('refuses a second create_canvas for a bound project with project-bound, naming the bound canvas', async () => {
    const res = await createCanvas(editorKey, { project_id: BOUND })
    expect(res.isError).toBe(true)
    expect(res.content[0]!.text).toContain('project-bound')
    expect(res.content[0]!.text).toContain(boundCanvas)
  })

  it('refuses an agent key that can edit a bound canvas and names no project with project-required', async () => {
    const res = await createCanvas(editorKey, {})
    expect(res.isError).toBe(true)
    expect(res.content[0]!.text).toContain('project-required')
  })

  it('lets a key that cannot edit any bound canvas create without a project', async () => {
    const res = await createCanvas(strangerKey, {})
    expect(res.isError).toBeFalsy()
  })

  it('keeps a legacy canvas readable and writable', async () => {
    const read = await callTool(editorKey, 'get_canvas', { canvas_id: legacyCanvas, agent_name: 'Ana' })
    expect(read.isError).toBeFalsy()
    const write = await callTool(editorKey, 'create_frame', {
      canvas_id: legacyCanvas,
      name: 'Legacy',
      html: '<p>legacy</p>',
      agent_name: 'Ana',
    })
    expect(write.isError).toBeFalsy()
  })

  it('finds a binding by project UUID, never by canvas name', async () => {
    await editor.patch(`/api/canvases/${boundCanvas}`, { name: 'Renamed' })
    expect((await createCanvas(editorKey, { project_id: BOUND })).content[0]!.text).toContain('project-bound')
    /* a canvas that is merely NAMED after a project's UUID does not bind that project */
    await editor.post('/api/canvases', { name: NAMED })
    const res = await createCanvas(editorKey, { project_id: NAMED })
    expect(res.isError).toBeFalsy()
  })

  it('treats an upper-case project UUID as the same project', async () => {
    const res = await createCanvas(editorKey, { project_id: BOUND.toUpperCase() })
    expect(res.isError).toBe(true)
    expect(res.content[0]!.text).toContain('project-bound')
  })

  it('rejects a project id that is not a UUID', async () => {
    expect((await editor.get('/api/projects/not-a-uuid/canvas')).status).toBe(400)
    expect((await createCanvas(editorKey, { project_id: 'not-a-uuid' })).isError).toBe(true)
  })
})
