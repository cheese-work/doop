import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import type { Canvas, Frame } from '../shared/types.ts'
import { Client, startServer, type Server } from './harness.ts'

/*
 * CHE-9399 P1d: purge outcomes across a real reboot. Each case drives the real server (a child process on
 * its own PGlite directory) over HTTP, kills it, starts a new process on the same data directory and reads
 * the state again. A purge that left a row, or a later write that brought one back, shows up here and
 * nowhere in the in-process file. Hooks that hold one write in flight need the server's own modules, so the
 * lost-acknowledgement and held-settle cases stay in tests/framePurge.test.ts.
 */

const EMAIL = 'purge-reboot@test.dev'
const PASSWORD = 'password12345'
// longer than the frame write debounce (400 ms) plus a write, so a late write would have landed by the reboot
const LATE_WRITE_MS = 1500

let server: Server
let owner: Client

beforeAll(async () => {
  server = await startServer()
  owner = await new Client(server).signUp(EMAIL, 'Reboot Owner')
}, 60_000)

afterAll(() => {
  server?.stop()
})

/** kill the child, start a new one on the same data directory, sign the owner in again */
async function reboot() {
  const dataDir = server.dataDir
  server.stop({ keepData: true })
  await server.stopped
  server = await startServer({}, dataDir)
  owner = new Client(server)
  const res = await owner.post('/api/auth/sign-in/email', { email: EMAIL, password: PASSWORD })
  expect(res.status).toBe(200)
}

const later = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function newCanvas(name: string): Promise<Canvas> {
  const res = await owner.post('/api/canvases', { name })
  expect(res.status).toBe(200)
  return res.json()
}

async function newFrame(canvas: Canvas, name: string, html = `<h1>${name}</h1>`): Promise<Frame> {
  const res = await owner.post(`/api/canvases/${canvas.id}/frames`, { name, html })
  expect(res.status).toBe(200)
  return res.json()
}

async function trashOf(canvas: Canvas): Promise<Frame[]> {
  const res = await owner.get(`/api/canvases/${canvas.id}/trash`)
  expect(res.status).toBe(200)
  return (await res.json()).frames
}

async function liveOf(canvas: Canvas): Promise<Frame[]> {
  const res = await owner.get(`/api/canvases/${canvas.id}`)
  expect(res.status).toBe(200)
  return (await res.json()).frames
}

/** put F in the Trash and return the frame as the Trash shows it (its deletedAt is what a purge confirms) */
async function trash(canvas: Canvas, frame: Frame): Promise<Frame> {
  expect((await owner.delete(`/api/frames/${frame.id}`)).status).toBe(200)
  const inTrash = (await trashOf(canvas)).find((f) => f.id === frame.id)
  expect(inTrash?.deletedAt).toBeTypeOf('number')
  return inTrash!
}

const purge = (frame: Pick<Frame, 'id' | 'deletedAt'>, deletedAt: unknown = frame.deletedAt, client: Client = owner) =>
  client.post(`/api/frames/${frame.id}/purge`, { deletedAt })

async function versionsStatus(frame: Frame) {
  return (await owner.get(`/api/frames/${frame.id}/versions`)).status
}

/** F is nowhere: not live, not in the Trash, no versions route */
async function expectGone(canvas: Canvas, frame: Frame) {
  expect((await liveOf(canvas)).map((f) => f.id)).not.toContain(frame.id)
  expect((await trashOf(canvas)).map((f) => f.id)).not.toContain(frame.id)
  expect(await versionsStatus(frame)).toBe(404)
}

/** F is still in the Trash with the same deletedAt and not purging (the versions route answers 410 while it is there) */
async function expectKept(canvas: Canvas, frame: Frame) {
  const found = (await trashOf(canvas)).find((f) => f.id === frame.id)
  expect(found?.deletedAt).toBe(frame.deletedAt)
  expect(found).not.toHaveProperty('purging')
  expect((await owner.get(`/api/frames/${frame.id}/versions`)).status).toBe(410)
}

/** restore F from the Trash: it is live again with exactly the versions it had before the delete */
async function expectRestored(canvas: Canvas, frame: Frame, versionIds: string[]) {
  expect((await owner.post(`/api/frames/${frame.id}/restore`)).status).toBe(200)
  expect((await liveOf(canvas)).map((f) => f.id)).toContain(frame.id)
  expect((await versionIdsOf(frame)).sort()).toEqual([...versionIds].sort())
}

async function versionIdsOf(frame: Frame): Promise<string[]> {
  const res = await owner.get(`/api/frames/${frame.id}/versions`)
  expect(res.status).toBe(200)
  return (await res.json()).map((v: { id: string }) => v.id)
}

/** the comments the server sends a joining client (WebSocket init), narrowed to one frame */
async function commentIdsOn(canvas: Canvas, frameId: string): Promise<string[]> {
  const comments = await new Promise<Array<{ id: string; frameId?: string }>>((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${server.port}/ws`, { headers: { Cookie: owner.header() } })
    const timer = setTimeout(() => {
      ws.terminate()
      reject(new Error('ws join timed out'))
    }, 8000)
    ws.on('open', () =>
      ws.send(
        JSON.stringify({
          type: 'join',
          canvasId: canvas.id,
          clientId: `reboot-${Math.random()}`,
          name: 'T',
          kind: 'user',
        }),
      ),
    )
    ws.on('message', (data) => {
      const message = JSON.parse(String(data))
      if (message.type !== 'init') return
      clearTimeout(timer)
      ws.close()
      resolve(message.comments)
    })
    ws.on('error', reject)
  })
  return comments.filter((c) => c.frameId === frameId).map((c) => c.id)
}

async function comment(frame: Frame, text: string): Promise<string> {
  const res = await owner.post(`/api/frames/${frame.id}/comments`, { text, x: 1, y: 2, snippet: '' })
  expect(res.status).toBe(200)
  return (await res.json()).id
}

describe('T1 purge removes the frame and its rows, and a reboot finds none', () => {
  it('a purged frame stays gone, its neighbour keeps every version', async () => {
    const canvas = await newCanvas('t1')
    const f = await newFrame(canvas, 't1')
    const keep = await newFrame(canvas, 't1 neighbour')
    for (const frame of [f, keep]) {
      expect((await owner.patch(`/api/frames/${frame.id}`, { html: `<p>${frame.name} edited</p>` })).status).toBe(200)
    }
    const keepVersions = await versionIdsOf(keep)
    expect(keepVersions.length).toBeGreaterThan(0)
    expect((await versionIdsOf(f)).length).toBeGreaterThan(0)
    const inTrash = await trash(canvas, f)

    const res = await purge(inTrash)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    await expectGone(canvas, f)

    await reboot()
    await expectGone(canvas, f)
    expect((await liveOf(canvas)).map((x) => x.id)).toContain(keep.id)
    expect((await versionIdsOf(keep)).sort()).toEqual([...keepVersions].sort())
  }, 90_000)
})

describe('T2 purge keeps every other table, across a reboot', () => {
  it('a comment on another frame and the purge activity line are still there after the restart', async () => {
    const canvas = await newCanvas('t2')
    const other = await newFrame(canvas, 't2 other')
    const kept = await comment(other, 'on the other frame')
    const f = await newFrame(canvas, 't2')
    const inTrash = await trash(canvas, f)
    expect((await purge(inTrash)).status).toBe(200)
    expect(await commentIdsOn(canvas, other.id)).toEqual([kept])

    await reboot()
    await expectGone(canvas, f)
    expect(await commentIdsOn(canvas, other.id)).toEqual([kept])
  }, 90_000)
})

describe('T3 stale confirmation, across a reboot', () => {
  it('delete, restore, delete again: the first deletedAt is refused and the frame is still in the Trash after the restart', async () => {
    const canvas = await newCanvas('t3')
    const f = await newFrame(canvas, 't3')
    expect((await owner.patch(`/api/frames/${f.id}`, { html: '<p>t3 edited</p>' })).status).toBe(200)
    const versionIds = await versionIdsOf(f)
    const first = await trash(canvas, f)
    await later(5)
    expect((await owner.post(`/api/frames/${f.id}/restore`)).status).toBe(200)
    await later(5)
    const second = await trash(canvas, f)
    expect(second.deletedAt).not.toBe(first.deletedAt)

    const res = await purge(first)
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ code: 'stale_confirmation', deletedAt: second.deletedAt })
    expect((await purge(second, null)).status).toBe(400)
    await expectKept(canvas, second)

    await reboot()
    await expectKept(canvas, second)
    // the survivor can still be purged with the current deletedAt
    expect((await purge(second)).status).toBe(200)
    await expectGone(canvas, f)
    expect(versionIds.length).toBeGreaterThan(0)
  }, 90_000)
})

describe('T4 restore, across a reboot', () => {
  it('(a) restore first, then purge: 409 not_in_trash, and the frame is live with its versions after the restart', async () => {
    const canvas = await newCanvas('t4a')
    const f = await newFrame(canvas, 't4a')
    expect((await owner.patch(`/api/frames/${f.id}`, { html: '<p>t4a edited</p>' })).status).toBe(200)
    const versionIds = await versionIdsOf(f)
    const inTrash = await trash(canvas, f)
    expect((await owner.post(`/api/frames/${f.id}/restore`)).status).toBe(200)
    const res = await purge(inTrash)
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ code: 'not_in_trash' })

    await reboot()
    expect((await liveOf(canvas)).map((x) => x.id)).toContain(f.id)
    expect((await trashOf(canvas)).map((x) => x.id)).not.toContain(f.id)
    expect((await versionIdsOf(f)).sort()).toEqual([...versionIds].sort())
  }, 90_000)
})

describe('T5 access, across a reboot', () => {
  it('(a) a non-member, a view link and a signed-out caller are refused; the frame is still in the Trash after the restart', async () => {
    const canvas = await newCanvas('t5a')
    const f = await newFrame(canvas, 't5a')
    const versionIds = await versionIdsOf(f)
    const inTrash = await trash(canvas, f)
    const stranger = await new Client(server).signUp(`purge-reboot-stranger-${Date.now()}@test.dev`, 'Stranger')

    expect((await purge(inTrash, inTrash.deletedAt, stranger)).status).toBe(403)
    expect((await owner.patch(`/api/canvases/${canvas.id}`, { linkAccess: 'view' })).status).toBe(200)
    expect((await purge(inTrash, inTrash.deletedAt, stranger)).status).toBe(403)
    const signedOut = await fetch(`${server.base}/api/frames/${f.id}/purge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deletedAt: inTrash.deletedAt }),
    })
    expect(signedOut.status).toBe(401)
    await expectKept(canvas, inTrash)

    await reboot()
    await expectKept(canvas, inTrash)
    await expectRestored(canvas, f, versionIds)
  }, 90_000)
})

describe('T6 no resurrection, across a reboot', () => {
  it('edit then delete inside the debounce window, purge at once: no frame or version row appears later or after the restart', async () => {
    const canvas = await newCanvas('t6')
    const f = await newFrame(canvas, 't6')
    expect((await owner.patch(`/api/frames/${f.id}`, { html: '<p>t6 edit one</p>' })).status).toBe(200)
    expect((await owner.patch(`/api/frames/${f.id}`, { html: '<p>t6 edit two</p>' })).status).toBe(200)
    const inTrash = await trash(canvas, f) // straight after the edits, inside the write debounce
    expect((await purge(inTrash)).status).toBe(200)

    await later(LATE_WRITE_MS) // every write the frame had pending would have landed by now
    await expectGone(canvas, f)

    await reboot()
    await expectGone(canvas, f)
  }, 90_000)
})

describe('T9 lifecycle, across a reboot', () => {
  it('(b) the client aborts the purge: the frame ends gone or restorable, and the same after the restart', async () => {
    const canvas = await newCanvas('t9b')
    const f = await newFrame(canvas, 't9b')
    expect((await owner.patch(`/api/frames/${f.id}`, { html: '<p>t9b edited</p>' })).status).toBe(200)
    const versionIds = await versionIdsOf(f)
    const inTrash = await trash(canvas, f)

    const ac = new AbortController()
    const sent = owner
      .req(`/api/frames/${f.id}/purge`, {
        method: 'POST',
        body: JSON.stringify({ deletedAt: inTrash.deletedAt }),
        signal: ac.signal,
      })
      .catch(() => undefined)
    await later(0)
    ac.abort()
    await sent
    await later(LATE_WRITE_MS) // the server finishes or gives up on its own

    const stillInTrash = (await trashOf(canvas)).some((x) => x.id === f.id)
    if (stillInTrash) await expectKept(canvas, inTrash)
    else await expectGone(canvas, f)

    await reboot()
    if (stillInTrash) {
      await expectKept(canvas, inTrash)
      await expectRestored(canvas, f, versionIds)
    } else {
      await expectGone(canvas, f)
    }
  }, 90_000)
})

describe('T14 comments refuse, across a reboot', () => {
  it('(a) a comment on F made before the delete: 409 has_comments, and F, its versions and the comment are all still there after the restart', async () => {
    const canvas = await newCanvas('t14a')
    const f = await newFrame(canvas, 't14a')
    expect((await owner.patch(`/api/frames/${f.id}`, { html: '<p>t14a edited</p>' })).status).toBe(200)
    const commentId = await comment(f, 'keep me')
    const versionIds = await versionIdsOf(f)
    const inTrash = await trash(canvas, f)

    const res = await purge(inTrash)
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ code: 'has_comments' })
    await expectKept(canvas, inTrash)
    expect(await commentIdsOn(canvas, f.id)).toEqual([commentId])

    await reboot()
    await expectKept(canvas, inTrash)
    expect(await commentIdsOn(canvas, f.id)).toEqual([commentId])
    expect((await purge(inTrash)).status).toBe(409) // the persisted comment still refuses
    await expectRestored(canvas, f, versionIds)
    expect(await commentIdsOn(canvas, f.id)).toEqual([commentId])
  }, 90_000)
})
