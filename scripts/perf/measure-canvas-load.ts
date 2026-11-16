/* Load-time baseline for a doop file (CHE-5849, CHE-5793 step 4; step 14 reruns it).
 *
 *   DOOP_SESSION_COOKIE='name=value; ...' \
 *     npx tsx scripts/perf/measure-canvas-load.ts \
 *       --base-url https://congvc-c00.taila6fa8a.ts.net:34443 --canvas mRAnnjvGod --runs 5 [--viewport 1440x900]
 *
 * Per run: a fresh browser (so a cold cache), open /c/<canvas>, wait until every mounted
 * frame iframe has posted `doop:frame-ready` and the set has held for 500 ms, and report the
 * time from navigation start. One request from Node (not the browser) fetches the canvas JSON
 * for the frame HTML payload and the count of `data:` image URIs. Frames far from the camera
 * hold no iframe (src/lib/frameCulling.ts), so the first view (`ms`) covers only the mounted
 * ones. The run then presses Shift+1 (fit everything), which mounts every frame of the page,
 * and waits again: `allFramesMs` is the time from navigation to the first moment all of them
 * were ready for 500 ms, the figure CHE-5793 compares. */
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { chromium } from 'playwright-core'
import { canvasPages, framePageId } from '../../shared/pages.ts'

export interface CanvasSummary {
  frames: number
  /** frames of the page the file opens on (the first page); fit-all mounts exactly these */
  firstPageFrames: number
  htmlBytes: number
  dataUriCount: number
}

export interface RunResult {
  /** first view: every iframe mounted at load is ready */
  ms: number
  iframesMounted: number
  /** after fit-all: every frame of the opening page is mounted and ready */
  allFramesMs: number
  iframesMountedAll: number
}

export interface MeasureOptions {
  baseUrl: string
  canvasId: string
  /** `name=value; name2=value2` session cookie of an account that can view the canvas */
  cookie?: string
  runs?: number
  timeoutMs?: number
  viewport?: { width: number; height: number }
  /** progress lines; the CLI sends them to stderr */
  onProgress?: (message: string) => void
  /** how often a waiting run says where it is (default 10 s) */
  heartbeatMs?: number
}

const DATA_IMAGE_URI = /data:image\/[a-z0-9.+-]+[;,]/gi
const SETTLE_MS = 500

export function summarizeCanvas(canvas: {
  id?: string
  pages?: { id: string; name: string }[]
  frames?: { html?: string; pageId?: string }[]
}): CanvasSummary {
  const frames = canvas.frames ?? []
  const first = canvasPages({ id: canvas.id ?? '', pages: canvas.pages })[0]!.id
  let htmlBytes = 0
  let dataUriCount = 0
  for (const { html = '' } of frames) {
    htmlBytes += Buffer.byteLength(html, 'utf8')
    dataUriCount += html.match(DATA_IMAGE_URI)?.length ?? 0
  }
  const firstPageFrames = frames.filter(
    (f) => framePageId({ id: canvas.id ?? '', pages: canvas.pages }, f as never) === first,
  ).length
  return { frames: frames.length, firstPageFrames, htmlBytes, dataUriCount }
}

export function parseViewport(value: string | undefined): { width: number; height: number } {
  if (value === undefined) return { width: 1440, height: 900 }
  const m = /^(\d+)x(\d+)$/.exec(value)
  if (!m || !Number(m[1]) || !Number(m[2])) throw new Error(`viewport must be WIDTHxHEIGHT, got "${value}"`)
  return { width: Number(m[1]), height: Number(m[2]) }
}

export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  const hi = sorted[mid] ?? Number.NaN
  return sorted.length % 2 ? hi : ((sorted[mid - 1] ?? Number.NaN) + hi) / 2
}

function parseCookie(header: string, url: string) {
  return header
    .split(';')
    .map((pair) => pair.trim())
    .filter(Boolean)
    .map((pair) => {
      const eq = pair.indexOf('=')
      return { name: pair.slice(0, eq), value: pair.slice(eq + 1), url }
    })
}

/** The canvas JSON, fetched once outside the browser. A stale cookie fails in a second, not after the 120 s
 * wait, and the payload numbers never depend on Playwright reading a large response body. */
export async function fetchCanvasJson(baseUrl: string, canvasId: string, cookie: string): Promise<Buffer> {
  const res = await fetch(`${baseUrl}/api/canvases/${canvasId}`, { headers: { cookie } })
  if (!res.ok)
    throw new Error(
      `${baseUrl}/api/canvases/${canvasId} answered ${res.status}: the cookie is missing, expired or cannot view this canvas. ` +
        'Copy a fresh cookie from a logged-in doop tab (DevTools, Network, any /api request, Cookie header) and rerun.',
    )
  return Buffer.from(await res.arrayBuffer())
}

function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not answer within ${ms} ms`)), ms)
  })
  return Promise.race([p, limit]).finally(() => clearTimeout(timer))
}

async function measureOnce(opts: MeasureOptions, expectedAll: number): Promise<RunResult> {
  const { baseUrl, canvasId, cookie, timeoutMs = 120_000, viewport = { width: 1440, height: 900 } } = opts
  const say = opts.onProgress ?? (() => {})
  const started = Date.now()
  const t = () => `${((Date.now() - started) / 1000).toFixed(0)} s`
  const browser = await chromium.launch()
  say(`  browser started`)
  let beat: NodeJS.Timeout | undefined
  try {
    const context = await browser.newContext({ viewport })
    if (cookie) await context.addCookies(parseCookie(cookie, baseUrl))
    const page = await context.newPage()
    await page.addInitScript(() => {
      const ready = new Set<MessageEventSource>()
      Object.assign(window, { __ready: ready, __since: null })
      window.addEventListener('message', (e) => {
        if (e.data?.type === 'doop:frame-ready' && e.source) ready.add(e.source)
      })
    })
    beat = setInterval(() => {
      // the page may be too busy to answer, so the probe has its own short limit
      within(
        page.evaluate(() => {
          const w = window as unknown as { __ready?: Set<unknown> }
          return `${w.__ready?.size ?? 0}/${document.querySelectorAll('[data-frame-surface] iframe').length}`
        }),
        3000,
        'page',
      ).then(
        (n) => say(`  [${t()}] iframes ready ${n}`),
        (e: unknown) => say(`  [${t()}] ${e instanceof Error ? e.message : e}`),
      )
    }, opts.heartbeatMs ?? 10_000)
    say(`  [${t()}] opening /c/${canvasId} ...`)
    await page.goto(`${baseUrl}/c/${canvasId}`, { timeout: timeoutMs })
    say(`  [${t()}] page loaded`)
    // resolves with the time (since navigation) at which `want` or more iframes were all ready and stayed so for SETTLE_MS
    const settled = (want: number) => {
      const wait = page.waitForFunction(
        ([settle, min]) => {
          const w = window as unknown as { __ready: Set<unknown>; __since: number | null }
          const mounted = document.querySelectorAll('[data-frame-surface] iframe').length
          const now = performance.now()
          if (mounted < min || w.__ready.size < mounted) {
            w.__since = null
            return false
          }
          w.__since ??= now
          return now - w.__since >= settle ? w.__since : false
        },
        [SETTLE_MS, want] as const,
        { polling: 25, timeout: timeoutMs },
      )
      wait.catch(() => {}) // the await below reports it; a late timeout after browser.close() must not go unhandled
      return wait.then((h) => h.jsonValue() as Promise<number>)
    }
    const mountedNow = () => page.locator('[data-frame-surface] iframe').count()
    const ms = await settled(1)
    const iframesMountedFirst = await mountedNow()
    say(`  [${t()}] first view ready after ${Math.round(ms)} ms (${iframesMountedFirst} iframes)`)
    // fit everything: every frame of the page comes inside the culling margin and gets an iframe
    await page.keyboard.press('Shift+Digit1')
    const allFramesMs = await settled(expectedAll).catch(async (e: unknown) => {
      throw new Error(
        `fit-all mounted ${await mountedNow()} of ${expectedAll} frames before the timeout (zoom may be clamped, or a frame never posts doop:frame-ready): ${e instanceof Error ? e.message : e}`,
      )
    })
    const iframesMountedAll = await mountedNow()
    say(`  [${t()}] all ${iframesMountedAll} frames ready after ${Math.round(allFramesMs)} ms`)
    return { ms, iframesMounted: iframesMountedFirst, allFramesMs, iframesMountedAll }
  } finally {
    clearInterval(beat)
    // a frozen renderer can make a plain close() wait forever
    await within(browser.close(), 15_000, 'browser.close').catch((e: unknown) =>
      say(`  ${e instanceof Error ? e.message : e}`),
    )
  }
}

export async function measureCanvasLoad(opts: MeasureOptions) {
  const runs: RunResult[] = []
  const total = opts.runs ?? 5
  const say = opts.onProgress ?? (() => {})
  const body = await fetchCanvasJson(opts.baseUrl, opts.canvasId, opts.cookie ?? '')
  const summary = summarizeCanvas(JSON.parse(body.toString('utf8')))
  say(
    `canvas JSON ${body.length} bytes, ${summary.frames} frames (${summary.firstPageFrames} on the opening page), ${summary.dataUriCount} data: image URIs`,
  )
  for (let i = 0; i < total; i++) {
    say(`run ${i + 1}/${total} ...`)
    // goto and the two ready-waits each get timeoutMs; this stops a run stuck beyond both
    runs.push(
      await within(
        measureOnce(opts, summary.firstPageFrames),
        3 * (opts.timeoutMs ?? 120_000) + 30_000,
        `run ${i + 1}`,
      ),
    )
    say(`run ${i + 1}/${total} done: all frames ${Math.round(runs[i]?.allFramesMs ?? Number.NaN)} ms`)
  }
  if (runs.length === 0) throw new Error('runs must be at least 1')
  return {
    runs,
    medianMs: median(runs.map((r) => r.ms)),
    medianAllFramesMs: median(runs.map((r) => r.allFramesMs)),
    frames: summary.frames,
    firstPageFrames: summary.firstPageFrames,
    canvasJsonBytes: body.length,
    htmlBytes: summary.htmlBytes,
    dataUriCount: summary.dataUriCount,
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      'base-url': { type: 'string' },
      canvas: { type: 'string' },
      runs: { type: 'string', default: '5' },
      viewport: { type: 'string' },
    },
  })
  const baseUrl = values['base-url']
  const canvasId = values.canvas
  if (!baseUrl || !canvasId)
    throw new Error('usage: --base-url <url> --canvas <id> [--runs 5]; cookie in DOOP_SESSION_COOKIE')
  const cookie = process.env.DOOP_SESSION_COOKIE
  // doop answers 401 to an anonymous API call and the SPA then never requests the canvas
  if (!cookie) throw new Error('set DOOP_SESSION_COOKIE to a session cookie of an account that can view the canvas')
  const viewport = parseViewport(values.viewport)
  const base = baseUrl.replace(/\/$/, '')
  console.error(`fetching the canvas JSON, then ${values.runs} cold runs, each prints a line every 10 s ...`)
  const result = await measureCanvasLoad({
    baseUrl: base,
    canvasId,
    cookie,
    runs: Number(values.runs),
    viewport,
    onProgress: (m) => console.error(m), // stderr keeps stdout the JSON result
  })
  console.log(
    JSON.stringify({ baseUrl, canvasId, viewport: `${viewport.width}x${viewport.height}`, ...result }, null, 2),
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
