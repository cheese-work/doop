/* Zoomed-out lag on a big file (CHE-7019; load method of CHE-6196). Local, no human credential.
 *
 *   bun run build
 *   npx tsx scripts/perf/measure-lag.ts [--export <canvas.json> | --erus-like] [--runs 3] [--viewport 1440x900] [--max-live 24]
 *
 * Starts the production server from this checkout (withLocalDoop), imports the file, opens it, presses
 * Shift+1 (fit all) and reports, per run:
 *   - iframes mounted at fit-all (the done-when 1 browser check: exits 1 when above --max-live)
 *   - long tasks (count, total ms) and frame time (rAF delta p50, p95, max) while panning and zooming for 6 s
 *   - gestureMs: first zoom-in wheel on one frame until it is 300 px wide; zoomInMs: from then to its iframe being ready with no preview over it
 * --erus-like builds a stand-in with the reported size mix of the erus file (645 frames; 207 390x844,
 * 154 1440x900, 87 390x867, 18 1440x1800, the other 179 split between 1440x1024 and 390x800). */
import { pathToFileURL } from 'node:url'
import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { chromium } from 'playwright-core'
import { importCanvasExport, type CanvasExport } from './import-canvas-export.ts'
import { withLocalDoop } from './measure-local.ts'
import { median, parseViewport } from './measure-canvas-load.ts'

export function erusLike(): CanvasExport {
  const sizes: [number, number, number][] = [
    [390, 844, 207],
    [1440, 900, 154],
    [390, 867, 87],
    [1440, 1800, 18],
    [1440, 1024, 100],
    [390, 800, 79],
  ]
  const frames: CanvasExport['frames'] = []
  const COLS = 30
  const GAP = 80
  let i = 0
  for (const [width, height, n] of sizes)
    for (let k = 0; k < n; k++, i++) {
      const row = Math.floor(i / COLS)
      const col = i % COLS
      frames.push({
        name: `f${i}`,
        x: col * (1440 + GAP),
        y: row * (1800 + GAP),
        width,
        height,
        html: `<!doctype html><body style="margin:0;font:16px sans-serif"><h1>Frame ${i}</h1>${'<p style="padding:8px;background:#eef">lorem ipsum dolor sit amet</p>'.repeat(20)}</body>`,
      })
    }
  return { id: 'erus', name: 'erus-like', pages: [{ id: 'erus:page1', name: 'Page 1' }], frames }
}

const pct = (xs: number[], p: number) =>
  [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))] ?? NaN

async function once(base: string, canvasId: string, cookie: string, viewport: { width: number; height: number }) {
  const browser = await chromium.launch()
  try {
    const context = await browser.newContext({ viewport })
    await context.addCookies([
      { name: cookie.split('=')[0]!, value: cookie.split(';')[0]!.slice(cookie.indexOf('=') + 1), url: base },
    ])
    const page = await context.newPage()
    // a string, not a function: tsx's keepNames would inject a `__name` helper the page does not have
    await page.addInitScript(`{
      const ready = new Set()
      const lag = { frames: [], tasks: [], on: false }
      Object.assign(window, { __ready: ready, __lag: lag })
      window.addEventListener('message', (e) => {
        if (e.data && e.data.type === 'doop:frame-ready' && e.source) ready.add(e.source)
      })
      new PerformanceObserver((l) => {
        if (lag.on) for (const t of l.getEntries()) lag.tasks.push(t.duration)
      }).observe({ type: 'longtask' })
      let last = performance.now()
      const tick = (now) => {
        if (lag.on) lag.frames.push(now - last)
        last = now
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    }`)
    await page.goto(`${base}/c/${canvasId}`)
    await page.waitForSelector('[data-frame-surface]', { timeout: 120_000 })
    await page.keyboard.press('Shift+Digit1')
    await page.waitForTimeout(4000) // let mounts and previews settle at fit-all
    const iframesAtFitAll = await page.locator('iframe[data-doop-frame]').count()

    // pan and zoom for 6 s
    await page.evaluate(() => ((window as never as { __lag: { on: boolean } }).__lag.on = true))
    await page.mouse.move(viewport.width / 2, viewport.height / 2)
    const end = Date.now() + 6000
    for (let k = 0; Date.now() < end; k++) {
      await page.mouse.wheel(k % 2 ? 80 : -80, 40)
      if (k % 5 === 0) {
        await page.keyboard.down('Control')
        await page.mouse.wheel(0, (k / 5) % 2 ? -30 : 30)
        await page.keyboard.up('Control')
      }
      await page.waitForTimeout(16)
    }
    const lag = await page.evaluate(() => {
      const l = (window as never as { __lag: { frames: number[]; tasks: number[]; on: boolean } }).__lag
      l.on = false
      return { frames: l.frames, tasks: l.tasks }
    })

    // zoom in on the frame nearest the centre; time to a ready, preview-free iframe
    await page.keyboard.press('Shift+Digit1')
    await page.waitForTimeout(2000)
    // a wide frame near the centre (a 1440-wide frame is ~115 px at fit-all); zoom on its centre
    const target = await page.evaluate(
      ([cx, cy]) => {
        let best: { x: number; y: number; d: number } | null = null
        for (const el of document.querySelectorAll('[data-frame-surface]')) {
          const r = el.getBoundingClientRect()
          if (r.width < 100 || r.right < 0 || r.left > innerWidth) continue
          const x = r.left + r.width / 2
          const y = r.top + r.height / 2
          const d = (x - cx!) ** 2 + (y - cy!) ** 2
          if (!best || d < best.d) best = { x, y, d }
        }
        return best
      },
      [viewport.width / 2, viewport.height / 2] as const,
    )
    if (!target) throw new Error('no frame wide enough to zoom on after fit-all')
    const probe = (cx: number, cy: number) =>
      page.evaluate(
        ([x, y]) => {
          const ready = (window as never as { __ready: Set<unknown> }).__ready
          const el = document.elementFromPoint(x!, y!)?.closest('[data-frame-surface]')
          if (!el) return { width: 0, live: false }
          const iframe = el.querySelector('iframe')
          // live and painted: its runtime posted frame-ready and no preview image covers it
          return {
            width: el.getBoundingClientRect().width,
            live: !!iframe && ready.has(iframe.contentWindow) && !el.querySelector('img'),
          }
        },
        [cx, cy] as const,
      )
    const t0 = Date.now()
    let gestureMs = NaN
    let zoomInMs = NaN
    await page.mouse.move(target.x, target.y)
    await page.keyboard.down('Control')
    for (const deadline = t0 + 20_000; Date.now() < deadline;) {
      await page.mouse.wheel(0, -40)
      const s = await probe(target.x, target.y)
      if (Number.isNaN(gestureMs) && s.width >= 300) gestureMs = Date.now() - t0 // the frame is big enough to read
      if (!Number.isNaN(gestureMs) && s.live) {
        zoomInMs = Date.now() - t0 - gestureMs // from "big enough" to the live, painted frame
        break
      }
      await page.waitForTimeout(16)
    }
    await page.keyboard.up('Control')
    return {
      iframesAtFitAll,
      longTasks: lag.tasks.length,
      longTaskMs: Math.round(lag.tasks.reduce((a, b) => a + b, 0)),
      frameP50: Math.round(pct(lag.frames, 0.5)),
      frameP95: Math.round(pct(lag.frames, 0.95)),
      frameMax: Math.round(Math.max(...lag.frames)),
      framesSampled: lag.frames.length,
      gestureMs,
      zoomInMs,
    }
  } finally {
    await browser.close()
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      export: { type: 'string' },
      'erus-like': { type: 'boolean' },
      runs: { type: 'string', default: '3' },
      viewport: { type: 'string' },
      'max-live': { type: 'string', default: '24' },
    },
  })
  const exported = values.export ? (JSON.parse(readFileSync(values.export, 'utf8')) as CanvasExport) : erusLike()
  const viewport = parseViewport(values.viewport)
  const runs = await withLocalDoop(async (base, cookie) => {
    const id = await importCanvasExport(base, cookie, exported)
    console.error(`imported ${exported.frames.length} frames as ${id}`)
    const out = []
    for (let i = 0; i < Number(values.runs); i++) {
      out.push(await once(base, id, cookie, viewport))
      console.error(`run ${i + 1}: ${JSON.stringify(out[i])}`)
    }
    return out
  })
  const medians = Object.fromEntries(
    (Object.keys(runs[0]!) as (keyof (typeof runs)[0])[]).map((k) => [k, median(runs.map((r) => r[k]))]),
  )
  console.log(
    JSON.stringify(
      { frames: exported.frames.length, viewport: `${viewport.width}x${viewport.height}`, runs, medians },
      null,
      2,
    ),
  )
  if (medians.iframesAtFitAll! > Number(values['max-live'])) {
    console.error(`FAIL: ${medians.iframesAtFitAll} iframes mounted at fit-all, limit ${values['max-live']}`)
    process.exit(1)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
