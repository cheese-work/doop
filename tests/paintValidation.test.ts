import { existsSync } from 'node:fs'
import { chromium, type Browser } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  changedPixels,
  completeness,
  downscale,
  methodBHeadline,
  solid,
  validateScreencast,
  type FrameObservation,
  type Raster,
  type ScreencastFrame,
} from '../scripts/perf/paintValidation.ts'
import { renderReference } from '../scripts/perf/referenceRender.ts'

/* CHE-6954 (CHE-6942 step 4): the reference render that decides `visible`, the completeness
   rule (empty / stalled / blank / unchecked) and the screencast window rules V0-V2. Controls
   C1-b, C1-c (reference part), C1-d, C1-f, C1-g follow the plan's table. */

const WHITE: [number, number, number] = [255, 255, 255]
const obs = (o: Partial<FrameObservation> & { id: string }): FrameObservation => ({
  visible: true,
  signalMs: 100,
  inViewport: true,
  nRef: 50,
  nApp: 50,
  ...o,
})

/** a w x h raster of `fill` with a `size` square of `ink` at (x, y) */
function withSquare(
  w: number,
  h: number,
  fill: [number, number, number],
  ink: [number, number, number],
  x: number,
  y: number,
  size: number,
): Raster {
  const r = solid(w, h, fill)
  for (let j = y; j < y + size; j++) for (let i = x; i < x + size; i++) r.data.set([...ink, 255], (j * w + i) * 4)
  return r
}

const chromiumPresent = existsSync(chromium.executablePath())

describe.skipIf(!chromiumPresent)('reference render (real FRAME_BOOTSTRAP, real Chromium)', () => {
  let browser: Browser
  beforeAll(async () => {
    browser = await chromium.launch()
  })
  afterAll(async () => {
    await browser?.close()
  })

  it('C1-b: <p>Content</p> in a 280x180 frame is detected as changed', async () => {
    const ref = await renderReference(browser, { html: '<p>Content</p>', width: 280, height: 180 })
    expect(ref.visible).toBe(true)
    expect(changedPixels(ref.raster, ref.empty)).toBeGreaterThan(0)
    expect([ref.raster.width, ref.raster.height]).toEqual([280, 180])
  })

  it('C1-c (reference part): <body></body> gives visible = false, listed in emptyFrames, run stays complete', async () => {
    const ref = await renderReference(browser, { html: '<body></body>', width: 280, height: 180 })
    expect(ref.visible).toBe(false)
    const c = completeness([obs({ id: 'empty-1', visible: ref.visible, signalMs: null, nRef: 0, nApp: 0 })])
    expect(c.emptyFrames).toEqual(['empty-1'])
    expect(c.complete).toBe(true)
  })

  it('caches by the SHA256 of the frame HTML (and size): the second call reuses the render', async () => {
    const cache = new Map()
    const a = await renderReference(browser, { html: '<p>same</p>', width: 100, height: 60 }, cache)
    const b = await renderReference(browser, { html: '<p>same</p>', width: 100, height: 60 }, cache)
    expect(b).toBe(a)
    expect(cache.size).toBe(1)
  })
})

describe('pixel helpers', () => {
  it('counts a pixel as changed only when a channel differs by more than 16', () => {
    const a = solid(4, 1, [100, 100, 100])
    const b = solid(4, 1, [100, 100, 100])
    b.data.set([116, 100, 100, 255], 0) // diff 16: not changed
    b.data.set([100, 117, 100, 255], 4) // diff 17: changed
    b.data.set([100, 100, 83, 255], 8) // diff 17 the other way: changed
    expect(changedPixels(a, b)).toBe(2)
  })
  it('counts only inside the region', () => {
    const a = solid(10, 10, WHITE)
    const b = withSquare(10, 10, WHITE, [0, 0, 0], 0, 0, 2)
    expect(changedPixels(a, b)).toBe(4)
    expect(changedPixels(a, b, { x: 2, y: 2, w: 8, h: 8 })).toBe(0)
  })
  it('downscale averages the area (2x2 black block in white at z = 0.5 gives mid grey)', () => {
    const r = withSquare(4, 4, WHITE, [0, 0, 0], 0, 0, 2)
    const d = downscale(r, 0.5)
    expect([d.width, d.height]).toEqual([2, 2])
    expect([...d.data.slice(0, 4)]).toEqual([0, 0, 0, 255])
    expect([...d.data.slice(4, 8)]).toEqual([255, 255, 255, 255])
  })
})

describe('completeness phase', () => {
  it('C1-d: visible content whose doop:html is never delivered is stalled; viewportPaintMs is null; run incomplete', () => {
    const c = completeness([obs({ id: 'a' }), obs({ id: 'stuck', signalMs: null, nApp: 0 })])
    expect(c.stalledFrames).toEqual(['stuck'])
    expect(c.viewportPaintMs).toBeNull()
    expect(c.complete).toBe(false)
  })

  it('C1-g (rule, synthetic pixels): near-white placeholder with the content withheld is blank, run incomplete', () => {
    const fill: [number, number, number] = [255, 255, 255] // iframe is bg-white
    const ref = withSquare(40, 40, [252, 252, 252], [0, 0, 0], 10, 10, 6) // #fcfcfc body + text
    const app = solid(40, 40, [252, 252, 252]) // delivered: #fcfcfc body, no content
    const nRef = changedPixels(ref, solid(40, 40, fill))
    const nApp = changedPixels(app, solid(40, 40, fill))
    expect(nRef).toBeGreaterThan(0)
    expect(nApp).toBe(0) // #fcfcfc differs from white by 3, under the 16 rule
    const c = completeness([obs({ id: 'g', signalMs: 120, nRef, nApp })]) // first-paint arrived
    expect(c.blankFrames).toEqual(['g'])
    expect(c.stalledFrames).toEqual([])
    expect(c.complete).toBe(false)
    expect(c.viewportPaintMs).toBeNull()
  })

  it('an unchecked frame (Nref = 0 at zoom z) is listed and makes the run incomplete', () => {
    const c = completeness([obs({ id: 'tiny', nRef: 0, nApp: 0 })])
    expect(c.uncheckedFrames).toEqual(['tiny'])
    expect(c.complete).toBe(false)
  })

  it('a complete run reports viewportPaintMs as the latest viewport signal; off-viewport frames do not count', () => {
    const c = completeness([
      obs({ id: 'a', signalMs: 300 }),
      obs({ id: 'b', signalMs: 120 }),
      obs({ id: 'far', signalMs: 900, inViewport: false }),
    ])
    expect(c).toMatchObject({ complete: true, viewportPaintMs: 300, emptyFrames: [], blankFrames: [] })
  })
})

describe('screencast windows (V0, V1, V2)', () => {
  const W = 60
  const H = 40
  /** a frame every 16 ms; box A (x 10..30, y 10..30) turns black at paintAt, nothing else changes */
  function cast(paintAt: number, until = 160): ScreencastFrame[] {
    const out: ScreencastFrame[] = []
    for (let t = 0; t <= until; t += 16) {
      out.push({ t, raster: t >= paintAt ? withSquare(W, H, WHITE, [0, 0, 0], 10, 10, 20) : solid(W, H, WHITE) })
    }
    return out
  }
  const box = { id: 'A', x: 8, y: 8, w: 24, h: 24 }
  const complete = completeness([obs({ id: 'A' })])

  it('passes when the signal lies in the window of its box and the headline matches', () => {
    // first painted frame t = 96, last no-paint frame t = 80
    const r = validateScreencast({
      frames: cast(96),
      boxes: [{ ...box, signalMs: 90 }],
      headlineMs: 90,
      completeness: complete,
    })
    expect(r.status).toBe('pass')
  })

  it('C1-f: a signal 500 ms before the first visible change fails V2 and names the frame', () => {
    const r = validateScreencast({
      frames: cast(600, 700),
      boxes: [{ ...box, signalMs: 100 }],
      headlineMs: 100,
      completeness: complete,
    })
    expect(r.status).toBe('fail')
    const v2 = r.failures.find((f) => f.check === 'V2')
    expect(v2?.frameId).toBe('A')
    expect(r.failures.some((f) => f.check === 'V1')).toBe(true)
  })

  it('a signal up to 17 ms after the first painted frame passes; 18 ms fails', () => {
    const base = { frames: cast(96), headlineMs: 0, completeness: complete }
    expect(validateScreencast({ ...base, headlineMs: 113, boxes: [{ ...box, signalMs: 113 }] }).status).toBe('pass')
    expect(validateScreencast({ ...base, headlineMs: 114, boxes: [{ ...box, signalMs: 114 }] }).status).toBe('fail')
  })

  it('a window wider than 100 ms is inconclusive', () => {
    const frames = cast(1000, 0).concat(cast(400, 400).slice(-1)) // frames at t = 0 and t = 400 only
    const r = validateScreencast({
      frames,
      boxes: [{ ...box, signalMs: 200 }],
      headlineMs: 200,
      completeness: complete,
    })
    expect(r.status).toBe('inconclusive')
  })

  it('V0: an incomplete run fails before V1 and V2 are evaluated', () => {
    const bad = completeness([obs({ id: 'A', signalMs: null })])
    const r = validateScreencast({
      frames: cast(96),
      boxes: [{ ...box, signalMs: 90 }],
      headlineMs: 90,
      completeness: bad,
    })
    expect(r.status).toBe('fail')
    expect(r.failures.map((f) => f.check)).toEqual(['V0'])
  })

  it('a box whose last frame shows no change (N = 0) is not sampled', () => {
    const r = validateScreencast({
      frames: cast(96),
      boxes: [
        { ...box, signalMs: 90 },
        { id: 'quiet', x: 40, y: 5, w: 14, h: 14, signalMs: 5 },
      ],
      headlineMs: 90,
      completeness: complete,
    })
    expect(r.status).toBe('pass')
    expect(r.sampled).toEqual(['A'])
  })

  it('method B: the headline is the first screencast frame in which a sampled box painted; null when incomplete', () => {
    expect(methodBHeadline({ frames: cast(96), boxes: [{ ...box, signalMs: 0 }], completeness: complete })).toBe(96)
    const bad = completeness([obs({ id: 'A', nApp: 0 })])
    expect(methodBHeadline({ frames: cast(96), boxes: [{ ...box, signalMs: 0 }], completeness: bad })).toBeNull()
  })
})
