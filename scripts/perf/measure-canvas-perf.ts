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
 *      The path is 160 wheel events over the first 8 s of a 10 s window on the page's clock. The page logs the
 *      wheels it receives; a run is refused unless every pan and zoom delta reached it inside the window.
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
/** 20 wheel events a second: about what a busy canvas takes in (it handles one input event per frame, and Chrome queues
 * the rest in order), so the queue stays short and the whole path lands inside the window */
const TICK_MS = 50
const TICKS = 160 // 160 * 50 ms: the last wheel is sent at 7,950 ms, which leaves 2 s of the window for queued input to arrive
/** the most the stage takes from one zoom wheel event (`Math.min(40, ...)` in Stage.tsx), so the path asks for no more */
const ZOOM_STEP = 40
const SETTLE_AT_FIT_ALL_MS = 4000
export const PATH_MS = 10_000
/** Chrome merges queued wheel events, so a stall at a turn of the path trims its peak a little; under this share of the
 * scripted peak means a half of the gesture was lost, not merged. */
const PEAK_SHARE = 0.8

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

/** One wheel event every 50 ms for 8 s of the 10 s window: the first half pans (a sideways zigzag, down then up), the second half
 * zooms (Control + wheel, in then out). Every delta cancels, so the path ends on the view it started from, and the
 * list never changes, so a rerun on another build replays the same gesture. The viewport is not used for
 * the deltas: wheel deltas are in screen px and the pointer rests at the centre of the stage. */
export function panZoomPath(_viewport: { width: number; height: number }): PathStep[] {
  const half = TICKS / 2
  return Array.from({ length: TICKS }, (_, k): PathStep => {
    const atMs = k * TICK_MS
    if (k < half) return { atMs, kind: 'pan', deltaX: k % 2 ? 200 : -200, deltaY: k < half / 2 ? 100 : -100 }
    const j = k - half
    return { atMs, kind: 'zoom', deltaX: 0, deltaY: j < half / 2 ? -ZOOM_STEP : ZOOM_STEP }
  })
}

/** One wheel event as the page received it: page clock, Control held, deltas. */
export interface WheelEntry {
  t: number
  ctrl: boolean
  dx: number
  dy: number
}

export interface GestureSummary {
  panEvents: number
  zoomEvents: number
  panNetDx: number
  panNetDy: number
  zoomNetDx: number
  zoomNetDy: number
  /** furthest the running sum of the vertical deltas got from zero in the phase (coalesced events keep the sums) */
  panPeakDy: number
  zoomPeakDy: number
  /** page time, from the start of the window */
  lastPanMs: number
  firstZoomMs: number
  lastMs: number
  /** events that reached the page after the window ended, and the last one's delay past the end */
  lateEvents: number
  lateByMs: number
}

/** What the page received of the gesture. Chrome coalesces queued wheel events into one with the summed delta, so
 * the check is on sums and peaks, never on the event count. A wheel with Control held is a zoom, one without a pan. */
export function summarizeGesture(log: WheelEntry[], t0: number, t1: number): GestureSummary {
  const g: GestureSummary = {
    panEvents: 0,
    zoomEvents: 0,
    panNetDx: 0,
    panNetDy: 0,
    zoomNetDx: 0,
    zoomNetDy: 0,
    panPeakDy: 0,
    zoomPeakDy: 0,
    lastPanMs: 0,
    firstZoomMs: Number.POSITIVE_INFINITY,
    lastMs: 0,
    lateEvents: 0,
    lateByMs: 0,
  }
  for (const e of log) {
    if (e.t < t0) continue
    if (e.t > t1) {
      g.lateEvents++
      g.lateByMs = Math.max(g.lateByMs, e.t - t1)
      continue
    }
    const ms = e.t - t0
    g.lastMs = Math.max(g.lastMs, ms)
    if (e.ctrl) {
      g.zoomEvents++
      g.zoomNetDx += e.dx
      g.zoomNetDy += e.dy
      g.zoomPeakDy = Math.max(g.zoomPeakDy, Math.abs(g.zoomNetDy))
      g.firstZoomMs = Math.min(g.firstZoomMs, ms)
    } else {
      g.panEvents++
      g.panNetDx += e.dx
      g.panNetDy += e.dy
      g.panPeakDy = Math.max(g.panPeakDy, Math.abs(g.panNetDy))
      g.lastPanMs = Math.max(g.lastPanMs, ms)
    }
  }
  return g
}

/** Why the page did not take the scripted gesture whole inside the window; empty when it did. */
export function gestureProblems(g: GestureSummary, steps: PathStep[]): string[] {
  const want = summarizeGesture(
    steps.map((s) => ({ t: s.atMs, ctrl: s.kind === 'zoom', dx: s.deltaX, dy: s.deltaY })),
    0,
    Number.POSITIVE_INFINITY,
  )
  const problems: string[] = []
  if (g.lateEvents > 0)
    problems.push(
      `${g.lateEvents} wheel events reached the page after the window ended (up to ${Math.round(g.lateByMs)} ms late)`,
    )
  for (const [phase, events, net, peak, wantNet, wantPeak] of [
    ['pan', g.panEvents, [g.panNetDx, g.panNetDy], g.panPeakDy, [want.panNetDx, want.panNetDy], want.panPeakDy],
    ['zoom', g.zoomEvents, [g.zoomNetDx, g.zoomNetDy], g.zoomPeakDy, [want.zoomNetDx, want.zoomNetDy], want.zoomPeakDy],
  ] as const) {
    if (events === 0)
      problems.push(`no ${phase} wheel events reached the page${phase === 'zoom' ? ' with Control held' : ''}`)
    else if (net[0] !== wantNet[0] || net[1] !== wantNet[1])
      problems.push(`${phase} deltas received (${net.join(', ')}) differ from the script (${wantNet.join(', ')})`)
    else if (peak < PEAK_SHARE * wantPeak)
      problems.push(`${phase} reached ${peak} of ${wantPeak}: events were lost or merged`)
  }
  if (g.panEvents > 0 && g.zoomEvents > 0 && g.lastPanMs > g.firstZoomMs)
    problems.push('pan and zoom wheel events overlapped on the page')
  return problems
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
  const rec = { frames: [], wheels: [], loaf: 0, loafSupported: false, on: false, t0: 0, t1: 0, until: 0 }
  window.__perf = rec
  rec.wheels = []
  addEventListener('wheel', (e) => { rec.wheels.push({ t: performance.now(), ctrl: e.ctrlKey, dx: e.deltaX, dy: e.deltaY }) }, { capture: true, passive: true })
  try {
    new PerformanceObserver((l) => { if (rec.on) for (const e of l.getEntries()) if (e.duration > ${LONG_FRAME_MS}) rec.loaf++ })
      .observe({ type: 'long-animation-frame' })
    rec.loafSupported = true
  } catch {}
  let last = performance.now()
  const tick = (now) => {
    if (rec.on && now >= rec.until) { rec.t1 = now; rec.on = false }
    if (rec.on) rec.frames.push(now - last)
    last = now
    requestAnimationFrame(tick)
  }
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

export interface RecordOptions {
  /** the recording window, timed on the page's own clock (default `PATH_MS`) */
  windowMs?: number
  /** runs once the recorder is on, before the first step (the test uses it to cause a long frame) */
  onStart?: () => Promise<void>
}

/** Reads the live iframe count and heap, then replays `steps` and returns what the recorder saw.
 * The recorder is switched on and off by the page's own clock, so the window is `windowMs` however slow the
 * page is. Wheel events are sent on the schedule without waiting for the page to acknowledge each one (an
 * awaited wheel takes as long as a busy frame, which would stretch the path and make it depend on the page's
 * speed); Chrome queues and coalesces them, so every delta still arrives and the gesture is the same before and after. */
export async function recordPath(
  page: Page,
  steps: PathStep[],
  viewport: { width: number; height: number },
  { windowMs = PATH_MS, onStart }: RecordOptions = {},
) {
  await page.evaluate(RECORDER)
  const iframes = await page.locator('iframe[data-doop-frame]').count()
  const heap = await jsHeapMb(page)
  await page.mouse.move(viewport.width / 2, viewport.height / 2)
  // the window ends at the first frame past `windowMs` on the page's clock; the timer only backs that up, because
  // queued wheel events can hold the main thread ahead of a timer for longer than a frame
  await page.evaluate((ms) => {
    const r = (window as never as { __perf: { on: boolean; t0: number; t1: number; until: number } }).__perf
    r.t0 = performance.now()
    r.until = r.t0 + ms
    r.on = true
    setTimeout(() => {
      if (!r.on) return
      r.t1 = performance.now()
      r.on = false
    }, ms + 500)
  }, windowMs)
  const start = Date.now()
  await onStart?.()
  const sent: Promise<unknown>[] = []
  const failures: string[] = []
  const send = (p: Promise<unknown>) =>
    sent.push(p.catch((e: unknown) => void failures.push(e instanceof Error ? e.message : String(e))))
  let ctrl = false
  for (const s of steps) {
    const wait = s.atMs - (Date.now() - start)
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))
    // Control stays down through the whole zoom half: one key event per phase, not two per wheel
    if ((s.kind === 'zoom') !== ctrl) {
      send(s.kind === 'zoom' ? page.keyboard.down('Control') : page.keyboard.up('Control'))
      ctrl = s.kind === 'zoom'
    }
    send(page.mouse.wheel(s.deltaX, s.deltaY))
  }
  if (ctrl) send(page.keyboard.up('Control'))
  await page.waitForFunction(() => !(window as never as { __perf: { on: boolean } }).__perf.on, undefined, {
    timeout: windowMs + 30_000,
  })
  // every wheel is acknowledged by the page (or has failed) before the gesture is judged
  await Promise.all(sent)
  if (failures.length > 0)
    throw new Error(`${failures.length} of ${sent.length} input events failed to dispatch: ${failures[0]}`)
  const rec = await page.evaluate(() => {
    const r = (
      window as never as {
        __perf: {
          frames: number[]
          wheels: WheelEntry[]
          loaf: number
          loafSupported: boolean
          t0: number
          t1: number
        }
      }
    ).__perf
    return { frames: r.frames, wheels: r.wheels, loaf: r.loaf, loafSupported: r.loafSupported, t0: r.t0, t1: r.t1 }
  })
  const gesture = summarizeGesture(rec.wheels, rec.t0, rec.t1)
  const problems = gestureProblems(gesture, steps)
  if (problems.length > 0) throw new Error(`the scripted gesture did not reach the page whole: ${problems.join('; ')}`)
  // without the Long Animation Frames API (Chrome before 123) the nearest stand-in is a frame gap over 50 ms
  const longFrames = rec.loafSupported ? rec.loaf : rec.frames.filter((d) => d > LONG_FRAME_MS).length
  return {
    frames: rec.frames,
    longFrames,
    loafSupported: rec.loafSupported,
    iframes,
    jsHeapMb: heap,
    elapsedMs: rec.t1 - rec.t0,
    sentSteps: steps.length,
    gesture,
  }
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
    const perRun: (RunMetrics & {
      loafSupported: boolean
      framesInView: number
      elapsedMs: number
      sentSteps: number
      gesture: { panEvents: number; zoomEvents: number; lastPanMs: number; firstZoomMs: number; lastMs: number }
    })[] = []
    let chrome = ''
    for (let i = 0; i < runs; i++) {
      console.error(`run ${i + 1}/${runs} ...`)
      const p = await oneRun(base, canvasId, cookie, viewport)
      chrome = p.chrome
      if (p.elapsedMs < PATH_MS || p.elapsedMs > PATH_MS + 1000)
        throw new Error(`run ${i + 1}: the recording window was ${Math.round(p.elapsedMs)} ms, not ${PATH_MS} ms`)
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
        elapsedMs: Math.round(p.elapsedMs),
        sentSteps: p.sentSteps,
        // what the page received, on its own clock (the harness has already checked the sums against the script)
        gesture: {
          panEvents: p.gesture.panEvents,
          zoomEvents: p.gesture.zoomEvents,
          lastPanMs: Math.round(p.gesture.lastPanMs),
          firstZoomMs: Math.round(p.gesture.firstZoomMs),
          lastMs: Math.round(p.gesture.lastMs),
        },
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
