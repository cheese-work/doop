import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Browser, Page } from 'puppeteer-core'
import { findBrowserPath, getBrowser } from '../server/screenshot'
import { FRAME_BOOTSTRAP } from '../src/lib/frameRuntime'

type Msg = { type: string; name?: string; time?: number; paintTiming?: boolean; at: number }
type Run = { msgs: Msg[]; sentAt: number; origin: number }

/* the frame is loaded exactly as FrameView does: sandboxed srcdoc iframe, the
   real FRAME_BOOTSTRAP, HTML delivered by doop:html */
describe.skipIf(!findBrowserPath())('frame paint signals (real bootstrap)', { timeout: 30_000 }, () => {
  let browser: Browser
  let page: Page
  beforeAll(async () => {
    browser = await getBrowser()
  })
  afterAll(async () => {
    await browser?.close()
  })

  async function run(html: string | null, settleMs: number, untilPaint = false): Promise<Run> {
    page = await browser.newPage()
    try {
      /* a background tab does not paint when other files share the browser */
      await page.bringToFront()
      await page.setViewport({ width: 600, height: 400 })
      await page.setContent('<!doctype html><body></body>')
      return await page.evaluate(
        async (boot, doc, settle, untilPaint) => {
          const msgs: Msg[] = []
          let sentAt = -1
          let resolveReady!: () => void
          const ready = new Promise<void>((r) => (resolveReady = r))
          window.addEventListener('message', (ev) => {
            const d = ev.data
            if (typeof d?.type !== 'string' || !d.type.startsWith('doop:')) return
            msgs.push({ ...d, at: performance.now() })
            if (d.type === 'doop:frame-ready') resolveReady()
          })
          const iframe = document.createElement('iframe')
          iframe.setAttribute('sandbox', 'allow-scripts')
          iframe.style.cssText = 'width:300px;height:200px;border:0'
          iframe.srcdoc = boot
          document.body.append(iframe)
          await ready
          if (doc !== null) {
            sentAt = performance.now()
            iframe.contentWindow!.postMessage({ type: 'doop:html', html: doc, reqId: 'r1' }, '*')
          }
          const end = performance.now() + settle
          while (performance.now() < end && !(untilPaint && msgs.some((m) => m.type === 'doop:paint'))) {
            await new Promise((r) => setTimeout(r, 20))
          }
          return { msgs, sentAt, origin: performance.timeOrigin }
        },
        FRAME_BOOTSTRAP,
        html,
        settleMs,
        untilPaint,
      )
    } finally {
      await page.close()
    }
  }
  const paints = (r: Run) => r.msgs.filter((m) => m.type === 'doop:paint')

  it('bootstrap alone posts no paint signal', async () => {
    const r = await run(null, 700)
    expect(r.msgs.some((m) => m.type === 'doop:frame-ready')).toBe(true)
    expect(paints(r)).toEqual([])
  })

  it('C1-a: a coloured box with no text posts first-paint', async () => {
    const r = await run(
      '<!doctype html><body style="margin:0"><div style="width:150px;height:120px;background:#c33"></div></body>',
      5000,
      true,
    )
    const first = paints(r).find((m) => m.name === 'first-paint')
    expect(first).toBeTruthy()
    // absolute time converts to a parent-relative time after the html was sent
    expect(first!.time! - r.origin).toBeGreaterThan(r.sentAt - 50)
  })

  it('C1-c: an empty body posts no paint signal', async () => {
    const r = await run('<!doctype html><body></body>', 700)
    expect(r.msgs.some((m) => m.type === 'doop:html-result')).toBe(true)
    expect(paints(r)).toEqual([])
  })

  it('C1-e: a body hidden by CSS for 800 ms paints no earlier than 800 ms after the html', async () => {
    const r = await run(
      '<!doctype html><html><head><style>@keyframes show{to{visibility:visible}}body{visibility:hidden;animation:show 0s 800ms forwards}</style></head>' +
        '<body style="margin:0"><div style="width:150px;height:120px;background:#c33"></div>' +
        // the frame's own clock at apply time, so a busy host cannot skew the bound
        '<script>parent.postMessage({ type: "doop:test-applied", time: performance.timeOrigin + performance.now() }, "*")</script></body></html>',
      5000,
      true,
    )
    const first = paints(r).find((m) => m.name === 'first-paint')
    expect(first).toBeTruthy()
    // plan bound: paint at or after the apply (just before doop:html-result) + 800 ms, on the frame's clock
    expect(r.msgs.some((m) => m.type === 'doop:html-result')).toBe(true)
    const applied = r.msgs.find((m) => m.type === 'doop:test-applied')
    expect(applied).toBeTruthy()
    expect(first!.time!).toBeGreaterThanOrEqual(applied!.time! + 800)
  })

  it('doop:frame-ready carries paintTiming', async () => {
    const r = await run(null, 0)
    expect(r.msgs.find((m) => m.type === 'doop:frame-ready')!.paintTiming).toBe(true)
  })
})
