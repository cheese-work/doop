import { multicaWebBase } from '../../shared/multica'
import type { CommentResolution } from '../../shared/types'
import { MAX_RESOLUTION_NOTE, MAX_RESOLUTION_REF } from '../../shared/comments'
import type { CommentThreadGroup } from './comments'

/* U4 comment resolution (CHE-9308 step 8): the pure half of the Comments tab
   of design A4. */

export const RESOLVE_REASONS: readonly CommentResolution[] = ['addressed', 'wont_fix', 'moved']

/** The body `POST /api/comments/:id/resolve` takes (`parseResolveBody`). */
export type ResolveBody = { reason: CommentResolution; ref?: string; note?: string }

/** What the dialog's one-line field may hold, per reason. */
export const RESOLVE_MAX: Record<CommentResolution, number> = {
  addressed: MAX_RESOLUTION_REF,
  moved: MAX_RESOLUTION_REF,
  wont_fix: MAX_RESOLUTION_NOTE,
}

/** The body for a reason and what was typed; null while the field is empty,
 *  since every reason needs one (a ref, or for Won't fix a note). */
export function resolveBody(reason: CommentResolution, typed: string): ResolveBody | null {
  const text = typed.trim()
  if (!text) return null
  return reason === 'wont_fix' ? { reason, note: text } : { reason, ref: text }
}

/** What a thread waits on: a question put to Multica. The designer's reply
 *  `q:<event id>` says "Moved to Multica: <issue key>"; the answer comes back as
 *  a reply `a:<same event id>` and clears the wait. Null when the thread is
 *  resolved or no question is unanswered. `issueKey` is null when the reply
 *  names no issue. */
export function waitsOn(thread: Pick<CommentThreadGroup, 'root' | 'replies'>): { issueKey: string | null } | null {
  if (thread.root.resolvedAt) return null
  const answered = new Set<string>()
  for (const reply of thread.replies) {
    const key = reply.clientRequestId
    if (key?.startsWith('a:')) answered.add(key.slice(2))
  }
  for (let i = thread.replies.length - 1; i >= 0; i--) {
    const reply = thread.replies[i]!
    const key = reply.clientRequestId
    if (!key?.startsWith('q:') || answered.has(key.slice(2))) continue
    return { issueKey: /Moved to Multica:\s*([A-Z][A-Z0-9]*-\d+)/.exec(reply.text)?.[1] ?? null }
  }
  return null
}

export interface ReviewSummary {
  resolved: number
  addressed: number
  wontFix: number
  moved: number
  open: number
  waiting: number
}

/** What moved since the reviewer last marked the canvas reviewed: threads
 *  resolved after `since`, and the threads still open now. */
export function reviewSummary(threads: CommentThreadGroup[], since: number): ReviewSummary {
  const sum: ReviewSummary = { resolved: 0, addressed: 0, wontFix: 0, moved: 0, open: 0, waiting: 0 }
  for (const thread of threads) {
    const { resolvedAt, resolution } = thread.root
    if (!resolvedAt) {
      sum.open += 1
      if (waitsOn(thread)) sum.waiting += 1
    } else if (resolvedAt > since) {
      sum.resolved += 1
      if (resolution === 'addressed') sum.addressed += 1
      else if (resolution === 'wont_fix') sum.wontFix += 1
      else if (resolution === 'moved') sum.moved += 1
    }
  }
  return sum
}

/* The anchor is this browser's: one time per user and canvas, set by "Mark
   reviewed". Storage may be blocked or full; then there is no anchor. */
const anchorKey = (userId: string, canvasId: string) => `doop:reviewed:${userId}:${canvasId}`

export function readReviewAnchor(userId: string, canvasId: string): number {
  try {
    const value = Number(localStorage.getItem(anchorKey(userId, canvasId)))
    return Number.isFinite(value) && value > 0 ? value : 0
  } catch {
    return 0
  }
}

export function writeReviewAnchor(userId: string, canvasId: string, at: number): void {
  try {
    localStorage.setItem(anchorKey(userId, canvasId), String(at))
  } catch {
    /* no storage: the summary counts everything next time */
  }
}

/** A link to a Multica issue, when the server knows the workspace's web URL
 *  (`Me.multicaWebUrl`, from `MULTICA_WEB_URL`); otherwise null and the key is plain text. */
export function multicaIssueUrl(webUrl: string | undefined, key: string): string | null {
  const base = multicaWebBase(webUrl)
  return base ? `${base}/issues/${encodeURIComponent(key)}` : null
}
