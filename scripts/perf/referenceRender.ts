/* Reference render for the doop first-frame metric (CHE-6942 plan r4, contract C1; CHE-6954).
 *
 * Decides whether a frame's HTML has visible content, from a real render and never from a
 * missing paint signal. Run once per fixture, outside every timed run; the cache key is the
 * SHA256 of the frame HTML plus the frame size (the size changes the render, the HTML alone
 * would not). A blank page holds one sandboxed `srcdoc` iframe with the real FRAME_BOOTSTRAP
 * at the frame's size. The frame HTML goes in through `doop:html`; the render waits for fonts,
 * images and finite animations (at most 5 s), then the iframe is screenshotted at scale 1 and
 * compared with the same iframe before the HTML was posted. No script calls this yet (step 5). */
import { createHash } from 'node:crypto'
import type { Browser } from 'playwright-core'
import sharp from 'sharp'
import { FRAME_BOOTSTRAP } from '../../src/lib/frameRuntime.ts'
import { changedPixels, type Raster } from './paintValidation.ts'

export interface ReferenceInput {
  html: string
  width: number
  height: number
}
export interface Reference {
  /** at least one pixel changed once the HTML was applied */
  visible: boolean
  /** the iframe after the HTML settled */
  raster: Raster
  /** the same iframe before the HTML was posted */
  empty: Raster
}

export const SETTLE_LIMIT_MS = 5000

export function referenceKey(i: ReferenceInput): string {
  return `${createHash('sha256').update(i.html).digest('hex')}:${i.width}x${i.height}`
}

async function decode(png: Buffer): Promise<Raster> {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  return { width: info.width, height: info.height, data: new Uint8Array(data) }
}

export async function renderReference(
  browser: Browser,
  input: ReferenceInput,
  cache: Map<string, Reference> = new Map(),
): Promise<Reference> {
  const key = referenceKey(input)
  const hit = cache.get(key)
  if (hit) return hit
  const page = await browser.newPage({
    viewport: { width: Math.max(input.width, 1), height: Math.max(input.height, 1) },
    deviceScaleFactor: 1,
  })
  try {
    await page.setContent(
      `<body style="margin:0;background:#fff"><iframe id="f" sandbox="allow-scripts" style="display:block;border:0;background:#fff;width:${input.width}px;height:${input.height}px"></iframe></body>`,
    )
    // listen first: the bootstrap posts frame-ready as soon as the srcdoc loads
    await page.evaluate((boot) => {
      const f = document.getElementById('f') as HTMLIFrameElement
      ;(window as unknown as { __ready: Promise<void> }).__ready = new Promise((resolve) => {
        window.addEventListener('message', (e) => {
          if (e.source === f.contentWindow && e.data?.type === 'doop:frame-ready') resolve()
        })
      })
      f.srcdoc = boot
    }, FRAME_BOOTSTRAP)
    await page.evaluate(() => (window as unknown as { __ready: Promise<void> }).__ready)
    const handle = (await page.$('#f'))!
    const empty = await decode(await handle.screenshot())

    await page.evaluate((html) => {
      const f = document.getElementById('f') as HTMLIFrameElement
      return new Promise<void>((resolve) => {
        window.addEventListener('message', function on(e) {
          if (e.source === f.contentWindow && e.data?.reqId === 'ref') {
            window.removeEventListener('message', on)
            resolve()
          }
        })
        f.contentWindow!.postMessage({ type: 'doop:html', html, reqId: 'ref' }, '*')
      })
    }, input.html)
    const frame = (await handle.contentFrame())!
    await frame.evaluate(async (limit) => {
      const settle = (async () => {
        await document.fonts.ready
        await Promise.all(
          [...document.images].map((img) =>
            img.complete
              ? 0
              : new Promise((r) => {
                  img.addEventListener('load', r)
                  img.addEventListener('error', r)
                }),
          ),
        )
        await Promise.all(
          document
            .getAnimations()
            .filter((a) => Number.isFinite(a.effect?.getComputedTiming().endTime))
            .map((a) => a.finished.catch(() => undefined)),
        )
      })()
      await Promise.race([settle, new Promise((r) => setTimeout(r, limit))])
    }, SETTLE_LIMIT_MS)
    const raster = await decode(await handle.screenshot())
    const ref = { visible: changedPixels(raster, empty) > 0, raster, empty }
    cache.set(key, ref)
    return ref
  } finally {
    await page.close()
  }
}
