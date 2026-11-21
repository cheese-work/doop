import type { CanvasPageInfo } from './types.ts'

/** Header a Multica agent's doop MCP calls carry: its Multica task (run) id. */
export const MULTICA_TASK_HEADER = 'x-multica-task-id'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const isUuid = (value: unknown): value is string => typeof value === 'string' && UUID.test(value)

/** The run id from the header value, or undefined for anything that is not exactly one uuid. */
export function parseMulticaTaskId(value: unknown): string | undefined {
  return typeof value === 'string' && UUID.test(value) ? value.toLowerCase() : undefined
}

/** The issue a page is bound to. Fails closed: no page, no link or a malformed id is "unbound". */
export function resolvePageIssue(page: CanvasPageInfo | undefined): string | null {
  const id = page?.issueId
  return typeof id === 'string' && UUID.test(id) ? id : null
}

export interface DesignIssue {
  id: string
  /** the issue's `Design` URL property, if set */
  designUrl?: string | null
}

/** The pages of `canvasId` a Design URL (`/c/<canvas>[/proto]?page=<id>` or `?frame=<id>`) names. */
function namedPages(
  url: string,
  canvasId: string,
  pageIds: ReadonlySet<string>,
  pageOfFrame: (frameId: string) => string | undefined,
): Set<string> {
  const named = new Set<string>()
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return named
  }
  const [root, id, ...rest] = parsed.pathname.split('/').filter(Boolean)
  if (root !== 'c' || id !== canvasId || (rest.length > 0 && !(rest.length === 1 && rest[0] === 'proto'))) return named
  const page = parsed.searchParams.get('page')
  if (page && pageIds.has(page)) named.add(page)
  const frame = parsed.searchParams.get('frame')
  const framePage = frame ? pageOfFrame(frame) : undefined
  if (framePage && pageIds.has(framePage)) named.add(framePage)
  return named
}

/**
 * Server-side derivation of page→issue links from the issues' `Design` URL.
 * A page links to an issue only when exactly one issue names it and that
 * issue names no other page; anything else is a conflict and links nothing.
 * URLs for another canvas, an unknown page or a malformed issue id are ignored.
 */
export function deriveDesignLinks(
  canvasId: string,
  pages: readonly CanvasPageInfo[],
  issues: readonly DesignIssue[],
  pageOfFrame: (frameId: string) => string | undefined,
): { links: Map<string, string>; conflicts: Set<string> } {
  const pageIds = new Set(pages.map((p) => p.id))
  const claims = new Map<string, Set<string>>()
  const conflicts = new Set<string>()
  for (const issue of issues) {
    if (!UUID.test(issue.id) || !issue.designUrl) continue
    const named = namedPages(issue.designUrl, canvasId, pageIds, pageOfFrame)
    if (named.size > 1) for (const page of named) conflicts.add(page)
    for (const page of named) claims.set(page, (claims.get(page) ?? new Set()).add(issue.id.toLowerCase()))
  }
  const links = new Map<string, string>()
  for (const [page, issueIds] of claims) {
    if (issueIds.size > 1) conflicts.add(page)
    else if (!conflicts.has(page)) links.set(page, [...issueIds][0]!)
  }
  return { links, conflicts }
}
