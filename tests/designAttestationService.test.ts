import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Canvas, Frame } from '../shared/types'
import { Client, startServer, type Server } from './harness.ts'

/* G4 service read route (CHE-7080, plan CHE-7064 r3 D1.7): Multica reads an
   attestation with one shared bearer token instead of a user session. */

const TOKEN = 'attestation-read-token-0123456789abcdef-xyz'
const ISSUE = '01a1d642-a8dd-75cd-886c-97d80b9e0048'
const ROUTE = '/api/service/design-attestations'

/* a complete page, the same shape tests/designAttestation.test.ts builds: only a complete run can be current */
const RECON = JSON.stringify({
  scanHash: 'scan-1',
  candidates: [{ id: 'sort-oldest', file: 'display-parts.tsx', line: 29, decision: 'keep' }],
})
const MOTION = JSON.stringify({
  trigger: 'hover',
  property: 'opacity',
  duration: '200ms',
  easing: 'ease-out',
  reducedMotion: 'none',
})
const HIFI = `<main>
  <button data-recon-ref="sort-oldest">Oldest</button>
  <p data-doop-state="loading"></p><p data-doop-state="empty"></p><p data-doop-state="error"></p>
  <p data-doop-state-na="disconnected: read-only screen"></p>
  <div data-doop-motion='${MOTION}'></div>
</main>`

describe('service read route, token unset', () => {
  let bare: Server
  beforeAll(async () => {
    bare = await startServer()
  }, 60_000)
  afterAll(() => bare?.stop())

  it('answers 503 to every request, with or without a token', async () => {
    expect((await fetch(`${bare.base}${ROUTE}/anything`)).status).toBe(503)
    const withToken = await fetch(`${bare.base}${ROUTE}/anything`, { headers: { Authorization: `Bearer ${TOKEN}` } })
    expect(withToken.status).toBe(503)
  })
})

describe('service read route, token set', () => {
  let server: Server
  let owner: Client
  let agent: McpClient
  let canvas: Canvas
  let pageId: string
  let design: Frame
  let attestationId: string

  const read = (id: string, auth?: string) =>
    fetch(`${server.base}${ROUTE}/${id}`, { headers: auth ? { Authorization: auth } : {} })
  const bearer = `Bearer ${TOKEN}`

  beforeAll(async () => {
    server = await startServer({ DOOP_ATTESTATION_READ_TOKEN: TOKEN })
    owner = await new Client(server).signUp('svc-attest@test.dev', 'Svc Owner')
    const { secret } = await (await owner.post('/api/agent-keys', { name: 'Reviewer' })).json()
    agent = new McpClient({ name: 'svc-attestation-test', version: '1.0.0' })
    await agent.connect(
      new StreamableHTTPClientTransport(new URL('/mcp', server.base), {
        requestInit: { headers: { Authorization: `Bearer ${secret}` } },
      }),
    )
    canvas = await (await owner.post('/api/canvases', { name: 'Svc proposal' })).json()
    pageId = canvas.pages?.[0]?.id ?? `${canvas.id}:page1`
    const addFrame = async (name: string, html: string): Promise<Frame> =>
      (await owner.post(`/api/canvases/${canvas.id}/frames`, { name, html })).json()
    await addFrame('Recon', `<script type="application/json" id="doop-recon">${RECON}</script>`)
    const wire = await addFrame('Wire', '<div data-doop-stage="wireframe"></div>')
    design = await addFrame('Hi-fi', HIFI)
    await owner.patch(`/api/frames/${wire.id}`, {
      html: `<div data-doop-stage="wireframe"><a data-doop-on="click" data-doop-action="navigate:${design.id}">next</a></div>`,
    })
    await agent.callTool({
      name: 'set_prototype_start',
      arguments: { canvas_id: canvas.id, frame_id: wire.id, agent_name: 'Reviewer' },
    })
    const result = await agent.callTool({
      name: 'check_design_completeness',
      arguments: { canvas_id: canvas.id, agent_name: 'Reviewer' },
    })
    const text = (result.content as { type: string; text?: string }[]).find((c) => c.type === 'text')!.text!
    attestationId = JSON.parse(text).attestation_id
  }, 120_000)

  afterAll(async () => {
    await agent?.close()
    server?.stop()
  })

  it('refuses a missing token with 401', async () => {
    expect((await read(attestationId)).status).toBe(401)
  })

  it('refuses a wrong token with 401', async () => {
    expect((await read(attestationId, 'Bearer nope')).status).toBe(401)
    expect((await read(attestationId, `Bearer ${TOKEN}x`)).status).toBe(401)
    expect((await read(attestationId, TOKEN)).status).toBe(401)
  })

  it('answers 404 for an unknown id', async () => {
    expect((await read('nope', bearer)).status).toBe(404)
  })

  it('serves GET only', async () => {
    const res = await fetch(`${server.base}${ROUTE}/${attestationId}`, {
      method: 'DELETE',
      headers: { Authorization: bearer },
    })
    expect(res.status).toBeGreaterThanOrEqual(401)
    expect(res.status).not.toBe(200)
  })

  it('returns the view with current true and pageIssueId null while the page has no issue', async () => {
    const res = await read(attestationId, bearer)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      id: attestationId,
      canvasId: canvas.id,
      pageId,
      current: true,
      pageIssueId: null,
    })
  })

  it('reports the attested page issue id once the page is bound', async () => {
    const bind = await owner.req(`/api/canvases/${canvas.id}/pages/${pageId}/issue`, {
      method: 'PUT',
      body: JSON.stringify({ issueId: ISSUE }),
    })
    expect(bind.status).toBe(200)
    expect((await (await read(attestationId, bearer)).json()).pageIssueId).toBe(ISSUE)
  })

  it('reports current false after a frame edit', async () => {
    await owner.patch(`/api/frames/${design.id}`, { html: HIFI + '<!-- edited -->' })
    const res = await read(attestationId, bearer)
    expect(res.status).toBe(200)
    expect((await res.json()).current).toBe(false)
  })
})
