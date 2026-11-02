import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { Client, startServer, type Server } from './harness.ts'

/**
 * Chat bridge S1 against the REAL server: GET/PUT /api/canvases/:id/bridge for
 * people, set_bridge_agents / bridge_heartbeat for the watcher's agent key.
 */

let server: Server
let owner: Client
let stranger: Client
let ownerKey: string
let strangerKey: string
let canvasId: string

const bridgeUrl = (id = canvasId) => `/api/canvases/${id}/bridge`
const getBridge = async (client = owner) => (await client.get(bridgeUrl())).json()
const put = (body: unknown, client = owner, id = canvasId) =>
  client.req(bridgeUrl(id), { method: 'PUT', body: JSON.stringify(body) })

async function mint(client: Client): Promise<string> {
  return ((await (await client.post('/api/agent-keys', { name: 'watcher' })).json()) as { secret: string }).secret
}

/** Call one MCP tool as the key's account; returns the parsed JSON text or the error text. */
async function tool(secret: string, name: string, args: Record<string, unknown>) {
  const client = new McpClient({ name: 'bridge-test', version: '1.0.0' })
  const transport = new StreamableHTTPClientTransport(new URL(`${server.base}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${secret}` } },
  })
  await client.connect(transport)
  try {
    const result = (await client.callTool({ name, arguments: args })) as {
      isError?: boolean
      content: Array<{ text?: string }>
    }
    const body = result.content.map((c) => c.text ?? '').join('')
    return { isError: !!result.isError, body, json: result.isError ? undefined : (JSON.parse(body) as unknown) }
  } finally {
    await client.close()
  }
}

beforeAll(async () => {
  server = await startServer()
  owner = await new Client(server).signUp('bridge-owner@test.dev', 'Owner')
  stranger = await new Client(server).signUp('bridge-stranger@test.dev', 'Stranger')
  ownerKey = await mint(owner)
  strangerKey = await mint(stranger)
  canvasId = ((await (await owner.post('/api/canvases', { name: 'Bridge' })).json()) as { id: string }).id
}, 70_000)

afterAll(() => server?.stop())

describe('GET/PUT /api/canvases/:id/bridge', () => {
  it('starts empty: nothing selected, no agents, watcher never seen', async () => {
    expect(await getBridge()).toEqual({
      agentRef: null,
      agentName: null,
      agents: [],
      watcherSeenAt: null,
      status: 'no_agent_selected',
    })
  })

  it('needs access to the canvas, exactly like comments', async () => {
    expect((await stranger.get(bridgeUrl())).status).toBe(403)
    expect((await put({ agentRef: 'a1' }, stranger)).status).toBe(403)
    expect((await owner.get(bridgeUrl('missing'))).status).toBe(404)
    expect((await put({ agentRef: 'a1' }, owner, 'missing')).status).toBe(404)
    expect((await fetch(server.base + bridgeUrl())).status).toBe(401)
  })

  it('rejects a body that is not a string ref or null', async () => {
    expect((await put({ agentRef: 7 })).status).toBe(400)
    expect((await put({})).status).toBe(400)
    expect((await put({ agentRef: 'x'.repeat(201) })).status).toBe(400)
  })

  it('reports watcher_unreachable for a selection before the watcher ever reports', async () => {
    const res = await put({ agentRef: 'a1' })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ agentRef: 'a1', status: 'watcher_unreachable' })
  })
})

describe('watcher tools', () => {
  it('set_bridge_agents publishes the list and stamps the watcher; status turns ok', async () => {
    const out = await tool(ownerKey, 'set_bridge_agents', {
      canvas_id: canvasId,
      agents: [
        { ref: 'a1', name: 'Sol' },
        { ref: 'a2', name: 'Luna' },
      ],
    })
    expect(out.isError, out.body).toBe(false)
    const bridge = await getBridge()
    expect(bridge.agents).toEqual([
      { ref: 'a1', name: 'Sol' },
      { ref: 'a2', name: 'Luna' },
    ])
    expect(bridge.watcherSeenAt).toBeGreaterThan(Date.now() - 10_000)
    expect(bridge).toMatchObject({ agentRef: 'a1', agentName: 'Sol', status: 'ok' })
  })

  it('selecting a listed agent stores its name; a clear returns no_agent_selected', async () => {
    expect(await (await put({ agentRef: 'a2' })).json()).toMatchObject({
      agentRef: 'a2',
      agentName: 'Luna',
      status: 'ok',
    })
    expect(await (await put({ agentRef: null })).json()).toMatchObject({
      agentRef: null,
      agentName: null,
      status: 'no_agent_selected',
    })
  })

  it('a republished list that drops the selected agent gives agent_not_found', async () => {
    await put({ agentRef: 'a2' })
    await tool(ownerKey, 'set_bridge_agents', { canvas_id: canvasId, agents: [{ ref: 'a1', name: 'Sol' }] })
    expect(await getBridge()).toMatchObject({ agentRef: 'a2', status: 'agent_not_found' })
  })

  it('set_bridge_agents replaces the list and drops duplicate refs', async () => {
    await tool(ownerKey, 'set_bridge_agents', {
      canvas_id: canvasId,
      agents: [
        { ref: 'a2', name: 'Luna' },
        { ref: 'a2', name: 'Luna again' },
      ],
    })
    const bridge = await getBridge()
    expect(bridge.agents).toEqual([{ ref: 'a2', name: 'Luna' }])
    expect(bridge.status).toBe('ok')
  })

  it('bridge_heartbeat stamps the watcher without touching the list or selection', async () => {
    const before = (await getBridge()).watcherSeenAt as number
    await new Promise((r) => setTimeout(r, 5))
    const out = await tool(ownerKey, 'bridge_heartbeat', { canvas_id: canvasId })
    expect(out.isError, out.body).toBe(false)
    const after = await getBridge()
    expect(after.watcherSeenAt).toBeGreaterThan(before)
    expect(after).toMatchObject({ agentRef: 'a2', agents: [{ ref: 'a2', name: 'Luna' }], status: 'ok' })
  })

  it('refuses a key whose account cannot reach the canvas', async () => {
    const list = await tool(strangerKey, 'set_bridge_agents', {
      canvas_id: canvasId,
      agents: [{ ref: 'z', name: 'Z' }],
    })
    const beat = await tool(strangerKey, 'bridge_heartbeat', { canvas_id: canvasId })
    expect(list.isError).toBe(true)
    expect(beat.isError).toBe(true)
    expect((await getBridge()).agents).toEqual([{ ref: 'a2', name: 'Luna' }])
  })

  it('rejects a blank ref or name', async () => {
    const out = await tool(ownerKey, 'set_bridge_agents', { canvas_id: canvasId, agents: [{ ref: ' ', name: 'x' }] })
    expect(out.isError).toBe(true)
  })
})
