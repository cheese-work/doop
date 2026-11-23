/* Frame layout guard (CHE-6119): agent writes may not leave two frames on a page intersecting or closer than
   FRAME_GAP. Runs at the write itself (actions.createFrame relocates, the MCP update_frame refuses), so a person
   never drags a frame away to read what is under it. Hidden frames take no space. */
import type { Frame } from '../shared/types.ts'

export const FRAME_GAP = 40 // minimum clear space between frames, in canvas px
export const PLACE_GAP = 80 // clear space left above a frame placed in free space

export interface Box {
  x: number
  y: number
  width: number
  height: number
}

type Placed = Pick<Frame, 'id' | 'name' | 'x' | 'y' | 'width' | 'height' | 'hidden'>

/** Other visible frames whose box is closer than `gap` to `box`. */
export function conflicts<T extends Placed>(box: Box, frames: T[], selfId?: string, gap = FRAME_GAP): T[] {
  return frames.filter(
    (f) =>
      f.id !== selfId &&
      !f.hidden &&
      Math.min(box.x + box.width, f.x + f.width) - Math.max(box.x, f.x) > -gap &&
      Math.min(box.y + box.height, f.y + f.height) - Math.max(box.y, f.y) > -gap,
  )
}

/** Free spot for a new frame: the page's left edge, below its lowest visible frame. */
export function freeSpot(frames: Placed[]): { x: number; y: number } {
  const visible = frames.filter((f) => !f.hidden)
  if (!visible.length) return { x: 120, y: 120 }
  return {
    x: Math.min(...visible.map((f) => f.x)),
    y: Math.max(...visible.map((f) => f.y + f.height)) + PLACE_GAP,
  }
}

/** Where the store puts a frame with no x/y: right of the right-most frame, or the page origin when empty. */
export function defaultSpot(frames: Pick<Frame, 'x' | 'width'>[]): { x: number; y: number } {
  const rightmost = frames.reduce((mx, f) => Math.max(mx, f.x + f.width), 0)
  return { x: frames.length ? rightmost + 80 : 120, y: 120 }
}
