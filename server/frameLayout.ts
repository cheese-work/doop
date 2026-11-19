/* Frame layout guard (CHE-6119): agent writes may not leave two frames on a page intersecting or closer than
   FRAME_GAP. Runs at the write itself (actions.createFrame relocates, the MCP update_frame refuses), so a person
   never drags a frame away to read what is under it. Hidden frames take no space. */
import type { Frame } from '../shared/types.ts'
import { rotatedBounds } from '../shared/frameRotation.ts'

export const FRAME_GAP = 40 // minimum clear space between frames, in canvas px
export const PLACE_GAP = 80 // clear space left above a frame placed in free space

export interface Box {
  x: number
  y: number
  width: number
  height: number
}

type Placed = Pick<Frame, 'id' | 'name' | 'x' | 'y' | 'width' | 'height' | 'hidden' | 'rotation'>

/** The box a frame covers on screen: its rect turned about its centre by `rotation` (degrees clockwise). */
export function visibleBox(f: Box & { rotation?: number }): Box {
  return f.rotation ? rotatedBounds(f, f.rotation) : { x: f.x, y: f.y, width: f.width, height: f.height }
}

/** Other visible frames whose on-screen box (rotation included) is closer than `gap` to `box`, which is itself
 *  an on-screen box: pass `visibleBox` of a rotated frame. */
export function conflicts<T extends Placed>(box: Box, frames: T[], selfId?: string, gap = FRAME_GAP): T[] {
  return frames.filter((f) => {
    if (f.id === selfId || f.hidden) return false
    const o = visibleBox(f)
    return (
      Math.min(box.x + box.width, o.x + o.width) - Math.max(box.x, o.x) > -gap &&
      Math.min(box.y + box.height, o.y + o.height) - Math.max(box.y, o.y) > -gap
    )
  })
}

/** Free spot for a new frame: the page's left edge, below its lowest visible frame. */
export function freeSpot(frames: Placed[]): { x: number; y: number } {
  const visible = frames.filter((f) => !f.hidden)
  if (!visible.length) return { x: 120, y: 120 }
  const boxes = visible.map(visibleBox)
  return {
    x: Math.min(...boxes.map((b) => b.x)),
    y: Math.max(...boxes.map((b) => b.y + b.height)) + PLACE_GAP,
  }
}

/** Where the store puts a frame with no x/y: right of the right-most frame, or the page origin when empty. */
export function defaultSpot(frames: Pick<Frame, 'x' | 'y' | 'width' | 'height' | 'rotation'>[]): {
  x: number
  y: number
} {
  const rightmost = frames.reduce((mx, f) => Math.max(mx, f.x + f.width), 0)
  return { x: frames.length ? rightmost + 80 : 120, y: 120 }
}
