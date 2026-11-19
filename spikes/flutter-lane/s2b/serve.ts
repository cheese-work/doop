// S2b server: the S1b server plus three ways to serve the pinned toolkit, a manifest, a service worker, mirrors and byte stats.
// usage: bun serve.ts <port>   env: SDK_DIR, PAGE_DIR, SRC_DIR, TLS_DIR, ZCACHE, BLOB_DIR, MIRROR_DIR, STATS_FILE, IP (default tailnet IP)
//   /sdk/*           S1b route, unchanged behaviour: max-age=86400, URL not keyed to content (the baseline)
//   /sdkh/<key>/*    immutable: max-age=1y, key = first 16 hex of SHA-256 over the file manifest (content-hashed URL)
//   /sdks/*          no-store: the service worker owns caching; /sdks/manifest.json lists {path: sha256}
//   /mirror/pub/*    pub.dev mirror (package JSON with archive_url rewritten to this host), /mirror/fonts/*, /mirror/rive/*
// Every /sdk*, /mirror response is logged to STATS_FILE as one JSON line {path, status, enc, bytes}.
// Tailnet bind only (never 0.0.0.0).
import { join, normalize } from 'node:path'
import { execSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import zlib from 'node:zlib'

type Done = (err: Error | null, out: Buffer) => void

const port = Number(process.argv[2])
const here = import.meta.dir
const SDK = process.env.SDK_DIR ?? '/mnt/ssd2/scratch/che-7478/sdk'
const PAGE = process.env.PAGE_DIR ?? join(here, 'page')
const SRC = process.env.SRC_DIR ?? join(here, '../app/lib')
const TLS = process.env.TLS_DIR ?? '/mnt/ssd2/scratch/che-7352/cert'
const BLOB = process.env.BLOB_DIR ?? '/mnt/ssd2/scratch/che-7478/blob'
const Z = process.env.ZCACHE ?? '/mnt/ssd2/scratch/che-7630/zcache'
const MIRROR = process.env.MIRROR_DIR ?? '/mnt/ssd2/scratch/che-7630/mirror'
const STATS = process.env.STATS_FILE
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
  gz: 'application/gzip',
  otf: 'font/otf',
  ttf: 'font/ttf',
  woff2: 'font/woff2',
}
const safe = (root: string, p: string) => join(root, normalize(decodeURIComponent(p)).replace(/^(\.\.[/\\])+/, ''))

// compressed copies on disk (brotli q9, gzip 9), made once. Symlinks resolve first so a bumped copy of the SDK shares them.
async function z(file: string, enc: 'br' | 'gzip') {
  file = fs.realpathSync(file)
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

// manifest: SHA-256 of every file the browser can fetch at run time (no .map, no devtools)
function walk(dir: string, rel = ''): string[] {
  return fs.readdirSync(join(dir, rel), { withFileTypes: true }).flatMap((e) => {
    const r = rel ? `${rel}/${e.name}` : e.name
    if (e.name.endsWith('.map') || e.name.startsWith('devtools')) return []
    const full = join(dir, r)
    return fs.statSync(full).isDirectory() ? walk(dir, r) : [r]
  })
}
const sha = (f: string) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')
const files: Record<string, string> = {}
for (const r of walk(SDK).sort()) files[r] = sha(join(SDK, r))
const key = crypto.createHash('sha256').update(JSON.stringify(files)).digest('hex').slice(0, 16)
const version = JSON.parse(fs.readFileSync(join(SDK, 'version.json'), 'utf8'))
const manifest = {
  key,
  dartpad: '0.1.4',
  dart: version.dartVersion,
  flutter: version.properties?.flutterVersion,
  files,
}

const stat = (path: string, status: number, enc: string | null, bytes: number) =>
  STATS && fs.appendFileSync(STATS, JSON.stringify({ path, status, enc, bytes }) + '\n')

// compressed body for a file under the SDK or the mirror
async function body(file: string, req: Request, h: Headers, path: string) {
  const ae = req.headers.get('accept-encoding') ?? ''
  const compress = fs.statSync(file).size > 4096 && !/\.(png|gz|woff2|otf|ttf)$/.test(file)
  const enc = compress ? (ae.includes('br') ? 'br' : ae.includes('gzip') ? 'gzip' : null) : null
  if (enc) {
    h.set('content-encoding', enc)
    h.set('vary', 'accept-encoding')
    file = await z(file, enc)
  }
  const size = fs.statSync(file).size
  h.set('content-length', String(size))
  stat(path, 200, enc, size)
  return new Response(Bun.file(file), { headers: h })
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
  }, 20)
})

const origin = `https://${ip}:${port}`
Bun.serve({
  hostname: ip,
  port,
  idleTimeout: 0,
  tls: { cert: Bun.file(join(TLS, 'x99.crt')), key: Bun.file(join(TLS, 'x99.key')) },
  async fetch(req) {
    const u = new URL(req.url)
    const p = u.pathname
    if (p === '/src.json') return Response.json(readSrc(), { headers: { 'cache-control': 'no-store' } })
    if (p === '/events')
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
    if (p === '/sdks/manifest.json') return Response.json(manifest, { headers: { 'cache-control': 'no-store' } })
    if (p === '/sw.js')
      return new Response(Bun.file(join(PAGE, 'sw.js')), {
        headers: { 'content-type': 'text/javascript', 'cache-control': 'no-store' },
      })
    if (p.startsWith('/blob/')) {
      const f = safe(BLOB, p.slice(6))
      return fs.existsSync(f) && fs.statSync(f).isFile()
        ? new Response(Bun.file(f), { headers: { 'cache-control': 'no-store' } })
        : new Response('not found', { status: 404 })
    }
    if (p.startsWith('/mirror/')) {
      // static files only: filled once by mirror.mjs, served from MIRROR_DIR; package JSON already points at this origin
      let f = safe(MIRROR, p.slice(8))
      if (p.startsWith('/mirror/pub/api/packages/') && !f.endsWith('.json')) f += '.json'
      if (!fs.existsSync(f) || !fs.statSync(f).isFile()) {
        stat(p, 404, null, 0)
        return new Response('not found', { status: 404 })
      }
      const h = new Headers({
        'content-type': types[f.split('.').pop()!] ?? 'application/octet-stream',
        'cache-control': 'public, max-age=86400',
        'access-control-allow-origin': '*',
      })
      if (f.endsWith('.json')) {
        // package JSON: archive_url points back at whatever origin this server answers on
        const text = fs.readFileSync(f, 'utf8').replaceAll('__ORIGIN__', u.origin)
        h.set('content-type', 'application/json')
        stat(p, 200, null, text.length)
        return new Response(text, { headers: h })
      }
      return body(f, req, h, p)
    }
    let root = PAGE
    let rel = p.endsWith('/') ? `${p}index.html` : p
    let cc = 'no-store'
    let isSdk = false
    if (p.startsWith('/sdk/')) {
      root = SDK
      rel = p.slice(5)
      cc = 'public, max-age=86400'
      isSdk = true
    } else if (p.startsWith('/sdks/')) {
      root = SDK
      rel = p.slice(6)
      isSdk = true
    } else if (p.startsWith('/sdkh/')) {
      const [, , k, ...rest] = p.split('/')
      if (k !== key) return new Response('unknown toolkit key', { status: 404 })
      root = SDK
      rel = rest.join('/')
      cc = 'public, max-age=31536000, immutable'
      isSdk = true
    }
    const file = safe(root, rel)
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      if (isSdk) stat(p, 404, null, 0)
      return new Response('not found', { status: 404 })
    }
    const h = new Headers({
      'content-type': types[file.split('.').pop()!] ?? 'application/octet-stream',
      'cache-control': cc,
    })
    if (isSdk) return body(file, req, h, p)
    return new Response(Bun.file(file), { headers: h })
  },
})
console.log(`s2b on ${origin} sdk=${SDK} key=${key} page=${PAGE} files=${Object.keys(files).length}`)
