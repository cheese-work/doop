import { connect, createServer, type Server, type Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket, WebSocketServer } from 'ws'
import { startThrottleProxy, type ThrottleProxy } from '../scripts/perf/throttle-proxy.ts'

/* CHE-6953 (CHE-6942 step 3, contract C2): the userspace proxy that shapes the c00 profile.
   One-way delay of RTT/2 per direction; one shared token bucket per direction; every byte shaped,
   WebSocket included. */

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn()
})

function listen(onConnection: (socket: Socket) => void): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer(onConnection)
    cleanups.push(() => new Promise<void>((done) => server.close(() => done())))
    server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as { port: number }).port }))
  })
}

async function proxyTo(port: number, opts: Partial<Parameters<typeof startThrottleProxy>[0]>): Promise<ThrottleProxy> {
  const proxy = await startThrottleProxy({ target: { host: '127.0.0.1', port }, rttMs: 0, ...opts })
  cleanups.push(() => proxy.close())
  return proxy
}

function dial(port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => resolve(socket))
    socket.once('error', reject)
    cleanups.push(() => void socket.destroy())
  })
}

describe('throttle proxy (C2)', () => {
  it('moves 1 MB at 8 Mbit/s in 1 s, within 10%', async () => {
    const payload = Buffer.alloc(1_000_000, 7)
    const origin = await listen((socket) => {
      socket.on('error', () => {})
      socket.end(payload)
    })
    const proxy = await proxyTo(origin.port, { downBitsPerSec: 8_000_000 })
    const client = await dial(proxy.port)
    const start = performance.now()
    let received = 0
    await new Promise<void>((resolve) => {
      client.on('data', (chunk) => (received += chunk.length))
      client.on('end', resolve)
    })
    const seconds = (performance.now() - start) / 1000
    expect(received).toBe(payload.length)
    expect(seconds).toBeGreaterThan(0.9)
    expect(seconds).toBeLessThan(1.1)
  })

  it('shares one cap across connections: two 0.5 MB transfers take 1 s together', async () => {
    const payload = Buffer.alloc(500_000, 7)
    const origin = await listen((socket) => {
      socket.on('error', () => {})
      socket.end(payload)
    })
    const proxy = await proxyTo(origin.port, { downBitsPerSec: 8_000_000 })
    const start = performance.now()
    const drain = async (): Promise<number> => {
      const client = await dial(proxy.port)
      let received = 0
      await new Promise<void>((resolve) => {
        client.on('data', (chunk) => (received += chunk.length))
        client.on('end', resolve)
      })
      return received
    }
    expect(await Promise.all([drain(), drain()])).toEqual([500_000, 500_000])
    const seconds = (performance.now() - start) / 1000
    expect(seconds).toBeGreaterThan(0.9)
    expect(seconds).toBeLessThan(1.1)
  })

  it('adds the configured RTT to one round trip, within 10%', async () => {
    const origin = await listen((socket) => {
      socket.on('error', () => {})
      socket.on('data', (chunk) => socket.write(chunk))
    })
    const proxy = await proxyTo(origin.port, { rttMs: 200 })
    const client = await dial(proxy.port)
    const start = performance.now()
    const echoed = new Promise<void>((resolve) => client.once('data', () => resolve()))
    client.write('x')
    await echoed
    const ms = performance.now() - start
    expect(ms).toBeGreaterThan(180)
    expect(ms).toBeLessThan(220)
  })

  it('opens a WebSocket through the proxy and carries messages both ways', async () => {
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
    cleanups.push(() => new Promise<void>((done) => wss.close(() => done())))
    await new Promise<void>((resolve) => wss.once('listening', () => resolve()))
    wss.on('connection', (ws) => ws.on('message', (data, isBinary) => ws.send(data, { binary: isBinary })))
    const proxy = await proxyTo((wss.address() as { port: number }).port, {
      rttMs: 40,
      downBitsPerSec: 8_000_000,
      upBitsPerSec: 8_000_000,
    })
    const ws = new WebSocket(`ws://127.0.0.1:${proxy.port}`)
    cleanups.push(() => void ws.terminate())
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve())
      ws.once('error', reject)
    })
    const reply = new Promise<string>((resolve) => ws.once('message', (data) => resolve(data.toString())))
    const start = performance.now()
    ws.send('hello through the proxy')
    expect(await reply).toBe('hello through the proxy')
    /* the frames were shaped too: one message round trip costs at least the RTT */
    expect(performance.now() - start).toBeGreaterThan(36)
  })
})
