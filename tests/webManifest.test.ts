import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { build } from 'vite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { freePort, startServer, type Server } from './harness'

interface Manifest {
  name: string
  short_name: string
  start_url: string
  scope: string
  display: string
  background_color: string
  theme_color: string
  icons: { src: string; sizes: string; type: string; purpose?: string }[]
}

/* The production path end to end: `vite build` into a scratch dist, then the
   real server in production mode with that dist as its working directory's
   `dist/`, so the static handler and the SPA fallback are the shipped ones. */
let dir: string
let server: Server
let builtIndex: string

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'doop-webmanifest-'))
  await build({ logLevel: 'silent', build: { outDir: path.join(dir, 'dist'), emptyOutDir: true } })
  builtIndex = readFileSync(path.join(dir, 'dist', 'index.html'), 'utf8')
  server = await startServer(
    {
      NODE_ENV: 'production',
      BETTER_AUTH_SECRET: 'webmanifest-test-secret-0123456789',
      PORT: String(await freePort()),
    },
    dir,
  )
}, 180_000)

afterAll(() => {
  server?.stop()
  if (dir) rmSync(dir, { recursive: true, force: true })
})

async function get(urlPath: string): Promise<Response> {
  return fetch(`${server.base}${urlPath}`)
}

describe('home-screen web app', () => {
  it('links the manifest and the iOS standalone meta tags from the built index.html', async () => {
    expect(builtIndex).toContain('<link rel="manifest" href="/manifest.webmanifest" />')
    for (const name of [
      'apple-mobile-web-app-capable',
      'mobile-web-app-capable',
      'apple-mobile-web-app-title',
      'apple-mobile-web-app-status-bar-style',
    ]) {
      expect(builtIndex, name).toMatch(new RegExp(`<meta\\s+name="${name}"`))
    }
    expect(builtIndex).toMatch(/<meta\s+name="theme-color"[^>]*media="\(prefers-color-scheme: light\)"/)
    expect(builtIndex).toMatch(/<meta\s+name="theme-color"[^>]*media="\(prefers-color-scheme: dark\)"/)
    /* what Safari fetches is the same document */
    expect(await (await get('/')).text()).toBe(builtIndex)
  })

  it('serves the manifest as application/manifest+json, not the SPA fallback', async () => {
    const res = await get('/manifest.webmanifest')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/^application\/manifest\+json/)
    const m = (await res.json()) as Manifest
    expect(m.display).toBe('standalone')
    expect(m.name).toBe('Doop')
    expect(m.short_name).toBe('Doop')
    expect(m.start_url).toBe('/')
    expect(m.scope).toBe('/')
    expect(m.background_color).toMatch(/^#[0-9a-f]{6}$/i)
    expect(m.theme_color).toMatch(/^#[0-9a-f]{6}$/i)
    const any = m.icons.filter((i) => (i.purpose ?? 'any') === 'any').map((i) => i.sizes)
    expect(any).toEqual(expect.arrayContaining(['192x192', '512x512']))
    expect(m.icons.some((i) => i.purpose === 'maskable' && i.sizes === '512x512')).toBe(true)
  })

  it('serves every icon the manifest names as a PNG of the declared size', async () => {
    const m = (await (await get('/manifest.webmanifest')).json()) as Manifest
    for (const icon of m.icons) {
      const res = await get(icon.src)
      expect(res.headers.get('content-type'), icon.src).toBe('image/png')
      const png = Buffer.from(await res.arrayBuffer())
      const [w, h] = icon.sizes.split('x').map(Number)
      expect(png.readUInt32BE(16), icon.src).toBe(w)
      expect(png.readUInt32BE(20), icon.src).toBe(h)
    }
  })
})
