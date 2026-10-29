import type { ElementComment } from './types.ts'

/** A comment pinned to a point on the canvas rather than to an element. */
export type CanvasComment = ElementComment & { frameId?: undefined; pageId: string; x: number; y: number }

export function isCanvasComment(c: ElementComment): c is CanvasComment {
  return c.frameId === undefined && c.pageId !== undefined && c.x !== undefined && c.y !== undefined
}

/** Comments kept per canvas, in memory on the server and in the client store; older ones live only in the table. */
export const COMMENT_WINDOW = 100

/** Drop the oldest entries of a newest-first list beyond the window, never those of the thread rooted at `keepRootId`. */
export function trimComments(list: ElementComment[], keepRootId?: string) {
  for (let i = list.length - 1; i >= 0 && list.length > COMMENT_WINDOW; i--) {
    const c = list[i]!
    if (keepRootId && (c.id === keepRootId || c.parentId === keepRootId)) continue
    list.splice(i, 1)
  }
}
