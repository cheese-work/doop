export type Tap = { t: number; x: number; y: number }

const MAX_MS = 300
const MAX_PX = 24

/* two touch taps close enough in time and space to count as a double-tap */
export function isDoubleTap(prev: Tap | null, next: Tap): boolean {
  return !!prev && next.t - prev.t <= MAX_MS && Math.hypot(next.x - prev.x, next.y - prev.y) <= MAX_PX
}
