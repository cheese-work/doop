import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { chromium } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { launchOptions } from '../scripts/perf/measure-canvas-load.ts'
import { buildFixture, fixtureManifest } from '../scripts/perf/build-canvas-fixture.ts'
import {
  LONG_FRAME_MS,
  aggregateRuns,
  measureFitAllRendered,
  panZoomPath,
  percentile,
  recordPath,
  summarizeFrameTimes,
} from '../scripts/perf/measure-canvas-perf.ts'

/* CHE-5889 (CHE-5793 step 22, contract C8): the canvas performance harness.
   The fixture builder never writes into the repo and records only a manifest
   SHA256; the harness drives one scripted 10 s pan and zoom path and reports
   frame time p50, p95 and the count of long animation frames (over 50 ms). */

const exported = {
  id: 'abc',
  name: 'private file',
  ownerId: 'u1',
  createdAt: 1,
  updatedAt: 2,
  role: 'owner',
  pages: [{ id: 'abc:page1', name: 'Page 1' }],
  frames: [
    {
      id: 'f1',
      canvasId: 'abc',
      pageId: 'abc:page1',
      name: 'A',
      x: 0,
      y: 0,
      width: 390,
      height: 844,
      html: '<p>secret</p>',
      createdAt: 1,
      updatedAt: 5,
      updatedBy: 'u1',
      approval: null,
    },
    {
      id: 'f2',
      canvasId: 'abc',
      pageId: 'abc:page1',
      name: 'B',
      x: 500,
      y: 0,
      width: 1440,
      height: 900,
      html: '<p>other</p>',
      createdAt: 1,
      updatedAt: 6,
      updatedBy: 'u1',
      approval: null,
    },
  ],
}

describe('fixtureManifest', () => {
  it('lists per-frame geometry and an html hash, never the html', () => {
    const m = fixtureManifest(exported)
    expect(m.frames).toBe(2)
    expect(m.frameList[0]).toMatchObject({ name: 'A', x: 0, y: 0, width: 390, height: 844 })
    expect(m.frameList[0]!.htmlSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(m)).not.toContain('secret')
    expect(m.sha256).toMatch(/^[0-9a-f]{64}$/)
  })
  it('is stable across ids, owners and timestamps, and changes with content', () => {
    const base = fixtureManifest(exported).sha256
    const renamedIds = { ...exported, id: 'zzz', ownerId: 'u2', updatedAt: 99 }
    expect(fixtureManifest(renamedIds).sha256).toBe(base)
    const edited = { ...exported, frames: [{ ...exported.frames[0]!, html: '<p>changed</p>' }, exported.frames[1]!] }
    expect(fixtureManifest(edited).sha256).not.toBe(base)
  })
})

describe('buildFixture', () => {
  it('writes fixture.json and manifest.json outside the repo and returns the manifest SHA256', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'doop-fixture-test-'))
    try {
      const src = path.join(dir, 'export.json')
      writeFileSync(src, JSON.stringify(exported))
      const out = path.join(dir, 'out')
      const manifest = buildFixture(src, out)
      const fixture = JSON.parse(readFileSync(path.join(out, 'fixture.json'), 'utf8'))
      expect(fixture.frames).toHaveLength(2)
      expect(fixture.frames[0].html).toBe('<p>secret</p>')
      expect(fixture.frames[0]).not.toHaveProperty('updatedBy')
      expect(JSON.parse(readFileSync(path.join(out, 'manifest.json'), 'utf8')).sha256).toBe(manifest.sha256)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  it('refuses an output directory inside the repo', () => {
    const inside = path.join(process.cwd(), 'scripts', 'perf', 'fixture-out')
    expect(() => buildFixture('unused.json', inside)).toThrow(/inside the repo/)
  })
})

describe('percentile and summarizeFrameTimes', () => {
  it('takes p50 and p95 of frame deltas and counts frames over 50 ms', () => {
    const deltas = [...Array.from({ length: 90 }, () => 16), ...Array.from({ length: 10 }, (_, i) => 40 + i * 10)]
    expect(percentile(deltas, 0.5)).toBe(16)
    expect(percentile(deltas, 0.95)).toBe(80)
    const s = summarizeFrameTimes(deltas)
    expect(s.p50).toBe(16)
    expect(s.p95).toBe(80)
    expect(s.over50).toBe(8) // 60..130; 40 and 50 are not over 50 ms
    expect(LONG_FRAME_MS).toBe(50)
  })
  it('fails loudly on no samples instead of reporting NaN as a result', () => {
    expect(() => summarizeFrameTimes([])).toThrow(/no frames/)
  })
})

describe('panZoomPath', () => {
  const steps = panZoomPath({ width: 2560, height: 1440 })
  it('is deterministic and spans 10 s', () => {
    expect(panZoomPath({ width: 2560, height: 1440 })).toEqual(steps)
    expect(steps[0]!.atMs).toBe(0)
    expect(steps.at(-1)!.atMs).toBeGreaterThanOrEqual(9_900)
    expect(steps.at(-1)!.atMs).toBeLessThan(10_000)
  })
  it('pans and zooms, and the zoom wheel deltas cancel so the path ends where it started', () => {
    expect(steps.some((s) => s.kind === 'pan')).toBe(true)
    expect(steps.some((s) => s.kind === 'zoom')).toBe(true)
    expect(steps.filter((s) => s.kind === 'zoom').reduce((a, s) => a + s.deltaY, 0)).toBe(0)
    expect(steps.filter((s) => s.kind === 'pan').reduce((a, s) => a + s.deltaX, 0)).toBe(0)
  })
  it('keeps times non-decreasing', () => {
    for (let i = 1; i < steps.length; i++) expect(steps[i]!.atMs).toBeGreaterThanOrEqual(steps[i - 1]!.atMs)
  })
})

describe('aggregateRuns', () => {
  it('takes the median of every metric across runs', () => {
    const run = (n: number) => ({
      allFramesMs: n,
      frameP50: n,
      frameP95: n * 2,
      longFrames: n,
      iframes: 10,
      jsHeapMb: n,
    })
    const m = aggregateRuns([run(5), run(1), run(3), run(2), run(4)])
    expect(m).toEqual({ allFramesMs: 3, frameP50: 3, frameP95: 6, longFrames: 3, iframes: 10, jsHeapMb: 3 })
  })
})

const chromiumPresent = existsSync(process.env.CHROME_PATH || chromium.executablePath())

describe.skipIf(!chromiumPresent)('recordPath in a real browser', () => {
  let server: Server
  let baseUrl = ''
  beforeAll(async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(`<!doctype html><body style="margin:0"><div data-frame-surface><iframe data-doop-frame srcdoc="<p>x</p>"></iframe></div>
        <script>
          window.__wheels = 0
          addEventListener('wheel', () => { window.__wheels++ })
          // one deliberately long task so a long animation frame exists
          addEventListener('keydown', () => { const t = performance.now(); while (performance.now() - t < 120); })
        </script></body>`)
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterAll(() => new Promise<void>((r) => server.close(() => r())))

  it('replays the path, and reports frame times, long frames, iframe count and JS heap', async () => {
    const browser = await chromium.launch(launchOptions())
    try {
      const page = await browser.newPage({ viewport: { width: 800, height: 600 } })
      await page.goto(baseUrl)
      const short = panZoomPath({ width: 800, height: 600 }).filter((s) => s.atMs < 600)
      const out = await recordPath(page, short, { width: 800, height: 600 }, async () => {
        await page.keyboard.press('KeyA') // the 120 ms task lands inside the recording
      })
      expect(out.frames.length).toBeGreaterThan(5)
      expect(out.longFrames).toBeGreaterThanOrEqual(1)
      expect(out.iframes).toBe(1)
      expect(out.jsHeapMb).toBeGreaterThan(0)
      expect(await page.evaluate(() => (window as never as { __wheels: number }).__wheels)).toBeGreaterThan(0)
    } finally {
      await browser.close()
    }
  })

  it('times fit-all until every frame in view shows a loaded preview or a ready iframe', async () => {
    const PIXEL = 'data:image/gif;base64,R0lGODlhAQABAAAAACwAAAAAAQABAAA='
    const html = `<!doctype html><body style="margin:0">
      <div id="stage" style="--zoom:1">
        <div data-frame-surface style="position:absolute;left:10px;top:10px;width:100px;height:100px"><img id="a" src="${PIXEL}"></div>
        <div data-frame-surface id="late" style="position:absolute;left:200px;top:10px;width:100px;height:100px"></div>
        <div data-frame-surface style="position:absolute;left:5000px;top:10px;width:100px;height:100px"></div>
      </div>
      <script>
        // Shift+1 "fits all": the zoom changes at once, the second frame's preview arrives 400 ms later
        addEventListener('keydown', (e) => {
          if (e.code !== 'Digit1' || !e.shiftKey) return
          document.getElementById('stage').style.setProperty('--zoom', '0.08')
          setTimeout(() => { document.getElementById('late').innerHTML = '<img src="${PIXEL}">' }, 400)
        })
      </script></body>`
    const browser = await chromium.launch(launchOptions())
    try {
      const page = await browser.newPage({ viewport: { width: 800, height: 600 } })
      await page.setContent(html)
      const r = await measureFitAllRendered(page)
      expect(r.framesInView).toBe(2) // the third surface is far outside the viewport
      expect(r.ms).toBeGreaterThanOrEqual(400)
      expect(r.ms).toBeLessThan(5_000)
    } finally {
      await browser.close()
    }
  })
})
