import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Canvas, Frame } from '../shared/types'
import { Client, startServer, type Server } from './harness.ts'

/** The lock and the conditional write over REST, against a real server and database. */

const DOC_A = '<!doctype html><html><body><h1>Alpha</h1><p>the first design, by hand</p></body></html>'
const DOC_B =
  '<!doctype html><html><body><main><h2>Beta</h2><section>a completely different design</section></main></body></html>'

let server: Server
let owner: Client

beforeAll(async () => {
  server = await startServer()
  owner = new Client(server)
  await owner.signUp('lockrest@test.dev', 'Lock Rest Owner')
}, 60_000)

afterAll(() => server?.stop())

async function newFrame(name = 'Hero'): Promise<Frame> {
  const canvas: Canvas = await (await owner.post('/api/canvases', { name: 'Lock REST' })).json()
  const frame: Frame = await (await owner.post(`/api/canvases/${canvas.id}/frames`, { name })).json()
  canvasOf.set(frame.id, canvas.id)
  return frame
}

/** the frame as every other client loads it */
async function read(id: string, canvasId = canvasOf.get(id)): Promise<Frame> {
  const canvas: Canvas = await (await owner.get(`/api/canvases/${canvasId}`)).json()
  return canvas.frames.find((f) => f.id === id)!
}
const canvasOf = new Map<string, string>()

describe('a locked frame over REST', () => {
  it('refuses html, width and height writes with 423, naming the frame', async () => {
    const frame = await newFrame('Hero')
    expect((await owner.patch(`/api/frames/${frame.id}`, { html: '<h1>Before</h1>' })).status).toBe(200)
    expect((await owner.patch(`/api/frames/${frame.id}`, { locked: true })).status).toBe(200)
    const before = await read(frame.id)

    for (const patch of [{ html: '<h1>After</h1>' }, { width: 111 }, { height: 111 }]) {
      const res = await owner.patch(`/api/frames/${frame.id}`, patch)
      expect(res.status).toBe(423)
      const body = (await res.json()) as { error: string }
      expect(body.error).toMatch(/Hero/)
      expect(body.error).toMatch(/locked/)
    }
    expect(await read(frame.id)).toEqual(before)
  })

  it('refuses rename, move, an unlock carrying a size change, and an unlock from a user who owns no lock', async () => {
    const frame = await newFrame()
    await owner.patch(`/api/frames/${frame.id}`, { html: '<h1>Before</h1>', locked: true })
    const before = await read(frame.id)
    /* an edit of a locked frame is `frame_locked`; an unlock nobody may make stays `policy_refused` */
    const wanted: [Record<string, unknown>, string][] = [
      [{ name: 'Renamed' }, 'frame_locked'],
      [{ x: 40, y: 50 }, 'frame_locked'],
      [{ locked: false, width: 111 }, 'policy_refused'],
      [{ locked: false }, 'policy_refused'],
    ]
    for (const [patch, code] of wanted) {
      const res = await owner.patch(`/api/frames/${frame.id}`, patch)
      expect(res.status, JSON.stringify(patch)).toBe(423)
      expect(((await res.json()) as { code: string }).code, JSON.stringify(patch)).toBe(code)
    }
    expect(await read(frame.id)).toEqual(before) // no DOOP_LOCK_OWNERS here: unlock has no taker
  })

  it('refuses a streamed append (first chunk and later chunk) with 423', async () => {
    const frame = await newFrame()
    await owner.patch(`/api/frames/${frame.id}`, { html: '<h1>Before</h1>', locked: true })
    for (const body of [{ html_chunk: '<p>x</p>', start: true }, { html_chunk: '<p>x</p>' }]) {
      const res = await owner.post(`/api/frames/${frame.id}/append`, body)
      expect(res.status).toBe(423)
      expect(((await res.json()) as { error: string }).error).toMatch(/locked/)
    }
    expect((await read(frame.id)).html).toBe('<h1>Before</h1>')
  })

  it('refuses a per-frame version restore with 423 and changes nothing', async () => {
    const frame = await newFrame()
    await owner.patch(`/api/frames/${frame.id}`, { html: DOC_A })
    await owner.patch(`/api/frames/${frame.id}`, { html: DOC_B })
    /* versions are filed behind the response, not before it */
    let versions: Array<{ id: string }> = []
    for (const deadline = Date.now() + 3000; versions.length === 0 && Date.now() < deadline;) {
      versions = (await (await owner.get(`/api/frames/${frame.id}/versions`)).json()) as Array<{ id: string }>
      if (versions.length === 0) await new Promise((r) => setTimeout(r, 50))
    }
    expect(versions.length).toBeGreaterThan(0)
    await owner.patch(`/api/frames/${frame.id}`, { locked: true })
    const before = await read(frame.id)

    const res = await owner.post(`/api/frames/${frame.id}/versions/${versions[0]!.id}/restore`)
    expect(res.status).toBe(423)
    expect(((await res.json()) as { error: string }).error).toMatch(/locked/)
    expect(await read(frame.id)).toEqual(before)
  })
})

describe('expectedUpdatedAt over REST', () => {
  it('refuses a stale append with 412 and writes nothing; a current one lands', async () => {
    const frame = await newFrame()
    const { updatedAt } = await read(frame.id)

    const stale = await owner.post(`/api/frames/${frame.id}/append`, {
      html_chunk: '<p>x</p>',
      start: true,
      expectedUpdatedAt: updatedAt - 1,
    })
    expect(stale.status).toBe(412)
    expect(await read(frame.id)).toMatchObject({ html: frame.html, updatedAt })

    const ok = await owner.post(`/api/frames/${frame.id}/append`, {
      html_chunk: '<p>x</p>',
      start: true,
      expectedUpdatedAt: updatedAt,
    })
    expect(ok.status).toBe(200)
    expect(((await ok.json()) as { updatedAt: number }).updatedAt).toBeGreaterThan(updatedAt)
  })

  it('rejects a malformed expectedUpdatedAt with 400', async () => {
    const frame = await newFrame()
    const res = await owner.post(`/api/frames/${frame.id}/append`, { html_chunk: 'x', expectedUpdatedAt: 'now' })
    expect(res.status).toBe(400)
  })

  it('lets two clients that read the same version write once, so no update is lost', async () => {
    const frame = await newFrame()
    const { updatedAt } = await read(frame.id)
    const append = (html_chunk: string) =>
      owner.post(`/api/frames/${frame.id}/append`, { html_chunk, start: true, expectedUpdatedAt: updatedAt })
    const statuses = (await Promise.all([append('<p>A</p>'), append('<p>B</p>')])).map((r) => r.status).sort()
    expect(statuses).toEqual([200, 412])
    const html = (await read(frame.id)).html
    expect(['<p>A</p>', '<p>B</p>']).toContain(html)
  })

  it('keeps 409 for a stale PATCH expectedUpdatedAt', async () => {
    const frame = await newFrame()
    const { updatedAt } = await read(frame.id)
    const res = await owner.patch(`/api/frames/${frame.id}`, { html: '<p>x</p>', expectedUpdatedAt: updatedAt - 1 })
    expect(res.status).toBe(409)
  })
})

describe('lock metadata over REST (S1: who, when and why)', () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

  it('a lock records who, when and why; the first lock wins on a retry', async () => {
    const frame = await newFrame('Hero')
    const t0 = Date.now()
    const first = await owner.patch(`/api/frames/${frame.id}`, { locked: true, reason: 'ready for dev' })
    expect(first.status).toBe(200)
    const locked = await read(frame.id)
    expect(locked).toMatchObject({ locked: true, lockedBy: 'Lock Rest Owner', lockReason: 'ready for dev' })
    expect(locked.lockedAt).toBeGreaterThanOrEqual(t0)

    await sleep(20)
    const again = await owner.patch(`/api/frames/${frame.id}`, { locked: true, reason: 'a later reason' })
    expect(again.status).toBe(200)
    const kept = await read(frame.id)
    expect(kept).toMatchObject({ lockedBy: locked.lockedBy, lockedAt: locked.lockedAt, lockReason: 'ready for dev' })
    expect(kept.updatedAt).toBe(locked.updatedAt)
  })

  it('a lock without a reason leaves the reason empty; create with locked records the actor', async () => {
    const canvas: Canvas = await (await owner.post('/api/canvases', { name: 'Create locked' })).json()
    const created = await owner.post(`/api/canvases/${canvas.id}/frames`, { name: 'Born locked', locked: true })
    expect(created.status).toBe(200)
    const frame = (await created.json()) as Frame
    expect(frame).toMatchObject({ locked: true, lockedBy: 'Lock Rest Owner' })
    expect(frame.lockedAt).toBeGreaterThan(0)
    expect(frame.lockReason).toBeUndefined()
  })

  it('refuses a reason that is not a short string with 400 and locks nothing', async () => {
    const frame = await newFrame()
    for (const reason of [42, 'x'.repeat(501), { a: 1 }]) {
      const res = await owner.patch(`/api/frames/${frame.id}`, { locked: true, reason })
      expect(res.status, JSON.stringify(reason).slice(0, 20)).toBe(400)
    }
    expect((await read(frame.id)).locked).toBeFalsy()
  })

  it('ignores a reason on a write that does not lock', async () => {
    const frame = await newFrame()
    expect((await owner.patch(`/api/frames/${frame.id}`, { name: 'Renamed', reason: 'why' })).status).toBe(200)
    expect((await read(frame.id)).lockReason).toBeUndefined()
  })

  it('answers a refused write with 423 {code: frame_locked, lockedBy, lockedAt, reason} and keeps the error text', async () => {
    const frame = await newFrame('Hero')
    await owner.patch(`/api/frames/${frame.id}`, { locked: true, reason: 'ready for dev' })
    const locked = await read(frame.id)
    const res = await owner.patch(`/api/frames/${frame.id}`, { name: 'Renamed' })
    expect(res.status).toBe(423)
    const body = (await res.json()) as Record<string, unknown>
    expect(body).toMatchObject({
      code: 'frame_locked',
      lockedBy: 'Lock Rest Owner',
      lockedAt: locked.lockedAt,
      reason: 'ready for dev',
    })
    expect(String(body.error)).toMatch(/Hero/)
    expect(String(body.error)).toMatch(/locked/)
  })

  it('answers the 423 of an append and a delete the same way', async () => {
    const frame = await newFrame('Hero')
    await owner.patch(`/api/frames/${frame.id}`, { locked: true })
    const append = await owner.post(`/api/frames/${frame.id}/append`, { html_chunk: '<p>x</p>', start: true })
    expect(append.status).toBe(423)
    expect(await append.json()).toMatchObject({ code: 'frame_locked', lockedBy: 'Lock Rest Owner', reason: null })
    const del = await owner.delete(`/api/frames/${frame.id}`)
    expect(del.status).toBe(423)
    expect(await del.json()).toMatchObject({ code: 'frame_locked' })
  })

  it('treats an unlock carrying any other key as today: refused, the lock fields untouched', async () => {
    const frame = await newFrame()
    await owner.patch(`/api/frames/${frame.id}`, { locked: true, reason: 'ready for dev' })
    const before = await read(frame.id)
    for (const patch of [
      { locked: false, reason: 'why' },
      { locked: false, width: 111 },
      { locked: false, name: 'Renamed' },
    ]) {
      const res = await owner.patch(`/api/frames/${frame.id}`, patch)
      expect(res.status, JSON.stringify(patch)).toBe(423) // no DOOP_LOCK_OWNERS here: no taker
    }
    expect(await read(frame.id)).toEqual(before)
  })

  it('copies of a locked frame start with every lock field empty', async () => {
    const canvas: Canvas = await (await owner.post('/api/canvases', { name: 'Copy source' })).json()
    const frame: Frame = await (await owner.post(`/api/canvases/${canvas.id}/frames`, { name: 'Hero' })).json()
    await owner.patch(`/api/frames/${frame.id}`, { locked: true, reason: 'ready for dev' })
    const copied = await owner.post(`/api/canvases/${canvas.id}/duplicate`, {})
    expect(copied.status).toBe(200)
    const copy = (await copied.json()) as Canvas
    expect(copy.id).not.toBe(canvas.id)
    const loaded: Canvas = await (await owner.get(`/api/canvases/${copy.id}`)).json()
    expect(loaded.frames).toHaveLength(1)
    const dup = loaded.frames[0]!
    expect(dup.locked).toBeFalsy()
    expect(dup.lockedBy).toBeUndefined()
    expect(dup.lockedAt).toBeUndefined()
    expect(dup.lockReason).toBeUndefined()
  })

  it('keeps the lock fields across a server restart', async () => {
    const canvas: Canvas = await (await owner.post('/api/canvases', { name: 'Durable who' })).json()
    const frame: Frame = await (await owner.post(`/api/canvases/${canvas.id}/frames`, { name: 'Kept' })).json()
    await owner.patch(`/api/frames/${frame.id}`, { locked: true, reason: 'ready for dev' })
    const before = await read(frame.id, canvas.id)

    const dataDir = server.dataDir
    server.stop({ keepData: true })
    await server.stopped
    server = await startServer({}, dataDir)
    const again = new Client(server)
    expect(
      (await again.post('/api/auth/sign-in/email', { email: 'lockrest@test.dev', password: 'password12345' })).status,
    ).toBe(200)
    owner = again
    const loaded: Canvas = await (await again.get(`/api/canvases/${canvas.id}`)).json()
    expect(loaded.frames.find((f) => f.id === frame.id)).toMatchObject({
      lockedBy: before.lockedBy,
      lockedAt: before.lockedAt,
      lockReason: 'ready for dev',
    })
  }, 60_000)
})

describe('lock metadata over REST, with a configured lock owner', () => {
  it('an unlock clears who, when and why; a relock records the new actor', async () => {
    const dir = server.dataDir
    const signedUp = new Client(server)
    await signedUp.signUp('lockrest-owner2@test.dev', 'Lock Owner Two')
    const ownerId = ((await (await signedUp.get('/api/auth/get-session')).json()) as { user: { id: string } }).user.id
    server.stop({ keepData: true })
    await server.stopped
    server = await startServer({ DOOP_LOCK_OWNERS: ownerId }, dir)
    const user = new Client(server)
    expect(
      (await user.post('/api/auth/sign-in/email', { email: 'lockrest-owner2@test.dev', password: 'password12345' }))
        .status,
    ).toBe(200)

    const canvas: Canvas = await (await user.post('/api/canvases', { name: 'Unlock clears' })).json()
    const frame: Frame = await (await user.post(`/api/canvases/${canvas.id}/frames`, { name: 'Hero' })).json()
    expect((await user.patch(`/api/frames/${frame.id}`, { locked: true, reason: 'ready for dev' })).status).toBe(200)

    const res = await user.patch(`/api/frames/${frame.id}`, { locked: false })
    expect(res.status).toBe(200)
    const unlocked = (await res.json()) as Frame
    expect(unlocked.locked).toBeFalsy()
    expect(unlocked.lockedBy).toBeUndefined()
    expect(unlocked.lockedAt).toBeUndefined()
    expect(unlocked.lockReason).toBeUndefined()
    const loaded: Canvas = await (await user.get(`/api/canvases/${canvas.id}`)).json()
    const stored = loaded.frames.find((f) => f.id === frame.id)!
    expect(stored.lockedBy).toBeUndefined()
    expect(stored.lockedAt).toBeUndefined()
    expect(stored.lockReason).toBeUndefined()
    expect(stored.lockEpoch).toBe(1) // S1 leaves the epoch to G3

    expect((await user.patch(`/api/frames/${frame.id}`, { locked: true })).status).toBe(200)
    const relocked = (await (await user.get(`/api/canvases/${canvas.id}`)).json()) as Canvas
    expect(relocked.frames.find((f) => f.id === frame.id)).toMatchObject({ lockedBy: 'Lock Owner Two', lockEpoch: 1 })
  }, 90_000)
})
