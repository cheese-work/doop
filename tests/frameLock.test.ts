import { afterAll, beforeAll, expect, it } from 'vitest'
import type { Canvas, Frame } from '../shared/types'
import { Client, startServer, type Server } from './harness.ts'

let server: Server
let owner: Client

beforeAll(async () => {
  server = await startServer()
  owner = new Client(server)
  await owner.signUp('lock@test.dev', 'Lock Owner')
}, 60_000)

afterAll(() => server?.stop())

it('locks and unlocks a frame through the frame update API', async () => {
  const canvas: Canvas = await (await owner.post('/api/canvases', { name: 'Locks' })).json()
  const frame: Frame = await (await owner.post(`/api/canvases/${canvas.id}/frames`, { name: 'Hero' })).json()
  expect(frame.locked).toBeUndefined()

  const locked = await owner.patch(`/api/frames/${frame.id}`, { locked: true })
  expect(locked.status).toBe(200)
  expect(((await locked.json()) as Frame).locked).toBe(true)

  /* the lock is part of the frame everyone loads, not a client-side flag */
  const loaded: Canvas = await (await owner.get(`/api/canvases/${canvas.id}`)).json()
  expect(loaded.frames.find((f) => f.id === frame.id)?.locked).toBe(true)

  /* CHE-6626: a lock is real. Every write is refused, the owner's own included (423 Locked), nothing changes */
  const moved = await owner.patch(`/api/frames/${frame.id}`, { x: 40, name: 'Hero v2' })
  expect(moved.status).toBe(423)
  expect(((await moved.json()) as { code: string }).code).toBe('policy_refused')
  const after: Canvas = await (await owner.get(`/api/canvases/${canvas.id}`)).json()
  expect(after.frames.find((f) => f.id === frame.id)).toMatchObject({ name: 'Hero', locked: true })

  /* only a configured lock owner unlocks; none is configured here, so even the canvas owner is refused */
  const unlocked = await owner.patch(`/api/frames/${frame.id}`, { locked: false })
  expect(unlocked.status).toBe(423)
  expect((await owner.delete(`/api/frames/${frame.id}`)).status).toBe(423)
})

it('keeps the lock across a server restart', async () => {
  const canvas: Canvas = await (await owner.post('/api/canvases', { name: 'Durable locks' })).json()
  const frame: Frame = await (await owner.post(`/api/canvases/${canvas.id}/frames`, { name: 'Kept' })).json()
  expect((await owner.patch(`/api/frames/${frame.id}`, { locked: true })).status).toBe(200)

  const dataDir = server.dataDir
  server.stop({ keepData: true })
  await server.stopped
  server = await startServer({}, dataDir)

  const again = new Client(server)
  expect(
    (await again.post('/api/auth/sign-in/email', { email: 'lock@test.dev', password: 'password12345' })).status,
  ).toBe(200)
  const loaded: Canvas = await (await again.get(`/api/canvases/${canvas.id}`)).json()
  expect(loaded.frames.find((f) => f.id === frame.id)?.locked).toBe(true)
}, 60_000)
