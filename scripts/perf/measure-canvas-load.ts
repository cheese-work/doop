/* Load-time baseline for a doop file (CHE-5849, CHE-5793 step 4; step 14 reruns it).
 *
 *   DOOP_SESSION_COOKIE='name=value; ...' \
 *     npx tsx scripts/perf/measure-canvas-load.ts \
 *       --base-url https://congvc-c00.taila6fa8a.ts.net:34443 --canvas mRAnnjvGod --runs 5
 *
 * Per run: a fresh browser (so a cold cache), open /c/<canvas>, wait until every mounted
 * frame iframe has posted `doop:frame-ready` and the set has held for 500 ms, and report the
 * time from navigation start. The canvas JSON gives the frame HTML payload and the count of
 * `data:` image URIs. Frames far from the camera hold no iframe (src/lib/frameCulling.ts), so
 * the run also reports framesTotal beside iframesMounted. */
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { chromium } from 'playwright-core'

export interface CanvasSummary {
  frames: number
  htmlBytes: number
  dataUriCount: number
}

export interface RunResult {
  ms: number
  framesTotal: number
  iframesMounted: number
  canvasJsonBytes: number
  htmlBytes: number
  dataUriCount: number
}

export interface MeasureOptions {
  baseUrl: string
  canvasId: string
  /** `name=value; name2=value2` session cookie of an account that can view the canvas */
  cookie?: string
  runs?: number
  timeoutMs?: number
  viewport?: { width: number; height: number }
}

const DATA_IMAGE_URI = /data:image\/[a-z0-9.+-]+[;,]/gi
const SETTLE_MS = 500

export function summarizeCanvas(canvas: { frames?: { html?: string }[] }): CanvasSummary {
  const frames = canvas.frames ?? []
  let htmlBytes = 0
  let dataUriCount = 0
  for (const { html = '' } of frames) {
    htmlBytes += Buffer.byteLength(html, 'utf8')
    dataUriCount += html.match(DATA_IMAGE_URI)?.length ?? 0
  }
  return { frames: frames.length, htmlBytes, dataUriCount }
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

async function measureOnce(opts: MeasureOptions): Promise<RunResult> {
  const { baseUrl, canvasId, cookie, timeoutMs = 120_000, viewport = { width: 1440, height: 900 } } = opts
  const browser = await chromium.launch()
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
    const apiPath = `/api/canvases/${canvasId}`
    const canvasBody = new Promise<Buffer>((resolve, reject) => {
      page.on('response', (res) => {
        if (new URL(res.url()).pathname !== apiPath) return
        if (!res.ok()) return reject(new Error(`${apiPath} answered ${res.status()}`))
        res.body().then(resolve, reject)
      })
    })
    canvasBody.catch(() => {}) // surfaced below; a rejection before the await must not crash the run
    await page.goto(`${baseUrl}/c/${canvasId}`, { timeout: timeoutMs })
    const wait = page.waitForFunction(
      (settle) => {
        const w = window as unknown as { __ready: Set<unknown>; __since: number | null }
        const mounted = document.querySelectorAll('[data-frame-surface] iframe').length
        const now = performance.now()
        if (mounted === 0 || w.__ready.size < mounted) {
          w.__since = null
          return false
        }
        w.__since ??= now
        return now - w.__since >= settle ? w.__since : false
      },
      SETTLE_MS,
      { polling: 25, timeout: timeoutMs },
    )
    // a 401 or 404 on the canvas request ends the run now, not after the timeout
    wait.catch(() => {}) // the race below reports it; a late timeout after browser.close() must not go unhandled
    const failed = canvasBody.then(() => new Promise<never>(() => {}))
    const handle = await Promise.race([wait, failed])
    const ms = (await handle.jsonValue()) as number
    const iframesMounted = await page.locator('[data-frame-surface] iframe').count()
    const body = await canvasBody
    const summary = summarizeCanvas(JSON.parse(body.toString('utf8')))
    return {
      ms,
      framesTotal: summary.frames,
      iframesMounted,
      canvasJsonBytes: body.length,
      htmlBytes: summary.htmlBytes,
      dataUriCount: summary.dataUriCount,
    }
  } finally {
    await browser.close()
  }
}

export async function measureCanvasLoad(opts: MeasureOptions) {
  const runs: RunResult[] = []
  for (let i = 0; i < (opts.runs ?? 5); i++) runs.push(await measureOnce(opts))
  const last = runs.at(-1)
  if (!last) throw new Error('runs must be at least 1')
  return {
    runs,
    medianMs: median(runs.map((r) => r.ms)),
    frames: last.framesTotal,
    htmlBytes: last.htmlBytes,
    dataUriCount: last.dataUriCount,
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      'base-url': { type: 'string' },
      canvas: { type: 'string' },
      runs: { type: 'string', default: '5' },
    },
  })
  const baseUrl = values['base-url']
  const canvasId = values.canvas
  if (!baseUrl || !canvasId)
    throw new Error('usage: --base-url <url> --canvas <id> [--runs 5]; cookie in DOOP_SESSION_COOKIE')
  const cookie = process.env.DOOP_SESSION_COOKIE
  // doop answers 401 to an anonymous API call and the SPA then never requests the canvas
  if (!cookie) throw new Error('set DOOP_SESSION_COOKIE to a session cookie of an account that can view the canvas')
  const result = await measureCanvasLoad({
    baseUrl: baseUrl.replace(/\/$/, ''),
    canvasId,
    cookie,
    runs: Number(values.runs),
  })
  console.log(JSON.stringify({ baseUrl, canvasId, viewport: '1440x900', ...result }, null, 2))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
