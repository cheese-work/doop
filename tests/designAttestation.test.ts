import { createHash } from 'node:crypto'
import { createServer, type Server as HttpServer } from 'node:http'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Canvas, Frame } from '../shared/types'
import { addMotionAndDocs, sloplintFor } from './motionFixtures.ts'
import { Client, freePort, startServer, type Server } from './harness.ts'

/* G3 end to end (CHE-6078 r5): the check_design_completeness tool, the stored
   attestation, and what happens to it when a frame changes or the server restarts. */

let server: Server
let owner: Client
let stranger: Client
let agent: McpClient
let multica: HttpServer
let serverEnv: Record<string, string> = {}

/* the page is bound to an issue with no requirement lines: the ledger runs and finds nothing (an unchecked ledger never attests) */
const ISSUE = '01a1e586-c5e6-71a7-9cae-c5b32b8f2818'

async function connectAgent(client: Client) {
  const { secret } = await (await client.post('/api/agent-keys', { name: 'Reviewer' })).json()
  const mcp = new McpClient({ name: 'attestation-test', version: '1.0.0' })
  await mcp.connect(
    new StreamableHTTPClientTransport(new URL('/mcp', server.base), {
      requestInit: { headers: { Authorization: `Bearer ${secret}` } },
    }),
  )
  return mcp
}

beforeAll(async () => {
  multica = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json')
    if (req.url === `/api/issues/${ISSUE}`)
      return void res.end(JSON.stringify({ id: ISSUE, identifier: 'CHE-77', description: null }))
    if (req.url === `/api/issues/${ISSUE}/comments`) return void res.end('[]')
    res.statusCode = 404
    res.end('{}')
  })
  const port = await freePort()
  await new Promise<void>((resolve) => multica.listen(port, '127.0.0.1', resolve))
  serverEnv = {
    MULTICA_API_URL: `http://127.0.0.1:${port}`,
    MULTICA_API_TOKEN: 'attest-token',
    MULTICA_WORKSPACE_ID: 'ws-1',
  }
  server = await startServer(serverEnv)
  owner = await new Client(server).signUp('attest@test.dev', 'Attest Owner')
  stranger = await new Client(server).signUp('attest-stranger@test.dev', 'Stranger')
  agent = await connectAgent(owner)
}, 60_000)

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

const RECON = JSON.stringify({
  scanHash: 'scan-1',
  candidates: [
    { id: 'kebab', file: 'comment-card.tsx', line: 823, decision: 'keep' },
    { id: 'sort-oldest', file: 'display-parts.tsx', line: 29, decision: 'keep' },
  ],
})
const MOTION = JSON.stringify({
  trigger: 'hover',
  property: 'opacity',
  duration: '200ms',
  easing: 'ease-out',
  reducedMotion: 'none',
})
const hifi = (kebab: boolean) => `<main>
  ${kebab ? '<button data-recon-ref="kebab">⋯</button>' : ''}<button data-recon-ref="sort-oldest">Oldest</button>
  <p data-doop-state="loading"></p><p data-doop-state="empty"></p><p data-doop-state="error"></p>
  <p data-doop-state-na="disconnected: read-only screen"></p>
  <div data-doop-motion='${MOTION}'></div>
</main>`

async function addFrame(canvasId: string, name: string, html: string): Promise<Frame> {
  return (await owner.post(`/api/canvases/${canvasId}/frames`, { name, html })).json()
}

it('stores an attestation per run and ends it when a frame changes', async () => {
  const canvas: Canvas = await (await owner.post('/api/canvases', { name: 'Proposal' })).json()
  const pageId: string = (await (await owner.get(`/api/canvases/${canvas.id}`)).json()).pages[0].id
  expect(
    (
      await owner.req(`/api/canvases/${canvas.id}/pages/${pageId}/issue`, {
        method: 'PUT',
        body: JSON.stringify({ issueId: ISSUE }),
      })
    ).status,
  ).toBe(200)
  await addFrame(canvas.id, 'Recon', `<script type="application/json" id="doop-recon">${RECON}</script>`)
  const wire = await addFrame(
    canvas.id,
    'Wire',
    '<div data-doop-stage="wireframe"><a data-doop-on="click" data-doop-action="navigate:HIFI">next</a></div>',
  )
  const design = await addFrame(canvas.id, 'Hi-fi', hifi(false))
  await addMotionAndDocs(owner, canvas.id, 'CHE-77', ['Hi-fi'])
  await owner.patch(`/api/frames/${wire.id}`, {
    html: `<div data-doop-stage="wireframe"><a data-doop-on="click" data-doop-action="navigate:${design.id}">next</a></div>`,
  })
  await callTool('set_prototype_start', { canvas_id: canvas.id, frame_id: wire.id, agent_name: 'Reviewer' })

  /* g3-r7: no sloplint result, or one whose digest does not match what was sent, leaves every design frame without one */
  const codesOf = (r: { missing: { code: string }[] }) => r.missing.map((m) => m.code)
  const bare = await callTool('check_design_completeness', { canvas_id: canvas.id, agent_name: 'Reviewer' })
  expect(codesOf(bare).filter((c) => c === 'sloplint_missing')).toHaveLength(3)
  const forged = (await sloplintFor(owner, canvas.id)).map((e) => ({ ...e, sha256: 'f'.repeat(64) }))
  const tampered = await callTool('check_design_completeness', {
    canvas_id: canvas.id,
    sloplint: forged,
    agent_name: 'Reviewer',
  })
  expect(codesOf(tampered).filter((c) => c === 'sloplint_missing')).toHaveLength(3)
  /* a NOT-RUN marker or a null with a matching digest is still no result */
  for (const body of ['null', '{"status":"NOT-RUN"}']) {
    const sha256 = createHash('sha256').update(body).digest('hex')
    const hollow = (await sloplintFor(owner, canvas.id)).map((e) => ({ ...e, result_json: body, sha256 }))
    const r = await callTool('check_design_completeness', {
      canvas_id: canvas.id,
      sloplint: hollow,
      agent_name: 'Reviewer',
    })
    expect(
      codesOf(r).filter((c) => c === 'sloplint_missing'),
      body,
    ).toHaveLength(3)
  }

  /* the kebab is missing: the run is stored as incomplete */
  const first = await callTool('check_design_completeness', {
    canvas_id: canvas.id,
    sloplint: await sloplintFor(owner, canvas.id),
    agent_name: 'Reviewer',
  })
  expect(first.complete).toBe(false)
  expect(first.missing.map((m: { code: string }) => m.code)).toEqual(['recon_ref_missing'])
  expect(first.attestation_id).toEqual(expect.any(String))
  const stored = await (await owner.get(`/api/design-attestations/${first.attestation_id}`)).json()
  expect(stored).toMatchObject({ complete: false, current: false, canvasId: canvas.id, scanHash: 'scan-1' })

  /* draw it, run again: a complete, current attestation naming the exact versions */
  const fixed = await (await owner.patch(`/api/frames/${design.id}`, { html: hifi(true) })).json()
  const second = await callTool('check_design_completeness', {
    canvas_id: canvas.id,
    sloplint: await sloplintFor(owner, canvas.id),
    agent_name: 'Reviewer',
  })
  expect(second.missing).toEqual([])
  expect(second.complete).toBe(true)
  /* the attested inputs keep each verified sloplint result */
  expect(second.inputs.sloplint).toHaveLength(3)
  for (const e of second.inputs.sloplint) expect(e).toMatchObject({ status: 'ok', resultJson: '{"findings":[]}' })
  const ok = await (await owner.get(`/api/design-attestations/${second.attestation_id}`)).json()
  expect(ok).toMatchObject({ complete: true, current: true })
  expect(ok.frames).toContainEqual({ frameId: design.id, updatedAt: fixed.updatedAt })
  expect(ok.frames.map((f: { frameId: string }) => f.frameId)).not.toContain(
    (await (await owner.get(`/api/canvases/${canvas.id}`)).json()).frames.find((f: Frame) => f.name === 'Recon').id,
  )

  /* it survives a restart */
  const dataDir = server.dataDir
  await agent.close()
  server.stop({ keepData: true })
  await server.stopped
  server = await startServer(serverEnv, dataDir)
  owner = new Client(server)
  expect(
    (await owner.post('/api/auth/sign-in/email', { email: 'attest@test.dev', password: 'password12345' })).status,
  ).toBe(200)
  stranger = new Client(server)
  expect(
    (await stranger.post('/api/auth/sign-in/email', { email: 'attest-stranger@test.dev', password: 'password12345' }))
      .status,
  ).toBe(200)
  agent = await connectAgent(owner)
  const again = await (await owner.get(`/api/design-attestations/${second.attestation_id}`)).json()
  expect(again).toMatchObject({ complete: true, current: true })

  /* a frame edited after the run: the old attestation no longer counts */
  await owner.patch(`/api/frames/${design.id}`, { html: hifi(true) + '<!-- tweak -->' })
  const stale = await (await owner.get(`/api/design-attestations/${second.attestation_id}`)).json()
  expect(stale).toMatchObject({ complete: true, current: false })

  /* the recon frame and the flow start are inputs too (Terra P1, f60f6d6) */
  const third = await callTool('check_design_completeness', {
    canvas_id: canvas.id,
    sloplint: await sloplintFor(owner, canvas.id),
    agent_name: 'Reviewer',
  })
  expect(third.complete).toBe(true)
  const read = async () => (await (await owner.get(`/api/design-attestations/${third.attestation_id}`)).json()).current
  expect(await read()).toBe(true)
  const recon: Frame = (await (await owner.get(`/api/canvases/${canvas.id}`)).json()).frames.find(
    (f: Frame) => f.name === 'Recon',
  )
  await owner.patch(`/api/frames/${recon.id}`, { html: recon.html + '<!-- recon changed -->' })
  expect(await read()).toBe(false)
  const fourth = await callTool('check_design_completeness', {
    canvas_id: canvas.id,
    sloplint: await sloplintFor(owner, canvas.id),
    agent_name: 'Reviewer',
  })
  expect(fourth.complete).toBe(true)
  const readRun = async (id: string) => (await (await owner.get(`/api/design-attestations/${id}`)).json()).current
  expect(await readRun(fourth.attestation_id)).toBe(true)

  /* the Motion page is an input too (Terra P1, 9ebc904): an edit to its animated frame ends the run */
  const fade: Frame = (await (await owner.get(`/api/canvases/${canvas.id}`)).json()).frames.find(
    (f: Frame) => f.name === 'Fade',
  )
  await owner.patch(`/api/frames/${fade.id}`, { html: '<div></div>' })
  expect(await readRun(fourth.attestation_id)).toBe(false)
  const broken = await callTool('check_design_completeness', {
    canvas_id: canvas.id,
    sloplint: await sloplintFor(owner, canvas.id),
    agent_name: 'Reviewer',
  })
  /* one finding for each spec row that names Fade (the fixture has two) */
  expect(broken.missing.map((m: { code: string }) => m.code)).toEqual(['motion_frame_missing', 'motion_frame_missing'])
  await owner.patch(`/api/frames/${fade.id}`, { html: fade.html })
  const fifth = await callTool('check_design_completeness', {
    canvas_id: canvas.id,
    sloplint: await sloplintFor(owner, canvas.id),
    agent_name: 'Reviewer',
  })
  expect(fifth.complete).toBe(true)
  expect(await readRun(fifth.attestation_id)).toBe(true)

  /* a component rename writes no frame, yet names are inputs (Terra P1, 6784db0b): it ends the run and the next check finds the spec row missing */
  const button = (
    (await (await owner.get(`/api/canvases/${canvas.id}/components`)).json()) as { id: string; name: string }[]
  ).find((c) => c.name === 'Button')!
  const renamed = await owner.patch(`/api/canvases/${canvas.id}/components/${button.id}`, { name: 'Action' })
  expect(renamed.status).toBe(200)
  expect(await readRun(fifth.attestation_id)).toBe(false)
  const afterRename = await callTool('check_design_completeness', {
    canvas_id: canvas.id,
    sloplint: await sloplintFor(owner, canvas.id),
    agent_name: 'Reviewer',
  })
  expect(afterRename.complete).toBe(false)
  expect(afterRename.missing).toContainEqual(
    expect.objectContaining({
      code: 'motion_per_micro_interaction',
      detail: expect.stringContaining('"Action · hover" has no row'),
    }),
  )
  /* naming it back: a fresh run is complete again */
  expect((await owner.patch(`/api/canvases/${canvas.id}/components/${button.id}`, { name: 'Button' })).status).toBe(200)
  const restored = await callTool('check_design_completeness', {
    canvas_id: canvas.id,
    sloplint: await sloplintFor(owner, canvas.id),
    agent_name: 'Reviewer',
  })
  expect(restored.complete).toBe(true)
  expect(await readRun(restored.attestation_id)).toBe(true)
  expect(await readRun(afterRename.attestation_id)).toBe(false)

  await callTool('set_prototype_start', { canvas_id: canvas.id, frame_id: design.id, agent_name: 'Reviewer' })
  expect(await readRun(restored.attestation_id)).toBe(false)

  /* nobody else can read it, and nothing writes to it */
  expect((await stranger.get(`/api/design-attestations/${second.attestation_id}`)).status).toBe(403)
  expect((await owner.get('/api/design-attestations/nope')).status).toBe(404)
  expect(
    (await owner.req(`/api/design-attestations/${second.attestation_id}`, { method: 'DELETE' })).status,
  ).toBeGreaterThanOrEqual(404)
}, 120_000)
