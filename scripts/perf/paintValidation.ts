/* Paint validation rules for the doop first-frame metric (CHE-6942 plan r4, contract C1; CHE-6954).
 *
 * Pure functions on RGBA rasters and plain numbers, so the rules are testable without a browser.
 * No script uses them yet: step 5 wires them into the measure scripts. Times are ms on one
 * clock (from navigation start); the caller converts CDP screencast timestamps and frame
 * paint signals to that clock before it calls in.
 *
 * Completeness phase: classify each frame as empty / stalled / blank / unchecked, decided
 * before any validation sampling. Validation: screencast windows V0 (completeness), V1
 * (headline) and V2 (per frame). Method B: the headline is the first screencast frame in
 * which a sampled box painted. */

export interface Raster {
  width: number
  height: number
  /** RGBA, row-major */
  data: Uint8Array | Uint8ClampedArray
}
export interface Region {
  x: number
  y: number
  w: number
  h: number
}

/** a pixel is changed when any channel differs by more than this (of 255) */
export const CHANGE_THRESHOLD = 16
/** a screencast box is inset by this many px, so edges and borders do not count */
export const BOX_INSET = 2
/** a box has painted at min(this, N) changed pixels */
export const PAINTED_PIXELS = 10
/** V1/V2: the signal may lie this long (one display frame) after the first painted frame */
export const DISPLAY_FRAME_MS = 17
/** a window wider than this is inconclusive */
export const MAX_WINDOW_MS = 100
/** `validateWithRepeats` makes at most this many attempts */
export const MAX_ATTEMPTS = 3

export function solid(width: number, height: number, rgb: [number, number, number]): Raster {
  const data = new Uint8Array(width * height * 4)
  for (let i = 0; i < width * height; i++) data.set([rgb[0], rgb[1], rgb[2], 255], i * 4)
  return { width, height, data }
}

/** pixels in `region` (default: all) where any channel of `a` and `b` differs by more than 16 */
export function changedPixels(a: Raster, b: Raster, region?: Region): number {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(`raster size mismatch: ${a.width}x${a.height} vs ${b.width}x${b.height}`)
  }
  const x0 = Math.max(0, region?.x ?? 0)
  const y0 = Math.max(0, region?.y ?? 0)
  const x1 = Math.min(a.width, region ? region.x + region.w : a.width)
  const y1 = Math.min(a.height, region ? region.y + region.h : a.height)
  let n = 0
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * a.width + x) * 4
      for (let c = 0; c < 4; c++) {
        if (Math.abs(a.data[i + c]! - b.data[i + c]!) > CHANGE_THRESHOLD) {
          n++
          break
        }
      }
    }
  }
  return n
}

/** area-average downscale to zoom z (z >= 1 returns the raster as is: the completeness phase caps zoom at 100%) */
export function downscale(r: Raster, z: number): Raster {
  if (z >= 1) return r
  const w = Math.max(1, Math.round(r.width * z))
  const h = Math.max(1, Math.round(r.height * z))
  const sx = r.width / w
  const sy = r.height / h
  const data = new Uint8Array(w * h * 4)
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      const sum = [0, 0, 0, 0]
      let weight = 0
      for (let y = Math.floor(dy * sy); y < Math.min(r.height, Math.ceil((dy + 1) * sy)); y++) {
        const wy = Math.min((dy + 1) * sy, y + 1) - Math.max(dy * sy, y)
        for (let x = Math.floor(dx * sx); x < Math.min(r.width, Math.ceil((dx + 1) * sx)); x++) {
          const wt = wy * (Math.min((dx + 1) * sx, x + 1) - Math.max(dx * sx, x))
          for (let c = 0; c < 4; c++) sum[c]! += r.data[(y * r.width + x) * 4 + c]! * wt
          weight += wt
        }
      }
      for (let c = 0; c < 4; c++) data[(dy * w + dx) * 4 + c] = Math.round(sum[c]! / weight)
    }
  }
  return { width: w, height: h, data }
}

/* ---------- completeness phase ---------- */

export interface FrameObservation {
  id: string
  /** reference render: at least one pixel changed (referenceRender.ts) */
  visible: boolean
  /** time of the frame paint signal; null when none arrived by the end of the run */
  signalMs: number | null
  /** the frame box intersects the visible stage in the load view (no culling margin) */
  inViewport: boolean
  /** changed pixels of the reference after the downscale to zoom z, against the empty fill */
  nRef: number
  /** changed pixels of the app screenshot of the frame box against the empty fill */
  nApp: number
}

export interface Completeness {
  complete: boolean
  emptyFrames: string[]
  stalledFrames: string[]
  blankFrames: string[]
  uncheckedFrames: string[]
  /** every visible viewport frame has a paint signal: the latest one; null if the run is incomplete */
  viewportPaintMs: number | null
}

/** One class per frame, first match wins: empty (not visible, excluded), stalled (visible, no
 *  signal), blank (visible, Nref >= 1, Napp = 0, even with a signal), unchecked (visible,
 *  Nref = 0). A stalled, blank or unchecked frame makes the run incomplete. */
export function completeness(frames: FrameObservation[]): Completeness {
  const out: Completeness = {
    complete: true,
    emptyFrames: [],
    stalledFrames: [],
    blankFrames: [],
    uncheckedFrames: [],
    viewportPaintMs: null,
  }
  for (const f of frames) {
    if (!f.visible) out.emptyFrames.push(f.id)
    else if (f.signalMs === null) out.stalledFrames.push(f.id)
    else if (f.nRef >= 1 && f.nApp === 0) out.blankFrames.push(f.id)
    else if (f.nRef === 0) out.uncheckedFrames.push(f.id)
  }
  out.complete = !(out.stalledFrames.length || out.blankFrames.length || out.uncheckedFrames.length)
  if (out.complete) {
    const t = frames.filter((f) => f.visible && f.inViewport).map((f) => f.signalMs!)
    out.viewportPaintMs = t.length ? Math.max(...t) : null
  }
  return out
}

/* ---------- screencast windows ---------- */

export interface ScreencastFrame {
  t: number
  raster: Raster
}
export interface Box extends Region {
  id: string
  /** this frame's paint signal */
  signalMs: number | null
}
export interface ValidationInput {
  /** screencast frames in time order, the first one taken after the iframes mounted */
  frames: ScreencastFrame[]
  boxes: Box[]
  headlineMs: number
  completeness: Completeness
}
export interface ValidationResult {
  status: 'pass' | 'fail' | 'inconclusive'
  failures: { check: 'V0' | 'V1' | 'V2'; frameId?: string; reason: string }[]
  /** ids of the boxes that were sampled */
  sampled: string[]
}

interface Sampled {
  id: string
  signalMs: number | null
  /** index of the first screencast frame in which the box had painted (>= 1) */
  paintedAt: number
}

/** boxes with N >= 1 changed pixels in the last frame (against the first), and when each painted */
function sample(frames: ScreencastFrame[], boxes: Box[]): Sampled[] {
  if (frames.length < 2) return []
  const empty = frames[0]!.raster
  const last = frames[frames.length - 1]!.raster
  const out: Sampled[] = []
  for (const b of boxes) {
    const r = { x: b.x + BOX_INSET, y: b.y + BOX_INSET, w: b.w - 2 * BOX_INSET, h: b.h - 2 * BOX_INSET }
    if (r.w < 1 || r.h < 1) continue
    const n = changedPixels(last, empty, r)
    if (n < 1) continue
    const need = Math.min(PAINTED_PIXELS, n)
    const k = frames.findIndex((f) => changedPixels(f.raster, empty, r) >= need)
    out.push({ id: b.id, signalMs: b.signalMs, paintedAt: k })
  }
  return out
}

/** V0, then V1 (headline) and V2 (per frame): the signal lies after the last frame before the
 *  box painted and at most 17 ms after the first frame in which it had. A window wider than
 *  100 ms is inconclusive. */
export function validateScreencast(i: ValidationInput): ValidationResult {
  if (!i.completeness.complete) {
    const c = i.completeness
    const ids = [...c.stalledFrames, ...c.blankFrames, ...c.uncheckedFrames]
    return { status: 'fail', failures: [{ check: 'V0', reason: `run incomplete: ${ids.join(', ')}` }], sampled: [] }
  }
  const boxes = sample(i.frames, i.boxes)
  const sampled = boxes.map((b) => b.id)
  if (!boxes.length) {
    return {
      status: 'fail',
      failures: [{ check: 'V1', reason: 'no sampled box: nothing to validate against' }],
      sampled,
    }
  }
  const failures: ValidationResult['failures'] = []
  let wide = false
  const check = (name: 'V1' | 'V2', signal: number | null, k: number, frameId?: string) => {
    const after = i.frames[k - 1]!.t
    const until = i.frames[k]!.t
    if (until - after > MAX_WINDOW_MS) {
      wide = true
      return
    }
    if (signal === null || !(signal > after && signal <= until + DISPLAY_FRAME_MS)) {
      failures.push({
        check: name,
        frameId,
        reason: `signal ${signal} outside (${after}, ${until + DISPLAY_FRAME_MS}]`,
      })
    }
  }
  check('V1', i.headlineMs, Math.min(...boxes.map((b) => b.paintedAt)))
  for (const b of boxes) check('V2', b.signalMs, b.paintedAt, b.id)
  return { status: failures.length ? 'fail' : wide ? 'inconclusive' : 'pass', failures, sampled }
}

/** Method B: the headline is the first screencast frame in which a sampled box painted; null
 *  when the run is incomplete (same completeness phase) or no box can be sampled. */
export function methodBHeadline(i: Omit<ValidationInput, 'headlineMs'>): number | null {
  if (!i.completeness.complete) return null
  const boxes = sample(i.frames, i.boxes)
  return boxes.length ? i.frames[Math.min(...boxes.map((b) => b.paintedAt))]!.t : null
}

/** Runs `attempt` until its result is not inconclusive, at most 3 attempts. */
export async function validateWithRepeats(attempt: () => Promise<ValidationResult>): Promise<ValidationResult> {
  let r = await attempt()
  for (let n = 1; n < MAX_ATTEMPTS && r.status === 'inconclusive'; n++) r = await attempt()
  return r
}
