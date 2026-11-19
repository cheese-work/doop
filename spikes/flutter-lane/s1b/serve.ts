// S1b server: the DartPad SDK assets, the page and the erus source text. Tailnet bind only (never 0.0.0.0).
// usage: bun serve.ts <port>   env: SDK_DIR (dartpad setup output), PAGE_DIR (default ./page), SRC_DIR (default ../app/lib),
//   TLS_DIR (x99.crt/x99.key from `tailscale cert`, outside the repo), ZCACHE (compressed copies), IP (default tailnet IP)
// /sdk/*  static, cacheable, br/gzip.   /*  page, no-store.   /src.json  {file: text}.   /events  SSE: new text on every save.
import { join, normalize } from 'node:path'
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import zlib from 'node:zlib'

type Done = (err: Error | null, out: Buffer) => void

const port = Number(process.argv[2])
const here = import.meta.dir
const SDK = process.env.SDK_DIR ?? '/mnt/ssd2/scratch/che-7478/sdk'
const PAGE = process.env.PAGE_DIR ?? join(here, 'page')
const SRC = process.env.SRC_DIR ?? join(here, '../app/lib')
const TLS = process.env.TLS_DIR ?? '/mnt/ssd2/scratch/che-7352/cert'
const BLOB = process.env.BLOB_DIR ?? '/mnt/ssd2/scratch/che-7478/blob' // font + .riv bytes, outside the repo (SF Pro is never committed)
const Z = process.env.ZCACHE ?? '/mnt/ssd2/scratch/che-7478/zcache'
const ip = process.env.IP ?? execSync('tailscale ip -4').toString().split('\n')[0]!
if (ip === '0.0.0.0' || ip === '::') throw new Error('refusing a public bind')
fs.mkdirSync(Z, { recursive: true })

const types: Record<string, string> = {
  js: 'text/javascript',
  mjs: 'text/javascript',
  wasm: 'application/wasm',
  json: 'application/json',
  html: 'text/html',
  css: 'text/css',
  tar: 'application/x-tar',
  map: 'application/json',
  png: 'image/png',
}
const safe = (root: string, p: string) => join(root, normalize(decodeURIComponent(p)).replace(/^(\.\.[/\\])+/, ''))

// compressed copies on disk (brotli q9, gzip 9), made once; sizes are what the evidence file reports
async function z(file: string, enc: 'br' | 'gzip') {
  const out = join(Z, `${file.replaceAll('/', '_')}.${enc === 'br' ? 'br' : 'gz'}`)
  if (!fs.existsSync(out) || fs.statSync(out).mtimeMs < fs.statSync(file).mtimeMs) {
    const buf = await Bun.file(file).arrayBuffer()
    const c = await new Promise<Buffer>((res, rej) =>
      (enc === 'br'
        ? (cb: Done) =>
            zlib.brotliCompress(
              Buffer.from(buf),
              {
                params: {
                  [zlib.constants.BROTLI_PARAM_QUALITY]: 9,
                  [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.byteLength,
                },
              },
              cb,
            )
        : (cb: Done) => zlib.gzip(Buffer.from(buf), { level: 9 }, cb))((e, r) => (e ? rej(e) : res(r))),
    )
    fs.writeFileSync(out, c)
  }
  return out
}

const subs = new Set<ReadableStreamDefaultController>()
const readSrc = () =>
  Object.fromEntries(
    fs
      .readdirSync(SRC)
      .filter((f) => f.endsWith('.dart'))
      .map((f) => [f, fs.readFileSync(join(SRC, f), 'utf8')]),
  )
let t: ReturnType<typeof setTimeout> | undefined
fs.watch(SRC, () => {
  clearTimeout(t)
  t = setTimeout(() => {
    const m = new TextEncoder().encode(`data: ${JSON.stringify(readSrc())}\n\n`)
    for (const c of subs)
      try {
        c.enqueue(m)
      } catch {
        subs.delete(c)
      }
  }, 20) // same 20 ms trailing debounce as S1's watcher
})

Bun.serve({
  hostname: ip,
  port,
  idleTimeout: 0,
  tls: { cert: Bun.file(join(TLS, 'x99.crt')), key: Bun.file(join(TLS, 'x99.key')) },
  async fetch(req) {
    const u = new URL(req.url)
    if (u.pathname === '/src.json') return Response.json(readSrc(), { headers: { 'cache-control': 'no-store' } })
    if (u.pathname === '/events')
      return new Response(
        new ReadableStream({
          start: (c) => {
            subs.add(c)
            c.enqueue(new TextEncoder().encode(': hi\n\n'))
          },
          cancel() {},
        }),
        { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' } },
      )
    if (u.pathname.startsWith('/blob/')) {
      const f = safe(BLOB, u.pathname.slice(6))
      return fs.existsSync(f) && fs.statSync(f).isFile()
        ? new Response(Bun.file(f), { headers: { 'cache-control': 'no-store' } })
        : new Response('not found', { status: 404 })
    }
    const sdk = u.pathname.startsWith('/sdk/')
    let file = sdk
      ? safe(SDK, u.pathname.slice(5))
      : safe(PAGE, u.pathname.endsWith('/') ? `${u.pathname}index.html` : u.pathname)
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return new Response('not found', { status: 404 })
    const h = new Headers({
      'content-type': types[file.split('.').pop()!] ?? 'application/octet-stream',
      'cache-control': sdk ? 'public, max-age=86400' : 'no-store',
    })
    const ae = req.headers.get('accept-encoding') ?? ''
    if (sdk && fs.statSync(file).size > 4096 && !file.endsWith('.png')) {
      const enc = ae.includes('br') ? 'br' : ae.includes('gzip') ? 'gzip' : null
      if (enc) {
        h.set('content-encoding', enc)
        h.set('vary', 'accept-encoding')
        file = await z(file, enc)
      }
    }
    return new Response(Bun.file(file), { headers: h })
  },
})
console.log(`s1b on https://${ip}:${port} sdk=${SDK} page=${PAGE} src=${SRC}`)
