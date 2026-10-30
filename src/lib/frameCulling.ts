/* A frame iframe costs memory in proportion to its area × DPR² whether or not
   it is on screen (a 2200×5500 frame at DPR 3 is ~430 MiB), and iOS Safari
   kills a tab that holds a few of them. Only frames near the camera get an
   iframe; the rest keep their box and their chrome. */

type Box = { id: string; x: number; y: number; width: number; height: number }

/** How far past the stage edge a frame still mounts, in stage sizes: a pan
 *  reveals a loaded frame, not a blank one. */
const MARGIN = 1

/** Ids of the frames that should hold an iframe: those whose screen rect is
 *  within MARGIN stages of the stage, plus `keep` (the selection). */
export function framesToMount(
  frames: Box[],
  viewport: { x: number; y: number; zoom: number },
  stage: { width: number; height: number },
  keep: ReadonlySet<string>,
): Set<string> {
  if (stage.width <= 0 || stage.height <= 0) return new Set(frames.map((f) => f.id))
  const mx = stage.width * MARGIN
  const my = stage.height * MARGIN
  const mounted = new Set<string>()
  for (const f of frames) {
    const left = f.x * viewport.zoom + viewport.x
    const top = f.y * viewport.zoom + viewport.y
    const near =
      left < stage.width + mx &&
      left + f.width * viewport.zoom > -mx &&
      top < stage.height + my &&
      top + f.height * viewport.zoom > -my
    if (near || keep.has(f.id)) mounted.add(f.id)
  }
  return mounted
}
