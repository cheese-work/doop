import type { ElementComment } from '../../shared/types'

export interface ChatLine {
  id: string
  from: string
  text: string
  at: number
  /** the watcher's `[dsg:<tag>]` marker on a reply */
  tag?: string
}

/** Tags the watcher puts on a reply that reports a failure instead of an answer. */
export const FAILURE_TAGS = ['issue_not_linked'] as const

const MARKER = /^\[dsg:([^\]]*)\]\s*/

/** The conversation with one agent: canvas comments that start with `@<ref>`
 *  (a handle that merely begins with the same letters does not count) and the
 *  replies under them, oldest first, markers and the leading mention removed. */
export function chatThread(comments: ElementComment[], agentRef: string): ChatLine[] {
  const mention = new RegExp(`^@${agentRef.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])\\s*`, 'i')
  const roots = new Map<string, ChatLine>()
  for (const c of comments) {
    if (c.parentId || c.frameId || !mention.test(c.text)) continue
    roots.set(c.id, { id: c.id, from: c.from, text: c.text.replace(mention, ''), at: c.at })
  }
  const lines = [...roots.values()]
  for (const c of comments) {
    if (!c.parentId || !roots.has(c.parentId)) continue
    const tag = MARKER.exec(c.text)?.[1]
    lines.push({ id: c.id, from: c.from, text: c.text.replace(MARKER, ''), at: c.at, ...(tag ? { tag } : {}) })
  }
  return lines.sort((a, b) => a.at - b.at)
}
