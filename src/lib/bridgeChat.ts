import type { ElementComment } from '../../shared/types'

export interface ChatLine {
  id: string
  from: string
  text: string
  at: number
  /** the watcher's `[dsg:<tag>]` marker on a reply */
  tag?: string
}

/** The watcher's failure replies carry `nolink:<comment-id>` (no issue linked) or
 *  `noitem:<comment-id>` (a mention that is not a Multica agent); an answer carries an item ref. */
export type ChatFailure = 'nolink' | 'noitem'

export function failureOf(tag: string | undefined): ChatFailure | null {
  const kind = tag?.split(':', 1)[0]
  return kind === 'nolink' || kind === 'noitem' ? kind : null
}

/** The watcher routes `@<name>` for names of letters, digits, `_` and `-`; any other name has no handle. */
export function agentHandle(name: string | null): string | null {
  return name && /^[A-Za-z0-9][\w-]*$/.test(name) ? name : null
}

const MARKER = /^\[dsg:([^\]]*)\]\s*/

/** The conversation with one agent: canvas comments that start with `@<handle>`
 *  (a handle that merely begins with the same letters does not count) and the
 *  replies under them, oldest first, markers and the leading mention removed. */
export function chatThread(comments: ElementComment[], handle: string): ChatLine[] {
  const mention = new RegExp(`^@${handle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])\\s*`, 'i')
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
