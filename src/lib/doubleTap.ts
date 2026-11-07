export type Tap = { t: number; x: number; y: number }

const MAX_MS = 300
const MAX_PX = 24

/* two touch taps close enough in time and space to count as a double-tap */
export function isDoubleTap(prev: Tap | null, next: Tap): boolean {
  return !!prev && next.t - prev.t <= MAX_MS && Math.hypot(next.x - prev.x, next.y - prev.y) <= MAX_PX
}

/* Turns raw touch pointer events into "was that release the second tap of a
   double-tap?". A tap is a completed, stationary, single-finger press on empty
   canvas; a pan (moved), a pinch (another finger), a cancel or a long press
   all break it, so they fall through to their own handlers. */
export function createTapDetector() {
  let press: (Tap & { id: number; ok: boolean }) | null = null
  let last: Tap | null = null
  return {
    /** every touch pointer-down; `eligible` = empty canvas under a tool that taps */
    down(id: number, t: number, x: number, y: number, eligible: boolean) {
      if (press) press.ok = false
      else if (eligible) press = { id, t, x, y, ok: true }
      else last = null
    },
    move(id: number, x: number, y: number) {
      if (press?.id === id && Math.hypot(x - press.x, y - press.y) > MAX_PX) press.ok = false
    },
    /** true when this release completes a double-tap */
    up(id: number, t: number, x: number, y: number): boolean {
      if (press?.id !== id) return false
      const p = press
      press = null
      const tap = { t, x, y }
      if (!p.ok || t - p.t > MAX_MS || Math.hypot(x - p.x, y - p.y) > MAX_PX) {
        last = null
        return false
      }
      const double = isDoubleTap(last, tap)
      last = double ? null : tap
      return double
    },
    cancel() {
      press = null
      last = null
    },
  }
}
