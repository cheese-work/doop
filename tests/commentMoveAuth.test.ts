import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, startServer, type Server } from './harness.ts'
import type { ElementComment } from '../shared/types.ts'

/**
 * PATCH /api/comments/:id/anchor against the REAL server: a visitor who may
 * only comment must not retarget an editor's pending agent command. Without
 * an API key the resident never claims work, so a command stays pending.
 */

let server: Server
let owner: Client
let visitor: Client
let canvasId: string
let frameA: string
let frameB: string

beforeAll(async () => {
  server = await startServer({ RESIDENT_TASK_LIMIT: '100' })
  owner = await new Client(server).signUp('owner@test.dev', 'Owner')
  visitor = await new Client(server).signUp('visitor@test.dev', 'Visitor')
  const canvas = await (await owner.post('/api/canvases', { name: 'Moves' })).json()
  canvasId = canvas.id
  expect((await owner.patch(`/api/canvases/${canvasId}`, { linkAccess: 'comment' })).status).toBe(200)
  const mk = async (name: string) =>
    (
      await (
        await owner.post(`/api/canvases/${canvasId}/frames`, { name, width: 200, height: 100, html: '<p>Hi</p>' })
      ).json()
    ).id as string
  frameA = await mk('A')
  frameB = await mk('B')
}, 70_000)

afterAll(() => server?.stop())

const onFrame = (frameId: string) => ({ frameId, selector: 'body', snippet: '', x: 5, y: 5 })

async function thread(text: string, replyText?: string) {
  const rootRes = await owner.post(`/api/frames/${frameA}/comments`, { selector: 'p', snippet: '<p>Hi</p>', text })
  const root = (await rootRes.json()) as ElementComment
  expect(rootRes.status, JSON.stringify(root)).toBe(200)
  let reply: ElementComment | undefined
  if (replyText) {
    const replyRes = await owner.post(`/api/comments/${root.id}/replies`, { text: replyText })
    reply = (await replyRes.json()) as ElementComment
    expect(replyRes.status, JSON.stringify(reply)).toBe(200)
  }
  return { root, reply }
}

describe('PATCH /api/comments/:id/anchor with a pending agent command', () => {
  it('refuses a comment-only visitor and keeps the target on frame A', async () => {
    const { root } = await thread('@doop make the heading red')
    expect(root.forAgent).toBe(true)
    const res = await visitor.patch(`/api/comments/${root.id}/anchor`, onFrame(frameB))
    expect(res.status).toBe(403)
    const reply = await (await owner.post(`/api/comments/${root.id}/replies`, { text: 'still here' })).json()
    expect(reply.frameId).toBe(frameA)
  })

  it('refuses a comment-only visitor when the command sits in a reply', async () => {
    const { root, reply } = await thread('plain note', '@doop make it blue')
    expect(reply?.forAgent).toBe(true)
    const res = await visitor.patch(`/api/comments/${root.id}/anchor`, onFrame(frameB))
    expect(res.status).toBe(403)
    const viaReply = await visitor.patch(`/api/comments/${reply!.id}/anchor`, onFrame(frameB))
    expect(viaReply.status).toBe(403)
  })

  it('lets an editor move that thread', async () => {
    const { root } = await thread('@doop make the heading green')
    const res = await owner.patch(`/api/comments/${root.id}/anchor`, onFrame(frameB))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ id: root.id, frameId: frameB })
  })

  it('keeps an ordinary thread movable by a commenter', async () => {
    const { root } = await thread('just a note', 'a plain reply')
    const res = await visitor.patch(`/api/comments/${root.id}/anchor`, onFrame(frameB))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ id: root.id, frameId: frameB })
  })
})
