// Compressing HTTPS front for the Flutter dev server. The dev server (DDC) sends ~100 MB of uncompressed JS on a cold
// first load (CHE-7352: Cheese saw more than 5 min over a relayed tailnet path). This proxy gzips text responses and lets
// the browser cache the immutable ones; websockets (DWDS) pass through. Binds the X99 tailnet address only.
// usage: bun devproxy.ts <upstreamPort> <listenPort>      env: TLS_DIR, IP (default: `tailscale ip -4`)
import { join } from 'node:path'
import { execSync } from 'node:child_process'

const [upPort, port] = process.argv.slice(2)
if (!upPort || !port) throw new Error('usage: bun devproxy.ts <upstreamPort> <listenPort>')
const tls = process.env.TLS_DIR ?? '/mnt/ssd2/scratch/che-7352/cert'
const hostname = process.env.IP ?? execSync('tailscale ip -4').toString().split('\n')[0]!
if (hostname === '0.0.0.0' || hostname === '::') throw new Error('refusing a public bind')
const up = `127.0.0.1:${upPort}`
const TEXT = /^(text\/|application\/(javascript|json|wasm)|image\/svg|font\/otf|application\/font)/
const cache = new Map<string, { etag: string; body: Uint8Array; headers: [string, string][] }>() // gzip once per url + upstream etag

type WsData = { peer: WebSocket; queue: (string | Buffer)[] }

Bun.serve<WsData>({
  hostname,
  port: Number(port),
  tls: { cert: Bun.file(join(tls, 'x99.crt')), key: Bun.file(join(tls, 'x99.key')) },
  async fetch(req, server) {
    const u = new URL(req.url)
    if (req.headers.get('upgrade')?.toLowerCase() === 'websocket') {
      const protocols = req.headers
        .get('sec-websocket-protocol')
        ?.split(',')
        .map((s) => s.trim())
      const peer = new WebSocket(`ws://${up}${u.pathname}${u.search}`, protocols)
      return server.upgrade(req, { data: { peer, queue: [] } })
        ? undefined
        : new Response('upgrade failed', { status: 400 })
    }
    const headers = new Headers(req.headers)
    headers.delete('host')
    headers.delete('accept-encoding') // the upstream answers identity; we compress
    const r = await fetch(`http://${up}${u.pathname}${u.search}`, {
      method: req.method,
      headers,
      body: req.body,
      redirect: 'manual',
    })
    const out = new Headers(r.headers)
    out.delete('content-length')
    const type = r.headers.get('content-type') ?? ''
    const gz =
      req.method === 'GET' &&
      r.status === 200 &&
      TEXT.test(type) &&
      (req.headers.get('accept-encoding') ?? '').includes('gzip')
    if (!gz) return new Response(r.body, { status: r.status, headers: r.headers })
    const etag = r.headers.get('etag') ?? ''
    const hit = etag ? cache.get(u.pathname) : undefined
    if (hit && hit.etag === etag) {
      await r.body?.cancel()
      return new Response(hit.body, { headers: hit.headers })
    }
    const body = Bun.gzipSync(new Uint8Array(await r.arrayBuffer()), { level: 6 })
    out.set('content-encoding', 'gzip')
    out.set('vary', 'accept-encoding')
    if (etag) cache.set(u.pathname, { etag, body, headers: [...out] })
    return new Response(body, { headers: out })
  },
  websocket: {
    open(ws) {
      const { peer, queue } = ws.data
      peer.onopen = () => queue.splice(0).forEach((m) => peer.send(m))
      peer.onmessage = (e) => ws.send(e.data as string)
      peer.onclose = () => ws.close()
    },
    message(ws, m) {
      const { peer, queue } = ws.data
      if (peer.readyState === WebSocket.OPEN) peer.send(m)
      else queue.push(m)
    },
    close(ws) {
      ws.data.peer.close()
    },
  },
})
console.log(`devproxy https://${hostname}:${port} -> http://${up}`)
