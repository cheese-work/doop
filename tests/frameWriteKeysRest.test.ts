import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Canvas, Frame } from '../shared/types'
import { Client, startServer, type Server } from './harness.ts'

/** Frame writes with an idempotency key over REST, against a real server and database. */

let server: Server
let owner: Client

beforeAll(async () => {
  server = await startServer()
  owner = new Client(server)
  await owner.signUp('fwkrest@test.dev', 'Write Keys Owner')
}, 60_000)

afterAll(() => server?.stop())

const canvasOf = new Map<string, string>()
async function newFrame(): Promise<Frame> {
  const canvas: Canvas = await (await owner.post('/api/canvases', { name: 'Keys REST' })).json()
  const frame: Frame = await (await owner.post(`/api/canvases/${canvas.id}/frames`, { name: 'Hero' })).json()
  canvasOf.set(frame.id, canvas.id)
  return frame
}
async function read(id: string): Promise<Frame> {
  const canvas: Canvas = await (await owner.get(`/api/canvases/${canvasOf.get(id)}`)).json()
  return canvas.frames.find((f) => f.id === id)!
}
const versions = async (id: string) =>
  (await (await owner.get(`/api/frames/${id}/versions`)).json()) as Array<{ id: string; name?: string }>

describe('PATCH /api/frames/:id html with idempotency_key', () => {
  it('answers a retry with 200, the first result and replay: true, and writes nothing', async () => {
    const frame = await newFrame()
    const body = { html: '<h1>New</h1>', idempotency_key: 'k1', version_name: 'draft' }
    const first = await owner.patch(`/api/frames/${frame.id}`, body)
    expect(first.status).toBe(200)
    const firstBody = (await first.json()) as { versionId: string; updatedAt: number; replay?: boolean }
    expect(firstBody.replay).toBeFalsy()
    const again = await owner.patch(`/api/frames/${frame.id}`, body)
    expect(again.status).toBe(200)
    expect(await again.json()).toMatchObject({ replay: true, versionId: firstBody.versionId })
    const named = (await versions(frame.id)).filter((v) => v.id === firstBody.versionId)
    expect(named).toHaveLength(1)
    expect(named[0]!.name).toBe('draft')
    expect((await read(frame.id)).updatedAt).toBe(firstBody.updatedAt)
  })

  it('answers the same key with another payload with 409 and writes nothing', async () => {
    const frame = await newFrame()
    await owner.patch(`/api/frames/${frame.id}`, { html: '<h1>One</h1>', idempotency_key: 'k1' })
    const res = await owner.patch(`/api/frames/${frame.id}`, { html: '<h1>Two</h1>', idempotency_key: 'k1' })
    expect(res.status).toBe(409)
    expect((await read(frame.id)).html).toBe('<h1>One</h1>')
  })

  it('checks the key before expectedUpdatedAt: a replay is 200 even when the frame moved on', async () => {
    const frame = await newFrame()
    const body = { html: '<h1>One</h1>', idempotency_key: 'k1', expectedUpdatedAt: frame.updatedAt }
    expect((await owner.patch(`/api/frames/${frame.id}`, body)).status).toBe(200)
    await owner.patch(`/api/frames/${frame.id}`, { html: '<h1>Later</h1>' })
    const again = await owner.patch(`/api/frames/${frame.id}`, body)
    expect(again.status).toBe(200)
    expect(await again.json()).toMatchObject({ replay: true })
    expect((await read(frame.id)).html).toBe('<h1>Later</h1>')
  })

  it('a new key with a stale expectedUpdatedAt is 412', async () => {
    const frame = await newFrame()
    const res = await owner.patch(`/api/frames/${frame.id}`, {
      html: '<h1>One</h1>',
      idempotency_key: 'k2',
      expectedUpdatedAt: frame.updatedAt - 1,
    })
    expect(res.status).toBe(412)
    expect((await read(frame.id)).html).not.toBe('<h1>One</h1>')
  })

  it('answers 500, not a hang, when the database refuses the write, and leaves the frame as it was', async () => {
    const frame = await newFrame()
    const before = await read(frame.id)
    // a NUL byte is not valid in a Postgres text column: the commit fails
    const res = await owner.patch(`/api/frames/${frame.id}`, { html: '<h1>\u0000</h1>', idempotency_key: 'kdb' })
    expect(res.status).toBe(500)
    expect((await read(frame.id)).html).toBe(before.html)
    const ok = await owner.patch(`/api/frames/${frame.id}`, { html: '<h1>fine</h1>', idempotency_key: 'kdb' })
    expect(ok.status).toBe(200)
  }, 15_000)

  it('refuses a key on a patch that carries more than html', async () => {
    const frame = await newFrame()
    const res = await owner.patch(`/api/frames/${frame.id}`, { html: '<h1>One</h1>', x: 5, idempotency_key: 'k3' })
    expect(res.status).toBe(400)
  })
})

describe('POST /api/frames/:id/append with idempotency_key', () => {
  it('does not append a retried chunk twice', async () => {
    const frame = await newFrame()
    await owner.post(`/api/frames/${frame.id}/append`, { html_chunk: '<h1>A</h1>', start: true, idempotency_key: 'c1' })
    const chunk = { html_chunk: '<p>B</p>', idempotency_key: 'c2' }
    const first = await owner.post(`/api/frames/${frame.id}/append`, chunk)
    expect(first.status).toBe(200)
    const again = await owner.post(`/api/frames/${frame.id}/append`, chunk)
    expect(again.status).toBe(200)
    expect(await again.json()).toMatchObject({ replay: true })
    expect((await read(frame.id)).html).toBe('<h1>A</h1><p>B</p>')
    const clash = await owner.post(`/api/frames/${frame.id}/append`, { html_chunk: '<p>C</p>', idempotency_key: 'c2' })
    expect(clash.status).toBe(409)
  })
})
