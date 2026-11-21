/* Userspace TCP proxy that shapes the `c00` network profile (CHE-6942 contract C2).
 *
 *   const proxy = await startThrottleProxy({ target: { host: '127.0.0.1', port: 4400 }, rttMs: 80, downBitsPerSec: 8e6 })
 *   // point Chrome at 127.0.0.1:${proxy.port}
 *
 * Every byte between Chrome and the server passes through here, WebSocket frames included, so no
 * browser-side throttling is needed. Each direction adds rttMs / 2 of one-way delay and shares one
 * bandwidth cap across all connections (one access link for HTML, bundle, WebSocket and images).
 * Connection setup (the TCP handshake) is not shaped; only payload bytes are. */
import { connect, createServer, type Socket } from 'node:net'

export interface ThrottleOptions {
  /** where the proxy forwards to */
  target: { host: string; port: number }
  /** round-trip time; each direction adds rttMs / 2 */
  rttMs: number
  /** cap server to client, bits per second, shared by all connections; omitted means unlimited */
  downBitsPerSec?: number
  /** cap client to server, bits per second, shared by all connections; omitted means unlimited */
  upBitsPerSec?: number
}

export interface ThrottleProxy {
  port: number
  close(): Promise<void>
}

/* a slice is the unit of serialization on the link: small enough that a long transfer streams
   instead of arriving in one lump, large enough to keep timer count low (16 KiB = 16 ms at 8 Mbit/s) */
const SLICE_BYTES = 16 * 1024

/* One direction of the access link. `busyUntil` is shared by every connection using it: a slice
   starts serializing when the link is free and occupies it for bytes * 8 / bps. */
class Link {
  private busyUntil = 0
  constructor(
    private readonly bitsPerSec: number | undefined,
    private readonly oneWayMs: number,
  ) {}

  /** the time (performance.now clock) at which `bytes` sent now are delivered */
  schedule(bytes: number): number {
    const now = performance.now()
    if (!this.bitsPerSec) return now + this.oneWayMs
    this.busyUntil = Math.max(now, this.busyUntil) + (bytes * 8000) / this.bitsPerSec
    return this.busyUntil + this.oneWayMs
  }
}

interface Item {
  at: number
  data: Buffer | null // null: the sender closed its side
}

/* Copies `from` to `to` through `link`, in order. Delivery times only grow, so a FIFO queue with
   one timer on its head keeps byte order without per-item timers. */
function shape(from: Socket, to: Socket, link: Link, timers: Set<NodeJS.Timeout>): void {
  const queue: Item[] = []
  let timer: NodeJS.Timeout | undefined
  const pump = (): void => {
    if (timer) timers.delete(timer)
    timer = undefined
    for (;;) {
      const head = queue[0]
      if (!head) return
      const wait = head.at - performance.now()
      if (wait > 0) {
        timer = setTimeout(pump, wait)
        timers.add(timer)
        return
      }
      queue.shift()
      if (to.destroyed) return
      if (head.data) to.write(head.data)
      else to.end()
    }
  }
  const push = (item: Item): void => {
    queue.push(item)
    if (!timer) pump()
  }
  from.on('data', (chunk: Buffer) => {
    for (let i = 0; i < chunk.length; i += SLICE_BYTES) {
      const slice = chunk.subarray(i, i + SLICE_BYTES)
      push({ at: link.schedule(slice.length), data: slice })
    }
  })
  from.on('end', () => push({ at: link.schedule(0), data: null }))
}

export async function startThrottleProxy(opts: ThrottleOptions): Promise<ThrottleProxy> {
  const oneWayMs = opts.rttMs / 2
  const down = new Link(opts.downBitsPerSec, oneWayMs)
  const up = new Link(opts.upBitsPerSec, oneWayMs)
  const sockets = new Set<Socket>()
  const timers = new Set<NodeJS.Timeout>()

  const server = createServer({ allowHalfOpen: true }, (client) => {
    const upstream = connect({ host: opts.target.host, port: opts.target.port, allowHalfOpen: true })
    for (const socket of [client, upstream]) {
      sockets.add(socket)
      socket.on('close', () => {
        sockets.delete(socket)
        // a dropped or reset side takes the pair down; a clean half-close is carried by shape()
        if (socket.errored) (socket === client ? upstream : client).destroy()
      })
      socket.on('error', () => socket.destroy())
    }
    shape(client, upstream, up, timers)
    shape(upstream, client, down, timers)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })

  return {
    port: (server.address() as { port: number }).port,
    close: () =>
      new Promise<void>((resolve) => {
        for (const timer of timers) clearTimeout(timer)
        for (const socket of sockets) socket.destroy()
        server.close(() => resolve())
      }),
  }
}
