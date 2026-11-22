/* Canvas performance harness and baseline (CHE-5889, CHE-5793 step 22, contract C8; step 30 reruns it).
 *
 *   bun run build                    # once per checkout: the server serves dist/
 *   export CHROME_PATH=/opt/google/chrome/chrome   # the one Chrome, before and after
 *   npx tsx scripts/perf/build-canvas-fixture.ts --export <canvas.json> --out <dir outside the repo>
 *   npx tsx scripts/perf/measure-canvas-perf.ts --fixture <dir>/fixture.json --runs 5 [--viewport 2560x1440] [--out result.json]
 *
 * Target: a local doop (withLocalDoop) seeded with the fixture. Per run, one fresh browser:
 *   1. load: navigation to every frame in view rendered at fit-all zoom (`measureFitAllRendered`). A frame
 *      is rendered when its stored preview image has loaded, or its live iframe has taken the preview's
 *      place. Fit-all culls small frames to previews, so the CHE-5849 iframe count (measure-canvas-load.ts)
 *      no longer reaches the frame count there;
 *   2. at fit-all, settle, read the live iframe count and the JS heap, then replay one scripted 10 s pan
 *      and zoom path (`panZoomPath`) and record frame time (rAF deltas) and long animation frames
 *      (Long Animation Frames API, over 50 ms).
 * The result is the median of the runs. Same host, same Chrome, same flags before and after: the
 * numbers are relative. stdout is the JSON result, progress goes to stderr. */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { chromium, type Page } from 'playwright-core'
import { fixtureManifest } from './build-canvas-fixture.ts'
import { importCanvasExport, type CanvasExport } from './import-canvas-export.ts'
import { CHROME_FLAGS, launchOptions, median, parseViewport } from './measure-canvas-load.ts'
import { withLocalDoop } from './measure-local.ts'

export const LONG_FRAME_MS = 50
const TICK_MS = 16
const TICKS = 624 // 624 * 16 ms: the last wheel lands at 9,968 ms
const SETTLE_AT_FIT_ALL_MS = 4000

export interface PathStep {
  atMs: number
  kind: 'pan' | 'zoom'
  deltaX: number
  deltaY: number
}

/** Sorted nearest-rank percentile: the smallest value with at least p of the samples at or below it. */
export function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] ?? Number.NaN
}

export function summarizeFrameTimes(deltas: number[]) {
  if (deltas.length === 0) throw new Error('no frames were recorded during the path')
  return {
    p50: percentile(deltas, 0.5),
    p95: percentile(deltas, 0.95),
    over50: deltas.filter((d) => d > LONG_FRAME_MS).length,
  }
}

/** One wheel event every 16 ms for 10 s: the first half pans (a sideways zigzag, down then up), the second half
 * zooms (Control + wheel, in then out). Every delta cancels, so the path ends on the view it started from, and the
 * list never changes, so a rerun on another build replays the same gesture. The viewport is not used for
 * the deltas: wheel deltas are in screen px and the pointer rests at the centre of the stage. */
export function panZoomPath(_viewport: { width: number; height: number }): PathStep[] {
  const half = TICKS / 2
  return Array.from({ length: TICKS }, (_, k): PathStep => {
    const atMs = k * TICK_MS
    if (k < half) return { atMs, kind: 'pan', deltaX: k % 2 ? 80 : -80, deltaY: k < half / 2 ? 40 : -40 }
    const j = k - half
    return { atMs, kind: 'zoom', deltaX: 0, deltaY: j < half / 2 ? -30 : 30 }
  })
}

export interface RunMetrics {
  allFramesMs: number
  frameP50: number
  frameP95: number
  longFrames: number
  iframes: number
  jsHeapMb: number
}

export function aggregateRuns(runs: RunMetrics[]): RunMetrics {
  const keys = Object.keys(runs[0] ?? {}) as (keyof RunMetrics)[]
  return Object.fromEntries(keys.map((k) => [k, median(runs.map((r) => r[k]))])) as unknown as RunMetrics
}

/** Recorder in the page: rAF deltas and long animation frames, only while `on`. A string, not a function: tsx's
 * keepNames would inject a `__name` helper the page does not have. */
const RECORDER = `{
  const rec = { frames: [], loaf: 0, loafSupported: false, on: false }
  window.__perf = rec
  try {
    new PerformanceObserver((l) => { if (rec.on) for (const e of l.getEntries()) if (e.duration > ${LONG_FRAME_MS}) rec.loaf++ })
      .observe({ type: 'long-animation-frame' })
    rec.loafSupported = true
  } catch {}
  let last = performance.now()
  const tick = (now) => { if (rec.on) rec.frames.push(now - last); last = now; requestAnimationFrame(tick) }
  requestAnimationFrame(tick)
}`

/** JS heap of the page's main frame after a forced collection, in MB (CDP, so it needs no page cooperation). */
async function jsHeapMb(page: Page): Promise<number> {
  const cdp = await page.context().newCDPSession(page)
  try {
    await cdp.send('Performance.enable')
    await cdp.send('HeapProfiler.collectGarbage')
    const { metrics } = (await cdp.send('Performance.getMetrics')) as { metrics: { name: string; value: number }[] }
    const used = metrics.find((m) => m.name === 'JSHeapUsedSize')?.value
    if (used === undefined) throw new Error('Performance.getMetrics returned no JSHeapUsedSize')
    return used / 1024 / 1024
  } finally {
    await cdp.detach().catch(() => {})
  }
}

/** Reads the live iframe count and heap, then replays `steps` on the page and returns what the recorder saw.
 * `onStart` runs once the recorder is on, before the first step (the test uses it to cause a long frame). */
export async function recordPath(
  page: Page,
  steps: PathStep[],
  viewport: { width: number; height: number },
  onStart?: () => Promise<void>,
) {
  await page.evaluate(RECORDER)
  const iframes = await page.locator('iframe[data-doop-frame]').count()
  const heap = await jsHeapMb(page)
  await page.mouse.move(viewport.width / 2, viewport.height / 2)
  await page.evaluate(() => ((window as never as { __perf: { on: boolean } }).__perf.on = true))
  await onStart?.()
  const start = Date.now()
  for (const s of steps) {
    const wait = s.atMs - (Date.now() - start)
    if (wait > 0) await page.waitForTimeout(wait)
    if (s.kind === 'zoom') await page.keyboard.down('Control')
    await page.mouse.wheel(s.deltaX, s.deltaY)
    if (s.kind === 'zoom') await page.keyboard.up('Control')
  }
  const rec = await page.evaluate(() => {
    const r = (window as never as { __perf: { frames: number[]; loaf: number; loafSupported: boolean; on: boolean } })
      .__perf
    r.on = false
    return { frames: r.frames, loaf: r.loaf, loafSupported: r.loafSupported }
  })
  // without the Long Animation Frames API (Chrome before 123) the nearest stand-in is a frame gap over 50 ms
  const longFrames = rec.loafSupported ? rec.loaf : rec.frames.filter((d) => d > LONG_FRAME_MS).length
  return { frames: rec.frames, longFrames, loafSupported: rec.loafSupported, iframes, jsHeapMb: heap }
}

/** Fit-all, then the time since navigation at which every frame in view was rendered and stayed so for `settleMs`. */
export async function measureFitAllRendered(page: Page, settleMs = 500, timeoutMs = 120_000) {
  const zoomBefore = await page.evaluate(() => {
    const e = document.querySelector('[data-frame-surface]')
    return e ? getComputedStyle(e).getPropertyValue('--zoom') : ''
  })
  const pressedAt = await page.evaluate(() => performance.now())
  await page.keyboard.press('Shift+Digit1')
  const handle = await page.waitForFunction(
    ([settle, before, pressed]) => {
      const w = window as never as { __fit?: { sig: string; since: number } }
      const now = performance.now()
      const inView = [...document.querySelectorAll('[data-frame-surface]')].filter((e) => {
        const r = e.getBoundingClientRect()
        return r.width > 0 && r.right > 0 && r.left < innerWidth && r.bottom > 0 && r.top < innerHeight
      })
      const zoom = inView[0] ? getComputedStyle(inView[0]).getPropertyValue('--zoom') : ''
      // fit-all has not landed until the zoom moves (or 2 s pass: the view may already have been fit)
      if (inView.length === 0 || (zoom === before && now - (pressed as number) < 2000)) return false
      const rendered = inView.every((e) => {
        const img = e.querySelector('img')
        // a live frame drops its preview once its runtime is ready
        return img ? img.complete && img.naturalWidth > 0 : e.querySelector('iframe') !== null
      })
      if (!rendered) {
        w.__fit = undefined
        return false
      }
      const sig = `${zoom}|${inView.length}`
      if (w.__fit?.sig !== sig) w.__fit = { sig, since: now }
      return now - w.__fit.since >= (settle as number) ? { ms: w.__fit.since, framesInView: inView.length } : false
    },
    [settleMs, zoomBefore, pressedAt] as const,
    { polling: 25, timeout: timeoutMs },
  )
  return (await handle.jsonValue()) as { ms: number; framesInView: number }
}

function parseCookie(header: string, url: string) {
  return header
    .split(';')
    .map((pair) => pair.trim())
    .filter(Boolean)
    .map((pair) => ({ name: pair.slice(0, pair.indexOf('=')), value: pair.slice(pair.indexOf('=') + 1), url }))
}

async function oneRun(base: string, canvasId: string, cookie: string, viewport: { width: number; height: number }) {
  const browser = await chromium.launch(launchOptions())
  try {
    const context = await browser.newContext({ viewport })
    await context.addCookies(parseCookie(cookie, base))
    const page = await context.newPage()
    await page.goto(`${base}/c/${canvasId}`)
    await page.waitForSelector('[data-frame-surface]', { timeout: 120_000 })
    const fit = await measureFitAllRendered(page)
    await page.waitForTimeout(SETTLE_AT_FIT_ALL_MS)
    const out = await recordPath(page, panZoomPath(viewport), viewport)
    return { ...out, ...fit, chrome: browser.version() }
  } finally {
    await browser.close()
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      fixture: { type: 'string' },
      runs: { type: 'string', default: '5' },
      viewport: { type: 'string', default: '2560x1440' },
      out: { type: 'string' },
    },
  })
  if (!values.fixture) throw new Error('usage: --fixture <fixture.json> [--runs 5] [--viewport 2560x1440] [--out file]')
  const fixture = JSON.parse(readFileSync(values.fixture, 'utf8')) as CanvasExport
  const viewport = parseViewport(values.viewport)
  const runs = Number(values.runs)
  const result = await withLocalDoop(async (base, cookie) => {
    const canvasId = await importCanvasExport(base, cookie, fixture)
    const perRun: (RunMetrics & { loafSupported: boolean; framesInView: number })[] = []
    let chrome = ''
    for (let i = 0; i < runs; i++) {
      console.error(`run ${i + 1}/${runs} ...`)
      const p = await oneRun(base, canvasId, cookie, viewport)
      chrome = p.chrome
      const s = summarizeFrameTimes(p.frames)
      perRun.push({
        allFramesMs: Math.round(p.ms),
        frameP50: s.p50,
        frameP95: s.p95,
        longFrames: p.longFrames,
        iframes: p.iframes,
        jsHeapMb: Math.round(p.jsHeapMb * 10) / 10,
        loafSupported: p.loafSupported,
        framesInView: p.framesInView,
      })
      console.error(`  ${JSON.stringify(perRun[i])}`)
    }
    return { chrome, perRun }
  })
  const gitSha = execFileSync('git', ['rev-parse', 'HEAD']).toString().trim()
  const output = {
    meta: {
      chrome: result.chrome,
      flags: CHROME_FLAGS,
      headless: true,
      viewport: `${viewport.width}x${viewport.height}`,
      command: `npx tsx scripts/perf/measure-canvas-perf.ts ${process.argv.slice(2).join(' ')}`,
      fixtureManifestSha256: fixtureManifest(fixture).sha256,
      frames: fixture.frames.length,
      doopSha: gitSha,
      host: hostname(),
      node: process.version,
      at: new Date().toISOString(),
    },
    runs: result.perRun,
    median: aggregateRuns(result.perRun),
  }
  const json = JSON.stringify(output, null, 2)
  if (values.out) writeFileSync(values.out, json)
  console.log(json)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
