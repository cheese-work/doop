import type { MulticaConfig } from './multicaRuns.ts'

/**
 * The trusted checklist of the landing track (CHE-9448 S3a, inert: nothing calls it yet).
 *
 * The watcher writes its state as Multica issue comments, and doop reads them back before it lands
 * anything. Two things make the read trustworthy: the watcher id comes from server config
 * (`DOOP_LANDING_WATCHER_ID`), never from comment order, and the read is complete (no folded thread,
 * every page) or it refuses. Records use the grammar of the watcher's `records.py`: a first line
 * `design-<kind>:<ref>`, then `key: value` lines, a value JSON-quoted when it holds a newline.
 *
 * Refusals: `proof_unavailable` (any read problem, an unset watcher id, a record that cannot be read),
 * `watcher_mismatch` (the first `design-link` on the issue is not the watcher's),
 * `link_conflict` (the watcher's links name more than one canvas and topic), `no_checklist`.
 */

export type ChecklistRefusal = 'proof_unavailable' | 'watcher_mismatch' | 'link_conflict' | 'no_checklist'

export interface DesignLink {
  canvas: string
  topic: string
  [key: string]: unknown
}

export type TrustedChecklist =
  | {
      ok: true
      /** the watcher's first link on the issue */
      link: DesignLink
      /** the Multica decision the checklist asks about */
      decisionId: string
      /** the `Lock pin: …` line, as written */
      pin: string
      /** the checklist's text, decoded */
      text: string
      /** the Multica comment that holds the checklist */
      recordCommentId: string
    }
  | { ok: false; reason: ChecklistRefusal }

interface CommentRow {
  id: string
  authorType: string
  authorId: string
  content: string
  /** sort key of `created_at`: milliseconds, then the digits Date cannot hold */
  at: [number, string]
}

const PAGE_THREADS = 50
const MAX_PAGES = 200
const TAG = /^design-([a-z-]+):\s*(\S*)/

class Unreadable extends Error {}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)

/** `created_at` as a sortable pair; RFC 3339 with any number of fraction digits. */
function stamp(raw: string | null): [number, string] {
  const m = raw?.match(/^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d+))?(Z|[+-]\d\d:\d\d)$/)
  if (!m) throw new Unreadable('comment without a usable created_at')
  const ms = Date.parse(`${m[1]}.${(m[2] ?? '').slice(0, 3).padEnd(3, '0')}${m[3]}`)
  if (Number.isNaN(ms)) throw new Unreadable('comment without a usable created_at')
  return [ms, (m[2] ?? '').slice(3).padEnd(6, '0')]
}

const byOrder = (a: CommentRow, b: CommentRow): number =>
  a.at[0] - b.at[0] || (a.at[1] < b.at[1] ? -1 : a.at[1] > b.at[1] ? 1 : 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

/** Every comment of the issue, oldest first. Throws `Unreadable` unless every page was read. */
async function readComments(issueId: string, config: MulticaConfig, fetchImpl: typeof fetch): Promise<CommentRow[]> {
  const seen = new Map<string, CommentRow>()
  let cursor: { before: string; beforeId: string } | null = null
  const used = new Set<string>()
  for (let page = 0; page < MAX_PAGES; page++) {
    /* no `fold`: a resolved thread comes back whole */
    const query = new URLSearchParams({ recent: String(PAGE_THREADS) })
    if (cursor) {
      query.set('before', cursor.before)
      query.set('before_id', cursor.beforeId)
    }
    let res: Response
    try {
      res = await fetchImpl(`${config.apiUrl}/api/issues/${encodeURIComponent(issueId)}/comments?${query}`, {
        headers: { Authorization: `Bearer ${config.token}`, 'X-Workspace-ID': config.workspaceId },
        signal: AbortSignal.timeout(10_000),
      })
    } catch (err) {
      throw new Unreadable(`Multica could not be reached: ${err instanceof Error ? err.message : String(err)}`)
    }
    if (!res.ok) throw new Unreadable(`Multica answered ${res.status} for the issue's comments`)
    let rows: unknown
    try {
      rows = await res.json()
    } catch {
      throw new Unreadable('Multica returned an unreadable comments payload')
    }
    if (!Array.isArray(rows)) throw new Unreadable('Multica returned an unexpected comments payload')
    for (const raw of rows as Record<string, unknown>[]) {
      const id = str(raw?.id)
      const authorId = str(raw?.author_id)
      const content = str(raw?.content)
      if (!id || authorId === null || content === null) throw new Unreadable('comment without id, author or content')
      seen.set(id, { id, authorType: str(raw.author_type) ?? '', authorId, content, at: stamp(str(raw.created_at)) })
    }
    /* the last page has no cursor; a cursor must name both halves and move */
    const before = res.headers.get('X-Multica-Next-Before')
    const beforeId = res.headers.get('X-Multica-Next-Before-Id')
    if (before === null && beforeId === null) return [...seen.values()].sort(byOrder)
    if (!before || !beforeId) throw new Unreadable('Multica sent half a page cursor')
    const key = `${before}\n${beforeId}`
    if (used.has(key)) throw new Unreadable('Multica repeated a page cursor')
    used.add(key)
    cursor = { before, beforeId }
  }
  throw new Unreadable('too many comment pages')
}

/** `records._dec`: a value that starts with a quote is JSON when it parses, else as written. */
function decode(value: string): string {
  if (value.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(value)
      if (typeof parsed === 'string') return parsed
    } catch {
      /* not JSON: keep the text */
    }
  }
  return value
}

interface Record_ {
  kind: string
  fields: Map<string, string>
}

/** `records.parse`: the tag line, then `key: value` lines (a key's later line wins). */
function parseRecord(content: string): Record_ | null {
  const lines = content.trim().split(/\r?\n/)
  const tag = TAG.exec(lines[0] ?? '')
  if (!tag?.[1]) return null
  const fields = new Map<string, string>()
  for (const line of lines.slice(1)) {
    const at = line.indexOf(': ')
    if (at >= 0) fields.set(line.slice(0, at), decode(line.slice(at + 2)))
  }
  return { kind: tag[1], fields }
}

function readLink(record: Record_): DesignLink {
  let link: unknown
  try {
    link = JSON.parse(record.fields.get('json') ?? '')
  } catch {
    throw new Unreadable('a watcher link is not JSON')
  }
  const obj = link as Partial<DesignLink> | null
  if (!obj || typeof obj !== 'object' || typeof obj.canvas !== 'string' || typeof obj.topic !== 'string') {
    throw new Unreadable('a watcher link has no canvas and topic')
  }
  return obj as DesignLink
}

const refuse = (reason: ChecklistRefusal): TrustedChecklist => ({ ok: false, reason })

/**
 * The checklist that doop may act on, for the issue a page is bound to, or the reason it may not.
 * `watcherId` is `env.DOOP_LANDING_WATCHER_ID`; unset refuses before Multica is asked.
 */
export async function trustedChecklist(
  issueId: string,
  multica: MulticaConfig,
  watcherId: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<TrustedChecklist> {
  if (!watcherId) return refuse('proof_unavailable')
  try {
    const comments = await readComments(issueId, multica, fetchImpl)
    const records = comments.flatMap((c) => {
      const record = parseRecord(c.content)
      return record ? [{ comment: c, record }] : []
    })
    /* the first link of any author names whoever the older reader would follow */
    const firstLink = records.find((r) => r.record.kind === 'link')
    if (firstLink && !(firstLink.comment.authorType === 'agent' && firstLink.comment.authorId === watcherId)) {
      return refuse('watcher_mismatch')
    }
    const mine = records.filter((r) => r.comment.authorType === 'agent' && r.comment.authorId === watcherId)
    const links = mine.filter((r) => r.record.kind === 'link').map((r) => readLink(r.record))
    const first = links[0]
    if (!first) return refuse('no_checklist')
    if (new Set(links.map((l) => `${l.canvas}\n${l.topic}`)).size > 1) return refuse('link_conflict')
    const latest = mine.filter((r) => r.record.kind === 'checklist').at(-1)
    if (!latest) return refuse('no_checklist')
    const decisionId = latest.record.fields.get('decision')
    const pin = latest.record.fields.get('pin')
    if (!decisionId || !pin) return refuse('proof_unavailable')
    return {
      ok: true,
      link: first,
      decisionId,
      pin,
      text: latest.record.fields.get('text') ?? '',
      recordCommentId: latest.comment.id,
    }
  } catch (err) {
    if (err instanceof Unreadable) return refuse('proof_unavailable')
    throw err
  }
}
