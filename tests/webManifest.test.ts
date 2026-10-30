import { readFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { createServer } from 'node:http'
import path from 'node:path'
import express from 'express'
import { describe, expect, it } from 'vitest'

const root = path.join(import.meta.dirname, '..')
const indexHtml = readFileSync(path.join(root, 'index.html'), 'utf8')

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

function readManifest(): Manifest {
  return JSON.parse(readFileSync(path.join(root, 'public', 'manifest.webmanifest'), 'utf8')) as Manifest
}

describe('home-screen web app', () => {
  it('links the manifest and the iOS standalone meta tags from index.html', () => {
    expect(indexHtml).toContain('<link rel="manifest" href="/manifest.webmanifest" />')
    for (const name of [
      'apple-mobile-web-app-capable',
      'mobile-web-app-capable',
      'apple-mobile-web-app-title',
      'apple-mobile-web-app-status-bar-style',
    ]) {
      expect(indexHtml, name).toMatch(new RegExp(`<meta\\s+name="${name}"`))
    }
    expect(indexHtml).toMatch(/<meta\s+name="theme-color"[^>]*media="\(prefers-color-scheme: light\)"/)
    expect(indexHtml).toMatch(/<meta\s+name="theme-color"[^>]*media="\(prefers-color-scheme: dark\)"/)
  })

  it('opens standalone with the Doop name and 192, 512 and maskable icons', () => {
    const m = readManifest()
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

  it('ships every icon the manifest names', () => {
    for (const icon of readManifest().icons) {
      const png = readFileSync(path.join(root, 'public', icon.src))
      const [w, h] = icon.sizes.split('x').map(Number)
      expect(png.readUInt32BE(16), icon.src).toBe(w)
      expect(png.readUInt32BE(20), icon.src).toBe(h)
    }
  })

  it('serves the manifest as application/manifest+json, not the SPA fallback', async () => {
    /* same static handler as the production branch of server/index.ts */
    const app = express()
    app.use(express.static(path.join(root, 'public')))
    const server = createServer(app).listen(0)
    try {
      const { port } = server.address() as AddressInfo
      const res = await fetch(`http://127.0.0.1:${port}/manifest.webmanifest`)
      expect(res.headers.get('content-type')).toMatch(/^application\/manifest\+json/)
      expect(((await res.json()) as Manifest).display).toBe('standalone')
    } finally {
      server.close()
    }
  })
})
