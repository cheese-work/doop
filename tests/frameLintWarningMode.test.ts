import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { findBrowserPath } from '../server/screenshot.ts'
import type { Canvas, Frame } from '../shared/types'
import { Client, startServer, type Server } from './harness.ts'

/* CHE-9115 S3, warning mode: frame-lint findings never change what G3 `check_design_completeness` says. A real server
   and a real Chromium; the browser run is the point, so the file skips only where there is no browser. */

const HEIGHT = 300
const OVERFLOWING = `<div style="height:200px">top</div><div data-doop-id="cut" style="height:200px">cut off</div>`
const FITTING = `<div style="height:100px">top</div><div data-doop-id="fits" style="height:100px">fits</div>`

describe.skipIf(!findBrowserPath())('lint_frames is warning-only for G3', { timeout: 120_000 }, () => {
  let server: Server
  let owner: Client
  let agent: McpClient

  beforeAll(async () => {
    server = await startServer({})
    owner = await new Client(server).signUp('lint-warn@test.dev', 'Lint Warn')
    const { secret } = await (await owner.post('/api/agent-keys', { name: 'Reviewer' })).json()
    agent = new McpClient({ name: 'lint-warning-test', version: '1.0.0' })
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

  async function callTool(name: string, args: Record<string, unknown>) {
    const result = await agent.callTool({ name, arguments: args })
    expect(result.isError, JSON.stringify(result.content)).toBeFalsy()
    const content = result.content as { type: string; text?: string }[]
    return JSON.parse(content.find((item) => item.type === 'text')!.text!)
  }

  /** what G3 decides, without the per-run id */
  const verdict = (r: { complete: boolean; missing: { code: string }[] }) => ({
    complete: r.complete,
    missing: r.missing.map((m) => m.code),
  })

  it('gives the same G3 result with lint findings, without them, and before any lint run', async () => {
    const canvas: Canvas = await (await owner.post('/api/canvases', { name: 'Warning mode' })).json()
    const frame: Frame = await (
      await owner.post(`/api/canvases/${canvas.id}/frames`, {
        name: 'Screen',
        html: OVERFLOWING,
        width: 320,
        height: HEIGHT,
      })
    ).json()
    const g3 = () => callTool('check_design_completeness', { canvas_id: canvas.id, agent_name: 'Reviewer' })

    const before = verdict(await g3())
    /* a verdict with something in it, so "the same" is not two empty answers */
    expect(before.complete).toBe(false)
    expect(before.missing.length).toBeGreaterThan(0)

    /* the browser really ran: the overflowing frame is `ok` with an outside-frame finding, not NOT-RUN */
    const withFindings = await callTool('lint_frames', { canvas_id: canvas.id, agent_name: 'Reviewer' })
    expect(withFindings.frames).toHaveLength(1)
    expect(withFindings.frames[0]).toMatchObject({ frame_id: frame.id, status: 'ok' })
    expect(withFindings.frames[0].findings.map((f: { rule: string }) => f.rule)).toContain('outside-frame')
    expect(withFindings.summary.by_rule['outside-frame']).toBeGreaterThanOrEqual(1)
    const during = verdict(await g3())

    /* fix the frame: the same lint now finds nothing, and G3 still says the same */
    await owner.patch(`/api/frames/${frame.id}`, { html: FITTING })
    const clean = await callTool('lint_frames', { canvas_id: canvas.id, agent_name: 'Reviewer' })
    expect(clean.frames[0]).toMatchObject({ frame_id: frame.id, status: 'ok', findings: [] })
    expect(clean.summary.by_rule['outside-frame'] ?? 0).toBe(0)
    const after = verdict(await g3())

    expect(during).toEqual(before)
    expect(after).toEqual(before)
  })
})
