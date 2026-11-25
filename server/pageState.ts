import { canvasPages, framePageId } from '../shared/pages.ts'
import type { Canvas, Frame } from '../shared/types.ts'
import { PolicyRefused } from './policyRefused.ts'

/**
 * Page state the write path reads (CHE-9398 L3). A Finished page (`CanvasPageInfo.finished`) is frozen:
 * no frame is made, changed, moved in or out, or deleted on it, and nothing restores onto it, until it
 * is restored as a page. Locking a frame stays open, so the lifecycle can still lock what it finished.
 */

/** A write on a Finished page. Not a lock: REST answers 409 `page_finished`, not 423. */
export class PageFinishedError extends PolicyRefused {
  constructor(op: string, pageName: string) {
    super(op, `page “${pageName}” is Finished. Restore the page first.`, 'page_finished')
  }
}

/** Throws `PageFinishedError` for the first of `pageIds` that is Finished on `canvas`. */
export function assertPagesOpen(canvas: Canvas, pageIds: readonly string[], op = 'update_frame'): void {
  const pages = canvasPages(canvas)
  for (const pageId of pageIds) {
    const page = pages.find((candidate) => candidate.id === pageId)
    if (page?.finished) throw new PageFinishedError(op, page.name)
  }
}

/** The frame sits on a Finished page. System writers (token restyle, propagation, stamps, heal) skip it
 *  or refuse before they reach the store; the store rule stays the backstop (CHE-9398 L4). */
export function isFrameFinished(canvas: Canvas, frame: Frame): boolean {
  const pageId = framePageId(canvas, frame)
  return !!canvasPages(canvas).find((page) => page.id === pageId)?.finished
}

/** The page a Finished frame sits on, for the refusal text. */
function finishedPageName(canvas: Canvas, frame: Frame): string {
  const pageId = framePageId(canvas, frame)
  return canvasPages(canvas).find((page) => page.id === pageId)?.name ?? pageId
}

/** Refuses with `PageFinishedError` naming the frame's page. */
export function refuseFinishedFrame(canvas: Canvas, frame: Frame, op = 'update_frame'): never {
  throw new PageFinishedError(op, finishedPageName(canvas, frame))
}

/** Ops the freeze covers: frame writes, and a landing (its `pageIds` is the destination). `lock_frame` and `unlock_frame` stay open. */
const FROZEN_OPS: ReadonlySet<string> = new Set(['create_frame', 'update_frame', 'delete_frame', 'land_proposal'])

/**
 * The page rule of `assertWritable`, run right after the lock rules and for every context. `lockOnly`
 * (set by `store.updateFrame` when the patch is nothing but `locked: true` on an unlocked frame) is the
 * one write a Finished page lets through; the binding and recon checks still run after it.
 */
export function assertPageRules(op: string, target: { canvas: Canvas; pageIds?: string[]; lockOnly?: boolean }): void {
  if (!FROZEN_OPS.has(op)) return
  if (op === 'update_frame' && target.lockOnly) return
  assertPagesOpen(target.canvas, target.pageIds ?? [], op)
}

/* Snapshot restores in flight, per page: a counter, so two overlapping restores of one page stay counted. */
const restores = new Map<string, number>()
const restoreKey = (canvasId: string, pageId: string) => `${canvasId}\u0000${pageId}`

export function beginRestore(canvasId: string, pageId: string): void {
  const key = restoreKey(canvasId, pageId)
  restores.set(key, (restores.get(key) ?? 0) + 1)
}

export function endRestore(canvasId: string, pageId: string): void {
  const key = restoreKey(canvasId, pageId)
  const left = (restores.get(key) ?? 0) - 1
  if (left > 0) restores.set(key, left)
  else restores.delete(key)
}

/** A snapshot restore is writing (or about to write) this page. */
export function restoring(canvasId: string, pageId: string): boolean {
  return (restores.get(restoreKey(canvasId, pageId)) ?? 0) > 0
}
