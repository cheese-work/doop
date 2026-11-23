/* A frame iframe costs memory in proportion to its area × DPR² whether or not
   it is on screen (a 2200×5500 frame at DPR 3 is ~430 MiB), and iOS Safari
   kills a tab that holds a few of them. Only frames near the camera, big
   enough on screen to read, and among the nearest few get an iframe; the rest
   keep their box and show the stored preview image. */

type Box = { id: string; x: number; y: number; width: number; height: number }

/** How far past the stage edge a frame still mounts, in stage sizes: a pan
 *  reveals a loaded frame, not a blank one. */
const MARGIN = 1

/** A frame narrower than this on screen (px) is not readable live: it shows its preview. */
export const MIN_LIVE_WIDTH = 160

/** At most this many frames hold an iframe at once, nearest the stage centre first.
 *  The selection is extra: it always keeps its iframe. */
export const MAX_LIVE_FRAMES = 24

/** Ids of the frames that should hold an iframe: those whose screen rect is
 *  within MARGIN stages of the stage and at least MIN_LIVE_WIDTH wide, the
 *  MAX_LIVE_FRAMES nearest the stage centre, plus `keep` (the selection). */
export function framesToMount(
  frames: Box[],
  viewport: { x: number; y: number; zoom: number },
  stage: { width: number; height: number },
  keep: ReadonlySet<string>,
): Set<string> {
  if (stage.width <= 0 || stage.height <= 0) return new Set(frames.map((f) => f.id))
  const mx = stage.width * MARGIN
  const my = stage.height * MARGIN
  const cx = stage.width / 2
  const cy = stage.height / 2
  const candidates: { id: string; dist: number }[] = []
  const mounted = new Set<string>()
  for (const f of frames) {
    const left = f.x * viewport.zoom + viewport.x
    const top = f.y * viewport.zoom + viewport.y
    const near =
      left < stage.width + mx &&
      left + f.width * viewport.zoom > -mx &&
      top < stage.height + my &&
      top + f.height * viewport.zoom > -my
    if (keep.has(f.id)) mounted.add(f.id)
    else if (near && f.width * viewport.zoom >= MIN_LIVE_WIDTH) {
      const dx = left + (f.width * viewport.zoom) / 2 - cx
      const dy = top + (f.height * viewport.zoom) / 2 - cy
      candidates.push({ id: f.id, dist: dx * dx + dy * dy })
    }
  }
  candidates.sort((a, b) => a.dist - b.dist)
  for (const c of candidates.slice(0, MAX_LIVE_FRAMES)) mounted.add(c.id)
  return mounted
}
