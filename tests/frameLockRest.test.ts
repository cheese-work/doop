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

    for (const patch of [{ html: '<h1>After</h1>' }, { width: 111 }, { height: 111 }, { locked: false, width: 111 }]) {
      const res = await owner.patch(`/api/frames/${frame.id}`, patch)
      expect(res.status).toBe(423)
      const body = (await res.json()) as { error: string }
      expect(body.error).toMatch(/Hero/)
      expect(body.error).toMatch(/locked/)
    }
    expect(await read(frame.id)).toEqual(before)
  })

  it('still renames, moves and unlocks, then takes html again', async () => {
    const frame = await newFrame()
    await owner.patch(`/api/frames/${frame.id}`, { html: '<h1>Before</h1>', locked: true })
    const moved = await owner.patch(`/api/frames/${frame.id}`, { name: 'Renamed', x: 40, y: 50 })
    expect(moved.status).toBe(200)
    expect(await moved.json()).toMatchObject({ name: 'Renamed', x: 40, y: 50, html: '<h1>Before</h1>', locked: true })
    expect((await owner.patch(`/api/frames/${frame.id}`, { locked: false })).status).toBe(200)
    const after = await owner.patch(`/api/frames/${frame.id}`, { html: '<h1>After</h1>' })
    expect(after.status).toBe(200)
    expect(((await after.json()) as Frame).html).toBe('<h1>After</h1>')
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
