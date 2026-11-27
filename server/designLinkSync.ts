import { env } from './env.ts'
import { store } from './store.ts'
import type { DesignIssue } from '../shared/pageIssue.ts'

/**
 * The runtime caller of `store.applyDesignLinks` (CHE-10542). A page binds to
 * the Multica issue whose `Design` URL property names it; this reads those
 * issues through the Multica read link (the same API url, token and workspace
 * that serve the requirement ledger) and reconciles the 'design' links.
 *
 * Trust (CHE-5571): the only inputs are Multica's own issue rows, read by the
 * server. No MCP tool, agent call or `designctl` passes issues in, and member
 * links are never touched (`applyDesignLinks` skips them).
 *
 * Fails closed: Multica not configured, unreadable, a payload that is not what
 * we expect, or more issues than we page through means NOTHING changes. A page
 * that is then unbound stays unbound, and G3 reports req_not_checked.
 */

export interface DesignLinkConfig {
  apiUrl: string
  token: string
  workspaceId: string
}

/** Issues whose Design URL contains `needle` (`/c/` for every canvas, `/c/<id>` for one). */
export interface DesignIssueSource {
  issuesNaming(needle: string): Promise<DesignIssue[]>
}

const PAGE_SIZE = 100
/** a read that needs more pages than this throws instead of reconciling on a partial list (it would clear links) */
const MAX_PAGES = 50
/** the property is called `Design` (once `Design url`); only a url-typed one counts */
const DESIGN_PROPERTY = /^design( url)?$/i

interface PropertyRow {
  id?: unknown
  name?: unknown
  type?: unknown
  archived?: unknown
}

export function httpDesignIssueSource(config: DesignLinkConfig, fetchImpl: typeof fetch = fetch): DesignIssueSource {
  const get = async (path: string): Promise<unknown> => {
    const res = await fetchImpl(`${config.apiUrl}${path}`, {
      headers: { Authorization: `Bearer ${config.token}`, 'X-Workspace-ID': config.workspaceId },
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) throw new Error(`Multica answered ${res.status} for ${path.split('?')[0]}`)
    return res.json()
  }
  const designPropertyId = async (): Promise<string> => {
    const body = await get('/api/properties')
    const rows = (body as { properties?: unknown } | null)?.properties
    if (!Array.isArray(rows)) throw new Error('Multica returned an unexpected properties payload')
    const found = (rows as PropertyRow[]).filter(
      (row) =>
        row.archived !== true && row.type === 'url' && typeof row.name === 'string' && DESIGN_PROPERTY.test(row.name),
    )
    if (found.length !== 1 || typeof found[0]!.id !== 'string')
      throw new Error(`expected one Design url property, found ${found.length}`)
    return found[0]!.id
  }
  return {
    async issuesNaming(needle) {
      const propertyId = await designPropertyId()
      const filter = encodeURIComponent(JSON.stringify({ [propertyId]: [{ op: 'contains', value: needle }] }))
      const issues: DesignIssue[] = []
      for (let page = 0; page < MAX_PAGES; page++) {
        const body = (await get(
          `/api/issues?limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}&properties=${filter}&workspace_id=${encodeURIComponent(config.workspaceId)}`,
        )) as { issues?: unknown; has_more?: unknown } | null
        if (!body || !Array.isArray(body.issues)) throw new Error('Multica returned an unexpected issues payload')
        for (const row of body.issues as { id?: unknown; properties?: unknown }[]) {
          if (typeof row?.id !== 'string') throw new Error('Multica returned an issue with no id')
          const value = (row.properties as Record<string, unknown> | null | undefined)?.[propertyId]
          issues.push({ id: row.id, designUrl: typeof value === 'string' ? value : null })
        }
        if (body.has_more !== true) return issues
      }
      throw new Error(
        `more than ${MAX_PAGES * PAGE_SIZE} issues name a design; refusing to reconcile on a partial list`,
      )
    },
  }
}

/** The HTTP source when the API url, token and workspace exist, else undefined (nothing is synced). */
export function multicaDesignIssueSource(
  settings: { MULTICA_API_URL?: string; MULTICA_API_TOKEN?: string; MULTICA_WORKSPACE_ID?: string },
  fetchImpl?: typeof fetch,
): DesignIssueSource | undefined {
  const { MULTICA_API_URL: apiUrl, MULTICA_API_TOKEN: token, MULTICA_WORKSPACE_ID: workspaceId } = settings
  if (!apiUrl || !token || !workspaceId) return undefined
  return httpDesignIssueSource({ apiUrl: apiUrl.replace(/\/$/, ''), token, workspaceId }, fetchImpl)
}

/** How long a canvas's links count as fresh for the G3 path: an agent that re-runs the check in a loop must not become a Multica read loop. */
const FRESH_MS = 15_000
const lastRead = new Map<string, number>()

/**
 * Every sync (a G3 check's and the timer's) runs one at a time, read and write
 * together. A read that started earlier then can never apply after a read that
 * started later, so an old answer cannot overwrite a newer one.
 */
let queue: Promise<unknown> = Promise.resolve()
function serialized<T>(job: () => Promise<T>): Promise<T> {
  const run = queue.then(job)
  queue = run.catch(() => undefined)
  return run
}
/** a canvas whose sync is queued or running: a second G3 check awaits it instead of skipping it */
const inFlight = new Map<string, Promise<boolean>>()

/**
 * Reconcile one canvas's design links. Run before G3 reads the page, so a
 * Design url set a moment ago binds without waiting for the timer. A caller
 * that arrives while this canvas's sync is pending gets that same promise, so
 * it never reads the page before the link is applied. Never throws: a failed
 * read leaves every link as it was.
 */
export function syncCanvasDesignLinks(
  canvasId: string,
  source: DesignIssueSource | undefined = multicaDesignIssueSource(env),
  now?: number,
): Promise<boolean> {
  if (!source) return Promise.resolve(false)
  const pending = inFlight.get(canvasId)
  if (pending) return pending
  const run = serialized(async () => {
    const at = now ?? Date.now()
    if (at - (lastRead.get(canvasId) ?? -Infinity) < FRESH_MS) return false
    try {
      const issues = await source.issuesNaming(`/c/${canvasId}`)
      const applied = store.applyDesignLinks(canvasId, issues) !== undefined
      lastRead.set(canvasId, at)
      return applied
    } catch (error) {
      console.warn(`[design-links] ${canvasId} not synced: ${error instanceof Error ? error.message : error}`)
      return false
    }
  }).finally(() => inFlight.delete(canvasId))
  inFlight.set(canvasId, run)
  return run
}

/**
 * Reconcile every canvas in one read (the timer). Returns how many canvases it
 * looked at. Never throws; a failed or partial read changes nothing.
 */
export function syncAllDesignLinks(
  source: DesignIssueSource | undefined = multicaDesignIssueSource(env),
): Promise<number> {
  if (!source) return Promise.resolve(0)
  return serialized(async () => {
    try {
      const issues = await source.issuesNaming('/c/')
      const canvases = store.allCanvases()
      for (const canvas of canvases) store.applyDesignLinks(canvas.id, issues)
      return canvases.length
    } catch (error) {
      console.warn(`[design-links] timer sync failed: ${error instanceof Error ? error.message : error}`)
      return 0
    }
  })
}

/** Test hook: forget the per-canvas freshness. */
export function resetDesignLinkFreshness() {
  lastRead.clear()
}
