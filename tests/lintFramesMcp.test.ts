import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import express from 'express'
import type { Browser } from 'puppeteer-core'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRenderer, type Renderer, type RendererTuning } from '../server/renderBrowser.ts'
import { runLintFrames, setFrameLintDeadlineForTest } from '../server/lintFramesTool.ts'
import { handleMcpRequest } from '../server/mcp.ts'
import { store } from '../server/store.ts'
import { FRAME_RULES, type FrameRule } from '../shared/frameLint.ts'
import type { LintResult } from '../shared/frameLintResult.ts'
import type { Frame } from '../shared/types.ts'

/* CHE-9115 S3: `lint_frames` over HTTP, with the doop MCP handler mounted in-process and a fake renderer behind
   the real gate. Every call runs against a 2 s deadline set through the test hook; the SDK client keeps its
   default 60 s request timeout, so a handler that outlived its own deadline would show as a slow reply. */

const rig = vi.hoisted(() => ({
  renderer: null as null | { withPage: (...args: never[]) => Promise<unknown> },
  /** every load the fake renderer started, in order */
  loads: [] as Array<{ marker: string; width: number }>,
  /** a load for which this returns true never finishes */
  hangs: (_marker: string, _width: number): boolean => false,
  /** how long a load takes, and how many ran at once */
  loadMs: 0,
  live: 0,
  peak: 0,
}))

const never = () => new Promise<never>(() => {})
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

vi.mock('../server/db/persist.ts', () => ({ saveCanvas: () => {}, saveFrame: () => {}, saveActivity: () => {} }))
vi.mock('../server/auth.ts', () => ({
  auth: { api: { getMcpSession: async () => ({ userId: 'lint-owner', clientId: null }) } },
  getUserName: async () => 'Lint Owner',
  isBanned: async () => false,
}))
vi.mock('../server/screenshot.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/screenshot.ts')>()
  return {
    ...actual,
    withRenderPage: (step: string, timeoutMs: number, work: unknown, options: unknown) =>
      (rig.renderer!.withPage as (...args: unknown[]) => Promise<unknown>)(step, timeoutMs, work, options),
    loadFrameInto: async (page: { marker?: string }, frame: { html: string; width: number }) => {
      page.marker = frame.html
      rig.loads.push({ marker: frame.html, width: frame.width })
      if (rig.hangs(frame.html, frame.width)) await never()
      rig.peak = Math.max(rig.peak, ++rig.live)
      if (rig.loadMs) await sleep(rig.loadMs)
      rig.live--
      return true
    },
  }
})

const TUNING: Partial<RendererTuning> = {
  maxConcurrent: 4,
  maxBackground: 2,
  maxQueued: 8,
  queueTimeoutMs: 30_000,
  openTimeoutMs: 1_000,
  leaseMs: 30_000,
  probeTimeoutMs: 1_000,
  closeTimeoutMs: 150,
}

const FACTS = {
  applied: { colorScheme: 'light', lang: '', dir: 'ltr', fontScale: 1 },
  elements: [],
  capped: false,
  fonts_fell_back: false,
}

function fakeBrowser() {
  const browser = {
    connected: true,
    close: async () => {},
    disconnect: async () => {},
    process: () => ({ pid: undefined, exitCode: null, signalCode: null, kill: () => true }),
    createBrowserContext: async () => ({
      newPage: async () => ({
        emulateMediaFeatures: async () => {},
        /* a script string is the helper or axe's source; the axe run takes the rule ids and reports no violations */
        evaluate: async (fn: unknown, arg?: unknown) =>
          typeof fn === 'string' ? undefined : Array.isArray(arg) ? [] : FACTS,
      }),
      close: async () => {},
    }),
  }
  return browser as unknown as Browser
}

function freshRenderer(tuning: Partial<RendererTuning> = {}): Renderer {
  const renderer = createRenderer({
    launch: async () => fakeBrowser(),
    tuning: { ...TUNING, ...tuning },
    log: { warn: () => {}, error: () => {} },
  })
  rig.renderer = renderer as never
  return renderer
}

let http: Server
let base: string
let client: Client

beforeAll(async () => {
  const app = express()
  app.use(express.json({ limit: '1mb' }))
  app.all('/mcp', handleMcpRequest)
  http = createServer(app)
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
  const { port } = http.address() as AddressInfo
  base = `http://127.0.0.1:${port}`
  client = new Client({ name: 'lint-frames-test', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)))
})

afterAll(async () => {
  await client?.close()
  await new Promise((resolve) => http?.close(resolve))
})

let renderer: Renderer
beforeEach(() => {
  rig.loads = []
  rig.hangs = () => false
  rig.loadMs = 0
  rig.live = 0
  rig.peak = 0
  renderer = freshRenderer()
  setFrameLintDeadlineForTest(2_000)
})
afterEach(async () => {
  setFrameLintDeadlineForTest(null)
  await renderer.shutdown()
})

let canvasCount = 0
function seedCanvas(count: number, make: (i: number) => Partial<Frame> = () => ({})): string {
  const id = `lint-canvas-${++canvasCount}`
  const frames: Frame[] = Array.from({ length: count }, (_, i) => ({
    id: `f${i}`,
    canvasId: id,
    pageId: 'p1',
    name: `Frame ${i}`,
    x: i * 1000,
    y: 0,
    width: 800,
    height: 600,
    html: `<!--f${i}-->`,
    createdAt: i + 1,
    updatedAt: i + 1,
    updatedBy: 'test',
    ...make(i),
  }))
  store.canvases.set(id, {
    id,
    name: 'Lint',
    ownerId: 'lint-owner',
    createdAt: 0,
    updatedAt: 0,
    pages: [{ id: 'p1', name: 'Main' }],
    frames,
  } as never)
  return id
}

async function lint(args: Record<string, unknown>) {
  const started = Date.now()
  const reply = await client.callTool({ name: 'lint_frames', arguments: { agent_name: 'Reviewer', ...args } })
  const elapsed = Date.now() - started
  const content = reply.content as Array<{ type: string; text?: string }>
  const text = content.find((c) => c.type === 'text')!.text!
  const bytes = Buffer.byteLength(text)
  expect(elapsed, 'the reply arrives within the 2 s deadline plus margin').toBeLessThan(2_500)
  expect(bytes).toBeLessThanOrEqual(120_000)
  return { isError: !!reply.isError, text, body: JSON.parse(text) as LintResult }
}

describe('lint_frames: the tool contract', () => {
  it('is read-only and says its bounds and how to follow next', async () => {
    const { tools } = await client.listTools()
    const tool = tools.find((t) => t.name === 'lint_frames')!
    expect(tool.annotations?.readOnlyHint).toBe(true)
    expect(tool.description).toContain('45 s')
    expect(tool.description).toContain('120,000')
    expect(tool.description).toMatch(/next/)
    expect(tool.description).toMatch(/after/)
  })

  it('refuses after together with frame_ids, a malformed after and more than 24 ids', async () => {
    const canvas = seedCanvas(3)
    const refusal = async (args: Record<string, unknown>) => {
      try {
        const reply = await client.callTool({
          name: 'lint_frames',
          arguments: { canvas_id: canvas, agent_name: 'R', ...args },
        })
        return reply.isError ? JSON.stringify(reply.content) : null
      } catch (error) {
        return String(error)
      }
    }
    expect(await refusal({ after: '1:f0', frame_ids: ['f1'] })).toContain('cannot be used together')
    expect(await refusal({ after: 'nope' })).toContain('after')
    expect(await refusal({ frame_ids: Array.from({ length: 25 }, (_, i) => `f${i}`) })).toContain('frame_ids')
    expect(await refusal({ frame_ids: ['bad id'] })).toContain('frame_ids')
  })

  it('lints a small page: every frame is a row, page rules say not wired, nothing is left to follow', async () => {
    const canvas = seedCanvas(3, () => ({ width: 393, height: 852 }))
    const { body } = await lint({ canvas_id: canvas })
    expect(body.frames.map((f) => [f.frame_id, f.status])).toEqual([
      ['f0', 'ok'],
      ['f1', 'ok'],
      ['f2', 'ok'],
    ])
    expect(body.frames[0]!.viewports.map((v) => v.width)).toEqual([393, 320])
    expect(body.page_rules).toMatchObject({ scope: 'NOT-RUN', reason: 'not wired' })
    expect(body.blocking).toBe(false)
    expect(body.deadline_ms).toBe(2_000)
    expect(body.next).toBeNull()
    expect(body.omitted.not_reached).toBe(0)
  })

  it('renders two frames at a time', async () => {
    const canvas = seedCanvas(6)
    rig.loadMs = 40
    await lint({ canvas_id: canvas })
    expect(rig.loads).toHaveLength(12)
    expect(rig.peak).toBe(2)
  })
})

describe('lint_frames: the absolute deadline', () => {
  it('(a) a hung second viewport is NOT-RUN deadline, later frames are not reached, and the slot comes back', async () => {
    const canvas = seedCanvas(6)
    rig.hangs = (marker, width) => marker === '<!--f1-->' && width === 320
    const { body } = await lint({ canvas_id: canvas })

    expect(body.frames.map((f) => f.frame_id)).toEqual(['f0', 'f1'])
    expect(body.frames[0]!.status).toBe('ok')
    expect(body.frames[1]).toMatchObject({ status: 'NOT-RUN', reason: 'deadline' })
    expect(body.retry_frame_ids).toContain('f1')
    expect(body.omitted.not_reached).toBe(4)
    expect(body.next).toEqual({ after: '2:f1' })
    expect(body.page_complete).toBe(false)
    await sleep(TUNING.closeTimeoutMs! * 2)
    expect(renderer.status()).toMatchObject({ active: 0, pagesOpen: 0 })
  })

  it('(b) a viewport still queued at the deadline is NOT-RUN deadline and never starts', async () => {
    renderer = freshRenderer({ maxBackground: 1 })
    const holder = await renderer.openPage({ priority: 'background' }) /* the one background slot stays taken */
    const canvas = seedCanvas(2)
    const { body } = await lint({ canvas_id: canvas })

    expect(body.frames[0]).toMatchObject({ frame_id: 'f0', status: 'NOT-RUN', reason: 'deadline' })
    expect(body.frames[0]!.viewports.every((v) => v.status === 'NOT-RUN')).toBe(true)
    expect(body.retry_frame_ids).toContain('f0')
    expect(rig.loads).toEqual([])
    await holder.close()
  })

  it('counts the time spent before the run starts: the abort and the reply keep to T0 + the deadline', async () => {
    const canvasId = seedCanvas(2)
    rig.hangs = () => true
    const spent = 1_200 /* the handler already used this much before runLintFrames was called */
    const started = Date.now()
    const assembled = await runLintFrames({
      canvas: store.canvases.get(canvasId)!,
      pageId: 'p1',
      startedAt: started - spent,
    })
    const elapsed = Date.now() - started
    expect(JSON.parse(assembled.text).frames[0]).toMatchObject({ status: 'NOT-RUN', reason: 'deadline' })
    /* 2 s deadline, 1.2 s gone: the reply is due in 0.8 s, not 2 s after the run began */
    expect(elapsed).toBeLessThan(2_000 - spent + 400)
  })

  it('stops the render when the client goes away', async () => {
    const canvas = seedCanvas(2)
    rig.hangs = () => true
    /* a raw request, so that closing the connection is what the server sees (the SDK client's cancel is a
       separate message that a stateless server never routes to this request) */
    const controller = new AbortController()
    const call = fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'lint_frames', arguments: { canvas_id: canvas, agent_name: 'R' } },
      }),
      signal: controller.signal,
    }).catch((error: unknown) => error)
    await sleep(300)
    expect(renderer.status()).toMatchObject({ active: 2 })
    controller.abort()
    await call
    await sleep(TUNING.closeTimeoutMs! * 3)
    expect(renderer.status()).toMatchObject({ active: 0, pagesOpen: 0 })
  })
})

describe('lint_frames: bounded replies', () => {
  const BIG_NAME = '€'.repeat(20_000)

  it('(d) a metadata flood gives at most 24 rows of capped names, and a second call continues with no gap', async () => {
    const canvas = seedCanvas(5_000, (i) => ({ name: BIG_NAME, html: `<!--f${i}-->` }))
    const first = (await lint({ canvas_id: canvas })).body

    expect(first.page_complete).toBe(false)
    expect(first.window.frames_on_page).toBe(5_000)
    expect(first.frames.length).toBeLessThanOrEqual(24)
    for (const row of first.frames) expect(Buffer.byteLength(row.frame_name)).toBeLessThanOrEqual(120)
    expect(
      first.window.frames_before +
        first.frames.length +
        first.omitted.not_reached +
        first.omitted.rows_byte_cap +
        first.window.frames_after,
    ).toBe(5_000)
    expect(first.next).toEqual({ after: `${first.frames.length}:f${first.frames.length - 1}` })

    const second = (await lint({ canvas_id: canvas, after: (first.next as { after: string }).after })).body
    expect(second.frames[0]!.frame_id).toBe(`f${first.frames.length}`)
    expect(second.window.frames_before).toBe(first.frames.length)
  })

  it('(e) a byte-cap flood returns a prefix of rows, full counts, and resumes at the first cut row', async () => {
    const stub: FrameRule = {
      id: 'stub-rule',
      run: (facts) =>
        facts.viewport.width === facts.frame.width
          ? Array.from({ length: 100 }, (_, i) => ({
              rule: 'stub-rule',
              level: 'warn' as const,
              viewport: facts.viewport,
              element: { selector: `#${i}${'s'.repeat(1_000)}` },
              message: `${i}${'m'.repeat(1_000)}`,
            }))
          : [],
    }
    FRAME_RULES.push(stub)
    try {
      const canvas = seedCanvas(24, () => ({ width: 320 }))
      const first = (await lint({ canvas_id: canvas })).body

      expect(first.frames.length).toBeGreaterThanOrEqual(1)
      expect(first.frames.map((f) => f.frame_id)).toEqual(first.frames.map((_, i) => `f${i}`))
      expect(first.omitted.rows_byte_cap).toBeGreaterThanOrEqual(1)
      for (const row of first.frames) expect(row.findings.length + row.page_findings.length).toBeLessThanOrEqual(40)
      expect(first.summary.by_rule['stub-rule']).toBe(2_400)
      const cutAt = first.frames.length
      expect(first.next).toEqual({ after: `${cutAt}:f${cutAt - 1}` })

      const second = (await lint({ canvas_id: canvas, after: (first.next as { after: string }).after })).body
      expect(second.frames[0]!.frame_id).toBe(`f${cutAt}`)
    } finally {
      FRAME_RULES.splice(FRAME_RULES.indexOf(stub), 1)
    }
  })
})
