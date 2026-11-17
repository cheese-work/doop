import { createHash } from 'node:crypto'
import { createServer, type Server as HttpServer } from 'node:http'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Canvas, Frame } from '../shared/types'
import { Client, freePort, startServer, type Server } from './harness.ts'

/* CHE-6629: the minimap L1 ledger as a row of the real check_design_completeness
   tool, end to end: real doop server (PGlite), an in-process stand-in for
   Multica's issue and comment routes, and the attestation it stores. */

const ISSUE = '01a1e586-c5e6-71a7-9cae-c5b32b8f2818'
const CHEESE_COMMENT = '01a1e396-a5ea-7267-a4b2-4a888f3297e6'
const TEXTS = [
  'thiếu kebab menu,',
  'Chưa có minimap cho thread board như commit heat map',
  'Chưa có sort threads và comments',
]
const lineId = (commentId: string, n: number, text: string) =>
  `${commentId.slice(0, 8)}#${n}:${createHash('sha1').update(text).digest('hex').slice(0, 8)}`
const ID = TEXTS.map((t, n) => lineId(CHEESE_COMMENT, n, t))

let server: Server
let multica: HttpServer
let owner: Client
let agent: McpClient
let comments: { id: string; author_type: string; content: string }[]
let multicaDown = false
const asked: string[] = []

async function connectAgent(client: Client) {
  const { secret } = await (await client.post('/api/agent-keys', { name: 'Designer' })).json()
  const mcp = new McpClient({ name: 'ledger-test', version: '1.0.0' })
  await mcp.connect(
    new StreamableHTTPClientTransport(new URL('/mcp', server.base), {
      requestInit: { headers: { Authorization: `Bearer ${secret}` } },
    }),
  )
  return mcp
}

beforeAll(async () => {
  multica = createServer((req, res) => {
    asked.push(`${req.url} ${req.headers.authorization}`)
    res.setHeader('Content-Type', 'application/json')
    if (multicaDown) {
      res.statusCode = 503
      return void res.end('{}')
    }
    if (req.url === `/api/issues/${ISSUE}`) return void res.end(JSON.stringify({ id: ISSUE, description: null }))
    if (req.url === `/api/issues/${ISSUE}/comments`) return void res.end(JSON.stringify(comments))
    res.statusCode = 404
    res.end('{}')
  })
  const port = await freePort()
  await new Promise<void>((resolve) => multica.listen(port, '127.0.0.1', resolve))
  server = await startServer({
    MULTICA_API_URL: `http://127.0.0.1:${port}`,
    MULTICA_API_TOKEN: 'ledger-token',
    MULTICA_WORKSPACE_ID: 'ws-1',
    MULTICA_WEB_URL: 'https://multica.test/cheese-work',
  })
  owner = await new Client(server).signUp('ledger@test.dev', 'Ledger Owner')
  agent = await connectAgent(owner)
}, 120_000)

afterAll(async () => {
  await agent?.close()
  server?.stop()
  multica?.close()
})

async function callTool(name: string, args: Record<string, unknown>) {
  const result = await agent.callTool({ name, arguments: args })
  expect(result.isError, JSON.stringify(result.content)).toBeFalsy()
  const content = result.content as { type: string; text?: string }[]
  return JSON.parse(content.find((item) => item.type === 'text')!.text!)
}
const addFrame = async (canvasId: string, name: string, html: string): Promise<Frame> =>
  (await owner.post(`/api/canvases/${canvasId}/frames`, { name, html })).json()
const codes = (r: { missing: { code: string }[] }) => r.missing.map((m) => m.code)

const MOTION = JSON.stringify({
  trigger: 'hover',
  property: 'opacity',
  duration: '200ms',
  easing: 'ease-out',
  reducedMotion: 'none',
})
const hifi = (refIds: string[]) => `<main>${refIds.map((id) => `<div data-req-ref="${id}"></div>`).join('')}
  <p data-doop-state="loading"></p><p data-doop-state="empty"></p><p data-doop-state="error"></p>
  <p data-doop-state-na="disconnected: read-only screen"></p>
  <div data-doop-motion='${MOTION}'></div>
</main>`
const recon = (ledger?: unknown) =>
  `<script type="application/json" id="doop-recon">${JSON.stringify({ scanHash: 's1', candidates: [] })}</script>` +
  (ledger ? `<script type="application/json" id="doop-reqledger">${JSON.stringify(ledger)}</script>` : '')
const mapAll = (ids: string[]) => Object.fromEntries(ids.map((id) => [id, { d: 'map' }]))

it('blocks a dropped minimap line on the real G3 tool, and the stored attestation follows the source', async () => {
  comments = [
    { id: CHEESE_COMMENT, author_type: 'member', content: TEXTS.join('\n\n') },
    { id: '01a1e3ab-972c-758e-85b0-574840d1ea55', author_type: 'agent', content: 'v3 is in doop.' },
  ]
  const canvas: Canvas = await (await owner.post('/api/canvases', { name: 'Minimap' })).json()
  const pageId: string = (await (await owner.get(`/api/canvases/${canvas.id}`)).json()).pages[0].id
  expect(
    (
      await owner.req(`/api/canvases/${canvas.id}/pages/${pageId}/issue`, {
        method: 'PUT',
        body: JSON.stringify({ issueId: ISSUE }),
      })
    ).status,
  ).toBe(200)

  const reconFrame = await addFrame(canvas.id, 'Recon', recon(mapAll([ID[0]!, ID[2]!])))
  const wire = await addFrame(canvas.id, 'Wire', '<div data-doop-stage="wireframe"></div>')
  const design = await addFrame(canvas.id, 'Hi-fi', hifi([ID[0]!, ID[2]!]))
  await owner.patch(`/api/frames/${wire.id}`, {
    html: `<div data-doop-stage="wireframe"><a data-doop-on="click" data-doop-action="navigate:${design.id}">next</a></div>`,
  })
  await callTool('set_prototype_start', { canvas_id: canvas.id, frame_id: wire.id, agent_name: 'Designer' })
  const check = () => callTool('check_design_completeness', { canvas_id: canvas.id, agent_name: 'Designer' })
  const current = async (id: string) => (await (await owner.get(`/api/design-attestations/${id}`)).json()).current

  /* v2.1: the ledger has no minimap line. Blocked, and the stored run says so. */
  const first = await check()
  expect(first.complete).toBe(false)
  expect(codes(first)).toEqual(['req_missing'])
  expect(first.missing[0].detail).toContain(ID[1])
  expect(asked.some((a) => a.includes('Bearer ledger-token'))).toBe(true)
  expect((await (await owner.get(`/api/design-attestations/${first.attestation_id}`)).json()).complete).toBe(false)

  /* the minimap is drawn and mapped: complete, current */
  await owner.patch(`/api/frames/${reconFrame.id}`, { html: recon(mapAll(ID as string[])) })
  await owner.patch(`/api/frames/${design.id}`, { html: hifi(ID as string[]) })
  const second = await check()
  expect(second.missing).toEqual([])
  expect(second.complete).toBe(true)
  expect(second.deferred).toEqual([])
  expect(await current(second.attestation_id)).toBe(true)

  /* Cheese adds a line afterwards: the attestation no longer counts, and a new run is blocked */
  comments.push({ id: '01a1e400-0000-7000-8000-000000000000', author_type: 'member', content: 'và thêm dark mode' })
  expect(await current(second.attestation_id)).toBe(false)
  const third = await check()
  expect(codes(third)).toEqual(['req_missing'])
  comments.pop()
  expect(await current(second.attestation_id)).toBe(true)

  /* defer with a reason: passes, and the line is handed on for the decision card */
  await owner.patch(`/api/frames/${reconFrame.id}`, {
    html: recon({ ...mapAll(ID as string[]), [ID[1]!]: { d: 'defer', reason: 'needs an unread API' } }),
  })
  await owner.patch(`/api/frames/${design.id}`, { html: hifi([ID[0]!, ID[2]!]) })
  const deferred = await check()
  expect(deferred.complete).toBe(true)
  expect(deferred.deferred).toEqual([{ id: ID[1], text: TEXTS[1], reason: 'needs an unread API' }])
  expect(deferred.reviewerNotes.join('\n')).toContain('needs an unread API')

  /* Multica unreachable: no source means no attestation, never a pass */
  multicaDown = true
  const down = await check()
  expect(down.complete).toBe(false)
  expect(codes(down)).toContain('req_source_unavailable')
  expect(await current(deferred.attestation_id)).toBe(false)
  multicaDown = false
  expect(await current(deferred.attestation_id)).toBe(true)

  /* a page with no bound issue has no source: the row says it did not run, and does not block */
  expect(
    (
      await owner.req(`/api/canvases/${canvas.id}/pages/${pageId}/issue`, {
        method: 'PUT',
        body: JSON.stringify({ issueId: null }),
      })
    ).status,
  ).toBe(200)
  const unbound = await check()
  expect(unbound.complete).toBe(true)
  expect(unbound.reviewerNotes.join('\n')).toMatch(/requirement ledger.*not checked/i)
}, 120_000)
