import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { Client, startServer, type Server } from './harness.ts'
import type { ElementComment } from '../shared/types.ts'

/**
 * POST /api/comments/:id/resolve with a reason (CHE-9308 S4), against the REAL
 * server: `addressed` needs a ref, `wont_fix` a one-line note, `moved` a ref;
 * a body-less call still resolves with no reason (MCP `resolve_comment`).
 */

let server: Server
let owner: Client
let canvasId: string
let pageId: string

beforeAll(async () => {
  server = await startServer({ RESIDENT_TASK_LIMIT: '0' })
  owner = await new Client(server).signUp('owner@test.dev', 'Owner')
  const canvas = await (await owner.post('/api/canvases', { name: 'Resolve' })).json()
  canvasId = canvas.id
  pageId = canvas.pages[0].id
}, 150_000)

afterAll(() => server?.stop())

async function newComment(text = 'Fix this'): Promise<ElementComment> {
  const res = await owner.post(`/api/canvases/${canvasId}/comments`, { pageId, x: 1, y: 2, text })
  expect(res.status).toBe(200)
  return res.json()
}

const resolve = (id: string, body?: unknown) => owner.post(`/api/comments/${id}/resolve`, body)

/** the comments the room hands a client that joins now */
async function roomComments(): Promise<ElementComment[]> {
  const ws = new WebSocket(`ws://localhost:${server.port}/ws`, { headers: { Cookie: owner.header() } })
  const init = await new Promise<{ comments: ElementComment[] }>((ok, fail) => {
    const timer = setTimeout(() => fail(new Error('ws join timed out')), 8000)
    ws.on('open', () => ws.send(JSON.stringify({ type: 'join', canvasId, clientId: 'r', name: 'Owner', kind: 'user' })))
    ws.on('message', (d) => {
      const msg = JSON.parse(String(d))
      if (msg.type !== 'init') return
      clearTimeout(timer)
      ok(msg)
    })
    ws.on('error', fail)
  })
  ws.close()
  return init.comments
}

describe('POST /api/comments/:id/resolve with a reason', () => {
  it('stores and returns addressed with its ref', async () => {
    const c = await newComment()
    const res = await resolve(c.id, { reason: 'addressed', ref: 'v3' })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ id: c.id, resolution: 'addressed', resolutionRef: 'v3' })
    expect((await roomComments()).find((x) => x.id === c.id)).toMatchObject({
      resolution: 'addressed',
      resolutionRef: 'v3',
    })
  })

  it('stores and returns wont_fix with its note', async () => {
    const c = await newComment()
    const res = await resolve(c.id, { reason: 'wont_fix', note: 'Works as designed' })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ resolution: 'wont_fix', resolutionNote: 'Works as designed' })
  })

  it('stores and returns moved with the Multica issue key', async () => {
    const c = await newComment()
    const res = await resolve(c.id, { reason: 'moved', ref: 'CHE-123' })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ resolution: 'moved', resolutionRef: 'CHE-123' })
  })

  it('answers 400 for each missing or bad field and leaves the comment open', async () => {
    const c = await newComment()
    const bad = [
      { reason: 'addressed' },
      { reason: 'addressed', ref: '   ' },
      { reason: 'wont_fix' },
      { reason: 'wont_fix', note: '  ' },
      { reason: 'wont_fix', note: 'two\nlines' },
      { reason: 'moved' },
      { reason: 'moved', ref: 42 },
      { reason: 'nope', ref: 'x' },
      { ref: 'x' },
    ]
    for (const body of bad) expect((await resolve(c.id, body)).status, JSON.stringify(body)).toBe(400)
    expect((await roomComments()).find((x) => x.id === c.id)?.resolvedAt).toBeUndefined()
  })

  it('still resolves with no body, and no reason is recorded', async () => {
    const c = await newComment()
    const res = await resolve(c.id)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.resolvedAt).toBeTypeOf('number')
    expect(body.resolution ?? null).toBeNull()
    const empty = await newComment()
    expect((await resolve(empty.id, {})).status).toBe(200)
  })

  it('keeps the first resolution when a thread is resolved twice', async () => {
    const c = await newComment()
    await resolve(c.id, { reason: 'addressed', ref: 'v1' })
    const again = await resolve(c.id, { reason: 'moved', ref: 'CHE-9' })
    expect(again.status).toBe(200)
    expect(await again.json()).toMatchObject({ resolution: 'addressed', resolutionRef: 'v1' })
  })
})
