import { createServer, type Server as HttpServer } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, freePort, startServer, type Server } from './harness.ts'

/**
 * A page's Multica issue link and run list, against the real server and an
 * in-process stand-in for Multica: only a member with edit access binds the
 * issue, nothing an agent or a page-list save sends can change it, and the
 * runs route asks Multica for the bound issue's runs.
 */

const ISSUE = '01a1d642-a8dd-75cd-886c-97d80b9e0048'
const OTHER_ISSUE = '01a1d675-3408-7b02-9816-b361c7e895fc'
const TOKEN = 'multica-test-token'
const WORKSPACE = 'ws-1'

let server: Server
let multica: HttpServer
const asked: { path: string; auth?: string; workspace?: string }[] = []

beforeAll(async () => {
  multica = createServer((req, res) => {
    asked.push({
      path: req.url ?? '',
      auth: req.headers.authorization,
      workspace: req.headers['x-workspace-id'] as string | undefined,
    })
    res.setHeader('Content-Type', 'application/json')
    res.end(
      JSON.stringify([
        {
          id: 'run-old',
          status: 'completed',
          agent_id: 'a1',
          created_at: '2026-11-13T10:00:00Z',
          completed_at: '2026-11-13T10:05:00Z',
        },
        {
          id: 'run-new',
          status: 'running',
          agent_id: 'a2',
          created_at: '2026-11-14T10:00:00Z',
          dispatched_at: '2026-11-14T10:01:00Z',
        },
      ]),
    )
  })
  const multicaPort = await freePort()
  await new Promise<void>((resolve) => multica.listen(multicaPort, '127.0.0.1', resolve))
  server = await startServer({
    MULTICA_API_URL: `http://127.0.0.1:${multicaPort}`,
    MULTICA_API_TOKEN: TOKEN,
    MULTICA_WORKSPACE_ID: WORKSPACE,
    MULTICA_WEB_URL: 'https://multica.test/cheese-work',
  })
}, 120_000)

afterAll(() => {
  server?.stop()
  multica?.close()
})

describe('page issue link and runs', () => {
  let owner: Client
  let stranger: Client
  let canvasId: string
  let pageId: string

  const pagesOf = async () =>
    (await (await owner.get(`/api/canvases/${canvasId}`)).json()).pages as Record<string, unknown>[]
  const bind = (client: Client, issueId: unknown) =>
    client.req(`/api/canvases/${canvasId}/pages/${pageId}/issue`, { method: 'PUT', body: JSON.stringify({ issueId }) })

  beforeAll(async () => {
    owner = new Client(server)
    stranger = new Client(server)
    await owner.signUp('page-issue-owner@test.dev', 'Owner')
    await stranger.signUp('page-issue-stranger@test.dev', 'Stranger')
    const canvas = await (await owner.post('/api/canvases', { name: 'Linked' })).json()
    canvasId = canvas.id
    pageId = canvas.pages?.[0]?.id ?? `${canvasId}:page1`
  })

  it('a member with edit access binds the page to an issue', async () => {
    const res = await bind(owner, ISSUE)
    expect(res.status).toBe(200)
    expect((await pagesOf())[0]).toMatchObject({ id: pageId, issueId: ISSUE, issueSource: 'member' })
  })

  it('refuses a stranger and a malformed id, and keeps the link', async () => {
    expect((await bind(stranger, OTHER_ISSUE)).status).toBeGreaterThanOrEqual(403)
    expect((await bind(owner, 'not-a-uuid')).status).toBe(400)
    expect((await bind(owner, 42)).status).toBe(400)
    expect((await pagesOf())[0]).toMatchObject({ issueId: ISSUE })
  })

  it('a page-list save cannot forge, change or clear the link', async () => {
    const pages = await pagesOf()
    const forged = pages.map((p) => ({ id: p.id, name: p.name, issueId: OTHER_ISSUE, issueSource: 'design' }))
    const res = await owner.req(`/api/canvases/${canvasId}/pages`, {
      method: 'PUT',
      body: JSON.stringify({ pages: forged, expectedPages: pages }),
    })
    expect(res.status).toBe(200)
    expect((await pagesOf())[0]).toMatchObject({ issueId: ISSUE, issueSource: 'member' })
  })

  it('an agent key cannot rebind the page', async () => {
    const key = (await (await owner.post('/api/agent-keys', { name: 'forger' })).json()).secret as string
    const res = await fetch(`${server.base}/api/canvases/${canvasId}/pages/${pageId}/issue`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ issueId: OTHER_ISSUE }),
    })
    expect(res.status).toBeGreaterThanOrEqual(401)
    expect((await pagesOf())[0]).toMatchObject({ issueId: ISSUE })
  })

  it('lists the bound issue runs newest first with hop-in URLs', async () => {
    asked.length = 0
    const res = await owner.get(`/api/canvases/${canvasId}/pages/${pageId}/runs`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.issueId).toBe(ISSUE)
    expect(body.runs.map((r: { id: string }) => r.id)).toEqual(['run-new', 'run-old'])
    expect(body.runs[0]).toMatchObject({
      kind: 'issue',
      status: 'running',
      hopInUrl: `https://multica.test/cheese-work/issues/${ISSUE}?run=run-new`,
    })
    expect(asked).toEqual([{ path: `/api/issues/${ISSUE}/task-runs`, auth: `Bearer ${TOKEN}`, workspace: WORKSPACE }])
  })

  it('a stranger cannot list the runs', async () => {
    expect((await stranger.get(`/api/canvases/${canvasId}/pages/${pageId}/runs`)).status).toBeGreaterThanOrEqual(403)
  })

  it('unknown page is 404; unbinding clears the link', async () => {
    expect((await owner.get(`/api/canvases/${canvasId}/pages/nope/runs`)).status).toBe(404)
    expect((await bind(owner, null)).status).toBe(200)
    expect((await pagesOf())[0]?.issueId).toBeUndefined()
  })
})
