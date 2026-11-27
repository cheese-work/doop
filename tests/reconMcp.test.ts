import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/* CHE-6627 / G2 on the real MCP path: create_frame with a Multica task, the production comment source
   (httpCommentsSource, over a fake fetch) and the store, with nothing in between stubbed. */
vi.mock('../server/db/persist.ts', () => {
  const noop = () => undefined
  return {
    deleteCanvas: noop,
    deleteFrame: noop,
    deleteGuideline: noop,
    deleteMember: noop,
    deleteReference: noop,
    saveActivity: noop,
    saveCanvas: noop,
    saveCanvasCopy: noop,
    saveFeedback: noop,
    saveFrame: noop,
    appendPageAuthor: noop,
    saveFrameVersion: noop,
    saveGuideline: noop,
    saveMember: noop,
    savePageCopy: noop,
    saveReference: noop,
    saveTask: noop,
  }
})
vi.mock('../server/resident.ts', () => ({ onFeedback: () => {} }))

import * as actions from '../server/actions.ts'
import { buildMcpServer } from '../server/mcp.ts'
import { httpCommentsSource, multicaCommentsSource } from '../server/multicaRuns.ts'
import { assetFactsOf, reconManifestHash, setReconSources } from '../server/reconGuard.ts'
import { expectedCells, hashScan, scanSources } from '../server/reconScan.ts'
import { store } from '../server/store.ts'
import { setTaskIdentityVerifier, systemContext, warmTaskIdentity } from '../server/writePolicy.ts'
import { canvasPages } from '../shared/pages.ts'

const RUN = '01a1d675-3408-7b02-9816-b361c7e895fc'
const ISSUE = '01a1d642-a8dd-75cd-886c-97d80b9e0048'
const AGENT = 'a05b54c4-0d0f-4468-94df-505b69216d31'
const PROJECT = 'proj-a'
const sys = systemContext()
const CONFIG = { apiUrl: 'https://multica.test', token: 'tok', workspaceId: 'ws-1', webUrl: 'https://multica.test/w' }

/** a 1440 or 390 px wide PNG header: all the guard reads */
function png(width: number, tag: string): Buffer {
  const buf = Buffer.alloc(33)
  buf.write('\x89PNG\r\n\x1a\n', 0, 'latin1')
  buf.writeUInt32BE(13, 8)
  buf.write('IHDR', 12, 'latin1')
  buf.writeUInt32BE(width, 16)
  buf.write(tag.slice(0, 8), 24, 'latin1')
  return buf
}

/** a canvas whose page belongs to ISSUE, a locked recon frame with every image uploaded, and the issue's comments */
async function world(opts: { confirm: boolean }) {
  const canvas = store.createCanvas('Multica', 'owner-1')
  const page = canvasPages(canvas)[0]!.id
  store.setPageIssue(canvas.id, page, ISSUE, 'member')
  store.bindProject(sys, canvas.id, PROJECT)
  const scan = scanSources({ 'v/screen.tsx': '<DropdownMenu></DropdownMenu>' }, ['v/screen.tsx'])
  const cells = expectedCells(scan)
  const assets = new Map<string, ReturnType<typeof assetFactsOf>>()
  const recon = {
    scanHash: hashScan(scan),
    mainSha: 'abc1234',
    scan,
    candidates: scan.candidates.map((c) => ({ id: c.id, file: c.file, line: c.line, decision: 'keep' })),
    matrix: cells.map((c, i) => {
      assets.set(`img-${i}`, assetFactsOf(png(c.device, `cell${i}`)))
      return { screen: c.screen, device: c.device, candidate: c.candidate, state: c.state, asset: `img-${i}` }
    }),
  }
  const body = JSON.stringify(recon)
  const frame = store.createFrame(
    sys,
    canvas.id,
    { name: 'Recon', pageId: page, html: `<script type="application/json" id="doop-recon">${body}</script>` },
    'x',
    { kind: 'new' },
  )!
  store.updateFrame(sys, frame.id, { locked: true }, 'x')
  const text = `recon frame ${frame.id}\nrecon-manifest: sha256=${reconManifestHash(body)}\nmain-sha: abc1234\nrecon-images: ${cells.length}`
  const rows = [
    {
      id: 'c0',
      author_type: 'agent',
      author_id: AGENT,
      content: 'starting',
      created_at: new Date(Date.now() - 5000).toISOString(),
    },
    ...(opts.confirm
      ? [
          {
            id: 'c1',
            author_type: 'agent',
            author_id: AGENT,
            content: text,
            created_at: new Date(Date.now() - 1000).toISOString(),
          },
        ]
      : []),
  ]
  const fetchImpl = vi.fn(async (url: string | URL | Request) => {
    expect(String(url)).toBe(`${CONFIG.apiUrl}/api/issues/${ISSUE}/comments`)
    return new Response(JSON.stringify(rows), { status: 200 })
  }) as unknown as typeof fetch
  setReconSources({ assets: async (id) => assets.get(id), comments: httpCommentsSource(CONFIG, fetchImpl).comments })
  return { canvas, page }
}

async function connect() {
  const server = buildMcpServer('Owner', 'owner-1', RUN)
  const client = new Client({ name: 'recon-mcp-test', version: '1.0.0' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await server.connect(b)
  await client.connect(a)
  return { client, close: async () => (await client.close(), await server.close()) }
}

beforeEach(() => {
  vi.spyOn(actions, 'heartbeatAgent').mockImplementation(() => {})
  setTaskIdentityVerifier(async () => ({ running: true, agentId: AGENT, issueId: ISSUE, projectId: PROJECT }))
})
afterEach(() => {
  setTaskIdentityVerifier(undefined)
  setReconSources(undefined)
  vi.restoreAllMocks()
})

const create = async (w: { canvas: { id: string }; page: string }) => {
  await warmTaskIdentity(RUN)
  const { client, close } = await connect()
  try {
    return (await client.callTool({
      name: 'create_frame',
      arguments: { canvas_id: w.canvas.id, pageId: w.page, name: 'Design', html: '<p>design</p>', agent_name: 'Ana' },
    })) as { isError?: boolean; content: { text: string }[] }
  } finally {
    await close()
  }
}

describe('G2 over MCP create_frame, with the production comment source', () => {
  it('draws once the recon is complete, locked and confirmed by this agent on the issue', async () => {
    const w = await world({ confirm: true })
    const res = await create(w)
    expect(res.isError, res.content[0]?.text).toBeFalsy()
    expect(JSON.parse(res.content[0]!.text).ok).toBe(true)
  })

  it('refuses while the issue has no confirmation comment', async () => {
    const w = await world({ confirm: false })
    const res = await create(w)
    expect(res.isError).toBe(true)
    expect(res.content[0]!.text).toMatch(/policy_refused[\s\S]*confirmation comment/)
  })
})

describe('the Multica comment source', () => {
  const ok = (rows: unknown, status = 200) =>
    vi.fn(async () => new Response(JSON.stringify(rows), { status })) as unknown as typeof fetch

  it('keeps agent comments only, with author, time and body', async () => {
    const rows = [
      { author_type: 'agent', author_id: 'a1', content: 'hi', created_at: '2026-11-18T01:00:00Z' },
      { author_type: 'member', author_id: 'm1', content: 'spoof', created_at: '2026-11-18T01:00:00Z' },
      { author_type: 'agent', author_id: 'a2', content: 5, created_at: 'nope' },
    ]
    expect(await httpCommentsSource(CONFIG, ok(rows)).comments(ISSUE)).toEqual([
      { agentId: 'a1', at: Date.parse('2026-11-18T01:00:00Z'), body: 'hi' },
    ])
  })

  it('throws on a Multica error or a payload that is not a list (the guard then refuses)', async () => {
    await expect(httpCommentsSource(CONFIG, ok({}, 500)).comments(ISSUE)).rejects.toThrow(/500/)
    await expect(httpCommentsSource(CONFIG, ok({ not: 'a list' })).comments(ISSUE)).rejects.toThrow(/unexpected/)
  })

  it('exists only when all four settings do', () => {
    expect(multicaCommentsSource({})).toBeUndefined()
    expect(
      multicaCommentsSource({
        MULTICA_API_URL: 'https://m/',
        MULTICA_API_TOKEN: 't',
        MULTICA_WORKSPACE_ID: 'w',
        MULTICA_WEB_URL: 'https://m/w',
      }),
    ).toBeDefined()
  })
})
