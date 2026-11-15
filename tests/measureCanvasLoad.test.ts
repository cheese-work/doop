import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { existsSync } from 'node:fs'
import { chromium } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { fetchCanvasJson, measureCanvasLoad, median, summarizeCanvas } from '../scripts/perf/measure-canvas-load.ts'

/* CHE-5849: the load-time baseline for the big doop file. The summary counts
   what the canvas JSON carries; the measurement waits for every mounted frame
   iframe to say it is ready, on a cold cache, and reports the median. */

const PNG = 'data:image/png;base64,AAAA'
const frames = [
  { id: 'f1', html: `<p>héllo</p><img src="${PNG}"><div style="background:url(${PNG})"></div>`, delay: 150 },
  { id: 'f2', html: '<p>plain</p>', delay: 500 },
]

const allHtml = frames.map((f) => f.html).join('')

describe('summarizeCanvas', () => {
  it('counts frames, UTF-8 html bytes and data: image URIs', () => {
    const s = summarizeCanvas({ frames: frames.map(({ id, html }) => ({ id, html })) })
    expect(s.frames).toBe(2)
    expect(s.htmlBytes).toBe(Buffer.byteLength(allHtml, 'utf8'))
    expect(s.htmlBytes).toBeGreaterThan(allHtml.length) // é is 2 bytes
    expect(s.dataUriCount).toBe(2)
  })
  it('treats missing html as empty', () => {
    expect(summarizeCanvas({ frames: [{}, { html: 'x' }] })).toEqual({ frames: 2, htmlBytes: 1, dataUriCount: 0 })
  })
})

describe('median', () => {
  it('takes the middle of an odd list and the mean of the middle two of an even list', () => {
    expect(median([5, 1, 3])).toBe(3)
    expect(median([4, 1, 3, 2])).toBe(2.5)
  })
})

describe('fetchCanvasJson', () => {
  let server: Server
  let baseUrl = ''
  beforeAll(async () => {
    server = createServer((req, res) => {
      res.writeHead(req.headers.cookie === 'sid=abc' ? 200 : 401).end('{}')
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterAll(() => new Promise<void>((r) => server.close(() => r())))

  it('returns the canvas JSON body for a cookie the API accepts', async () => {
    const body = await fetchCanvasJson(baseUrl, 'fx', 'sid=abc')
    expect(body.toString('utf8')).toBe('{}')
  })
  it('fails at once with the status and a hint to copy a fresh cookie', async () => {
    await expect(fetchCanvasJson(baseUrl, 'fx', 'sid=stale')).rejects.toThrow(/401.*fresh cookie/s)
  })
})

const chromiumPresent = existsSync(chromium.executablePath())

describe.skipIf(!chromiumPresent)('measureCanvasLoad against a fixture server', () => {
  let server: Server
  let baseUrl = ''
  const hits = { cookie: 0, noCookie: 0 }

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url?.startsWith('/api/canvases/')) {
        if (req.headers.cookie !== 'sid=abc') {
          hits.noCookie++
          res.writeHead(401).end('{"error":"unauthorized"}')
          return
        }
        hits.cookie++
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ id: 'fx', frames: frames.map(({ id, html }) => ({ id, html })) }))
        return
      }
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(`<!doctype html><body><script>
        const delays = ${JSON.stringify(Object.fromEntries(frames.map((f) => [f.id, f.delay])))}
        fetch('/api/canvases/fx').then((r) => r.json()).then((c) => {
          for (const f of c.frames) {
            const surface = document.createElement('div')
            surface.setAttribute('data-frame-surface', '')
            const ifr = document.createElement('iframe')
            ifr.srcdoc = '<script>setTimeout(() => parent.postMessage({ type: "doop:frame-ready" }, "*"), ' + delays[f.id] + ')<\\/script>'
            surface.append(ifr)
            document.body.append(surface)
          }
        })
      </script></body>`)
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterAll(() => new Promise<void>((r) => server.close(() => r())))

  it('waits for the slowest iframe and reports payload numbers, once per run', async () => {
    const out = await measureCanvasLoad({ baseUrl, canvasId: 'fx', cookie: 'sid=abc', runs: 3 })
    expect(out.runs).toHaveLength(3)
    for (const r of out.runs) {
      expect(r.ms).toBeGreaterThanOrEqual(500)
      expect(r.iframesMounted).toBe(2)
    }
    // payload numbers come from one request made outside the browser, so a slow
    // browser-side response body cannot stall a run (CHE-5849 baseline hang)
    expect(out.canvasJsonBytes).toBeGreaterThan(allHtml.length)
    expect(out.medianMs).toBe(median(out.runs.map((r) => r.ms)))
    expect(out.frames).toBe(2)
    expect(out.dataUriCount).toBe(2)
    expect(out.htmlBytes).toBe(Buffer.byteLength(allHtml, 'utf8'))
    expect(hits.noCookie).toBe(0)
  }, 60_000)

  it('reports where the run is while it waits, so a slow page is not silent', async () => {
    const lines: string[] = []
    await measureCanvasLoad({
      baseUrl,
      canvasId: 'fx',
      cookie: 'sid=abc',
      runs: 1,
      heartbeatMs: 100,
      onProgress: (m) => lines.push(m),
    })
    const text = lines.join('\n')
    expect(text).toMatch(/browser started/)
    expect(text).toMatch(/page loaded/)
    expect(text).toMatch(/canvas JSON \d+ bytes/)
    expect(text).toMatch(/all frames ready after \d+ ms/)
    expect(text).toMatch(/iframes ready \d+\/\d+/)
  }, 60_000)
})
