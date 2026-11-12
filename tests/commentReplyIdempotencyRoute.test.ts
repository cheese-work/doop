import WebSocket from 'ws'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, startServer, type Server } from './harness.ts'

/**
 * POST /api/comments/:id/replies with client_request_id against the REAL
 * server (see ./harness.ts), on the embedded database: a retried reply is
 * stored once; the same key with other text is a 409.
 */

let server: Server
let owner: Client
let canvasId: string
let pageId: string

beforeAll(async () => {
  server = await startServer()
  owner = await new Client(server).signUp('owner@test.dev', 'Owner')
  const canvas = await (await owner.post('/api/canvases', { name: 'Replies' })).json()
  canvasId = canvas.id
  pageId = canvas.pages[0].id
}, 70_000)

afterAll(() => server?.stop())

async function root(text = 'Root'): Promise<{ id: string }> {
  const res = await owner.post(`/api/canvases/${canvasId}/comments`, { pageId, x: 1, y: 2, text })
  expect(res.status).toBe(200)
  return res.json()
}

const reply = (id: string, body: Record<string, unknown>) => owner.post(`/api/comments/${id}/replies`, body)

/* the room state a joining client receives: every comment, replies included */
async function replies(rootId: string): Promise<Array<{ id: string; text: string }>> {
  const ws = new WebSocket(`ws://localhost:${server.port}/ws`, { headers: { Cookie: owner.header() } })
  const init = await new Promise<{ comments: Array<{ id: string; text: string; parentId?: string }> }>(
    (resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('ws join timed out')), 8000)
      ws.on('open', () =>
        ws.send(JSON.stringify({ type: 'join', canvasId, clientId: 'reader', name: 'Owner', kind: 'user' })),
      )
      ws.on('message', (d) => {
        const msg = JSON.parse(String(d))
        if (msg.type !== 'init') return
        clearTimeout(timer)
        resolve(msg)
      })
      ws.on('error', reject)
    },
  )
  ws.close()
  return init.comments.filter((c) => c.parentId === rootId)
}

describe('POST /api/comments/:id/replies with client_request_id', () => {
  it('stores a repeated key and text once and answers the repeat with the same reply and replay: true', async () => {
    const { id } = await root()
    const first = await reply(id, { text: 'Done', client_request_id: 'req-1' })
    const firstBody = await first.json()
    expect(first.status).toBe(200)
    expect(firstBody.replay).toBeUndefined()
    const again = await reply(id, { text: 'Done', client_request_id: 'req-1' })
    expect(again.status).toBe(200)
    expect(await again.json()).toMatchObject({ id: firstBody.id, replay: true })
    expect(await replies(id)).toHaveLength(1)
  })

  it('answers the same key with other text 409 and leaves the first reply unchanged', async () => {
    const { id } = await root()
    const first = await (await reply(id, { text: 'Done', client_request_id: 'req-1' })).json()
    const conflict = await reply(id, { text: 'Something else', client_request_id: 'req-1' })
    expect(conflict.status).toBe(409)
    expect(await conflict.json()).toMatchObject({ error: 'client_request_conflict' })
    expect(await replies(id)).toEqual([expect.objectContaining({ id: first.id, text: 'Done' })])
  })

  it('treats different keys as different replies, the same key in another thread as new, and no key as before', async () => {
    const a = await root('A')
    const b = await root('B')
    const ids = new Set<string>()
    for (const [thread, key] of [
      [a.id, 'req-1'],
      [a.id, 'req-2'],
      [b.id, 'req-1'],
      [a.id, undefined],
      [a.id, undefined],
    ] as const) {
      const res = await reply(thread, { text: 'Done', ...(key ? { client_request_id: key } : {}) })
      expect(res.status).toBe(200)
      ids.add((await res.json()).id)
    }
    expect(ids.size).toBe(5)
  })

  it('answers a repeat after the thread was resolved, and a new reply still 404', async () => {
    const { id } = await root()
    const first = await (await reply(id, { text: 'Done', client_request_id: 'req-1' })).json()
    expect((await owner.post(`/api/comments/${id}/resolve`, {})).status).toBe(200)
    const again = await reply(id, { text: 'Done', client_request_id: 'req-1' })
    expect(again.status).toBe(200)
    expect(await again.json()).toMatchObject({ id: first.id, replay: true })
    expect((await reply(id, { text: 'New', client_request_id: 'req-2' })).status).toBe(404)
  })

  it('repeats resolve as a no-op', async () => {
    const { id } = await root()
    const first = await (await owner.post(`/api/comments/${id}/resolve`, {})).json()
    const again = await owner.post(`/api/comments/${id}/resolve`, {})
    expect(again.status).toBe(200)
    expect(await again.json()).toMatchObject({ resolvedAt: first.resolvedAt, resolvedBy: first.resolvedBy })
  })

  it('rejects a key that is not a non-empty string of at most 200 characters', async () => {
    const { id } = await root()
    for (const bad of ['', 7, 'x'.repeat(201)]) {
      expect((await reply(id, { text: 'Done', client_request_id: bad })).status).toBe(400)
    }
    expect(await replies(id)).toHaveLength(0)
  })
})
