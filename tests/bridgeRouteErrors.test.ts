import express from 'express'
import type { Server as HttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

/* A database failure must come back as an HTTP 500, never as a request that
 * hangs: Express 4 does not forward a rejected async handler by itself. */
vi.mock('../server/bridge.ts', () => ({ getBridge: vi.fn(), selectBridgeAgent: vi.fn() }))

import * as bridge from '../server/bridge.ts'
import { bridgeRouter } from '../server/bridgeRoutes.ts'

const CANVAS = { id: 'c1' }
let server: HttpServer
let base: string

beforeAll(async () => {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    req.user = { id: 'u1' } as typeof req.user
    next()
  })
  app.use(
    bridgeRouter((_req, res, id) => {
      if (id === CANVAS.id) return CANVAS as never
      res.status(404).json({ error: 'not found' })
      return null
    }),
  )
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve)
  })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

beforeEach(() => {
  vi.mocked(bridge.getBridge).mockReset()
  vi.mocked(bridge.selectBridgeAgent).mockReset()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

const call = (method: string, body?: unknown) =>
  fetch(`${base}/api/canvases/c1/bridge`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(3000),
  })

describe('bridge routes when the database fails', () => {
  it('GET answers 500 JSON when the read rejects', async () => {
    vi.mocked(bridge.getBridge).mockRejectedValue(new Error('relation "canvas_bridge" does not exist'))
    const res = await call('GET')
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'bridge unavailable' })
  })

  it('PUT answers 500 JSON when the write rejects', async () => {
    vi.mocked(bridge.selectBridgeAgent).mockRejectedValue(new Error('connection terminated'))
    const res = await call('PUT', { agentRef: 'a1' })
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'bridge unavailable' })
  })

  it('PUT answers 500 JSON when the read after the write rejects', async () => {
    vi.mocked(bridge.selectBridgeAgent).mockResolvedValue()
    vi.mocked(bridge.getBridge).mockRejectedValue(new Error('connection terminated'))
    expect((await call('PUT', { agentRef: null })).status).toBe(500)
  })

  it('still answers 200 with the bridge when the database is healthy', async () => {
    const state = { agentRef: null, agentName: null, agents: [], watcherSeenAt: null, status: 'no_agent_selected' }
    vi.mocked(bridge.getBridge).mockResolvedValue(state as never)
    const res = await call('GET')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(state)
  })
})
