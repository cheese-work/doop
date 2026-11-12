import { createHash } from 'node:crypto'
import { framePageId } from '../shared/pages.ts'
import type { Canvas, Frame, SnapshotFrame } from '../shared/types.ts'

/**
 * Pure helpers for named page snapshots (CHE-5307): what a snapshot records
 * of a frame, which states count as equal, and the diff between two lists of
 * them. No store, no database: `actions.ts` owns the side effects.
 */

/** Thrown for a request the caller can fix (unknown page or snapshot). */
export class SnapshotError extends Error {}

export const hashHtml = (html: string) => createHash('sha256').update(html).digest('hex')

export function stateOf(frame: Frame, deleted: boolean): SnapshotFrame {
  return {
    frameId: frame.id,
    name: frame.name,
    x: frame.x,
    y: frame.y,
    width: frame.width,
    height: frame.height,
    ...(frame.hidden ? { hidden: true } : {}),
    ...(frame.locked ? { locked: true } : {}),
    deleted,
    hash: hashHtml(frame.html),
    htmlBytes: frame.html.length,
  }
}

/** The page as it is now: its live frames plus the frames deleted from it,
 *  with the html by hash (one entry per distinct body). */
export function capturePage(canvas: Canvas, trashed: Frame[], pageId: string) {
  const frames: SnapshotFrame[] = []
  const html = new Map<string, string>()
  const add = (frame: Frame, deleted: boolean) => {
    const state = stateOf(frame, deleted)
    html.set(state.hash, frame.html)
    frames.push(state)
  }
  for (const f of canvas.frames) if (framePageId(canvas, f) === pageId) add(f, false)
  for (const f of trashed) if (framePageId(canvas, f) === pageId) add(f, true)
  return { frames, html }
}

/** Equal for restore and compare: html, size, position, name and visibility.
 *  The lock is not part of it (a restore never sets or clears it). */
export function sameState(a: SnapshotFrame, b: SnapshotFrame): boolean {
  return (
    a.deleted === b.deleted &&
    a.hash === b.hash &&
    a.name === b.name &&
    a.x === b.x &&
    a.y === b.y &&
    a.width === b.width &&
    a.height === b.height &&
    !!a.hidden === !!b.hidden
  )
}

/** Same frames, same every field: what a safety snapshot must still describe
 *  when the restore starts to write. */
export function signature(frames: SnapshotFrame[]): string {
  return JSON.stringify([...frames].sort((a, b) => (a.frameId < b.frameId ? -1 : 1)))
}

const brief = (f: SnapshotFrame) => ({
  name: f.name,
  x: f.x,
  y: f.y,
  width: f.width,
  height: f.height,
  htmlBytes: f.htmlBytes,
})

/** Frames added, removed and changed going from `a` to `b` (deleted frames
 *  count as absent), with sizes. Compares hashes, never loads html. */
export function compareFrames(a: SnapshotFrame[], b: SnapshotFrame[]) {
  const before = new Map(a.filter((f) => !f.deleted).map((f) => [f.frameId, f]))
  const after = new Map(b.filter((f) => !f.deleted).map((f) => [f.frameId, f]))
  const added = [...after.values()]
    .filter((f) => !before.has(f.frameId))
    .map((f) => ({ frameId: f.frameId, ...brief(f) }))
  const removed = [...before.values()]
    .filter((f) => !after.has(f.frameId))
    .map((f) => ({ frameId: f.frameId, ...brief(f) }))
  const changed = []
  let unchanged = 0
  for (const [frameId, was] of before) {
    const now = after.get(frameId)
    if (!now) continue
    if (sameState(was, now)) unchanged++
    else changed.push({ frameId, htmlChanged: was.hash !== now.hash, before: brief(was), after: brief(now) })
  }
  return { added, removed, changed, unchanged }
}
