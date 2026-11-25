// Static HTTPS server for a Flutter release build. Binds the X99 tailnet address only (never 0.0.0.0).
// usage: bun static.ts <dir> <port> [cors] [coi]   cors = ACAO:*   coi = COOP same-origin + COEP require-corp + CORP cross-origin
// env: TLS_DIR (x99.crt/x99.key from `tailscale cert`, outside the repo), IP (default: `tailscale ip -4`)
import { join, normalize } from 'node:path'
import { execSync } from 'node:child_process'

const [dir, port, ...flags] = process.argv.slice(2)
if (!dir || !port) throw new Error('usage: bun static.ts <dir> <port> [cors] [coi]')
const tls = process.env.TLS_DIR ?? '/mnt/ssd2/scratch/che-7352/cert'
const hostname = process.env.IP ?? execSync('tailscale ip -4').toString().split('\n')[0]!
if (hostname === '0.0.0.0' || hostname === '::') throw new Error('refusing a public bind')
const cors = flags.includes('cors')
const coi = flags.includes('coi')

Bun.serve({
  hostname,
  port: Number(port),
  tls: { cert: Bun.file(join(tls, 'x99.crt')), key: Bun.file(join(tls, 'x99.key')) },
  async fetch(req) {
    const path = normalize(decodeURIComponent(new URL(req.url).pathname)).replace(/^(\.\.[/\\])+/, '')
    const file = Bun.file(join(dir, path.endsWith('/') ? `${path}index.html` : path))
    if (!(await file.exists())) return new Response('not found', { status: 404 })
    const h = new Headers({ 'cache-control': 'no-store' })
    if (cors) h.set('access-control-allow-origin', '*')
    if (coi) {
      h.set('cross-origin-opener-policy', 'same-origin')
      h.set('cross-origin-embedder-policy', 'require-corp')
      h.set('cross-origin-resource-policy', 'cross-origin')
    }
    return new Response(file, { headers: h })
  },
})
console.log(`static ${dir} on https://${hostname}:${port} cors=${cors} coi=${coi}`)
