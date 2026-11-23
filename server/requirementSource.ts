import { requirementLines, type RequirementLine, type SourceComment } from './requirementLedger.ts'

/**
 * Where the requirement ledger's source lines come from (CHE-6629): the
 * issue a page is bound to, read from Multica with the same server token that
 * lists a page's runs. Routes: `GET /api/issues/:id` (description) and
 * `GET /api/issues/:id/comments`, which returns the whole list unless
 * fold/recent/thread is asked for, and none is.
 *
 * Fails closed: any error, odd payload or withheld comment body throws, so a
 * source that may be incomplete never yields fewer lines to check.
 */

export interface RequirementSource {
  lines(issueId: string): Promise<RequirementLine[]>
  /** the issue's Multica key (`CHE-123`): the Motion page's spec frame is named after it */
  issueKey(issueId: string): Promise<string>
}

export interface RequirementSourceConfig {
  apiUrl: string
  token: string
  workspaceId: string
}

interface CommentRow {
  id?: unknown
  author_type?: unknown
  content?: unknown
  withheld?: unknown
}

export function httpRequirementSource(
  config: RequirementSourceConfig,
  fetchImpl: typeof fetch = fetch,
): RequirementSource {
  const get = async (path: string): Promise<unknown> => {
    const res = await fetchImpl(`${config.apiUrl}${path}`, {
      headers: { Authorization: `Bearer ${config.token}`, 'X-Workspace-ID': config.workspaceId },
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) throw new Error(`Multica answered ${res.status} for ${path}`)
    return res.json()
  }
  return {
    async issueKey(issueId) {
      const issue = await get(`/api/issues/${encodeURIComponent(issueId)}`)
      const key =
        typeof issue === 'object' && issue !== null ? (issue as { identifier?: unknown }).identifier : undefined
      if (typeof key !== 'string' || !key.trim()) throw new Error('Multica returned an issue with no identifier')
      return key.trim()
    },
    async lines(issueId) {
      const id = encodeURIComponent(issueId)
      const [issue, rows] = await Promise.all([get(`/api/issues/${id}`), get(`/api/issues/${id}/comments`)])
      if (typeof issue !== 'object' || issue === null) throw new Error('Multica returned an unexpected issue payload')
      const description = (issue as { description?: unknown }).description
      if (description !== null && description !== undefined && typeof description !== 'string')
        throw new Error('Multica returned an unexpected issue description')
      if (!Array.isArray(rows)) throw new Error('Multica returned an unexpected comments payload')
      const comments: SourceComment[] = (rows as CommentRow[]).map((row) => {
        if (row.withheld === true) throw new Error('Multica withheld a comment body; the source is incomplete')
        if (typeof row.id !== 'string' || typeof row.author_type !== 'string' || typeof row.content !== 'string')
          throw new Error('Multica returned an unexpected comment')
        return { id: row.id, authorType: row.author_type, content: row.content }
      })
      return requirementLines(description ?? null, comments)
    },
  }
}

/** The HTTP source when the API url, token and workspace exist, else undefined (the row then reports it did not run). */
export function multicaRequirementSource(
  settings: { MULTICA_API_URL?: string; MULTICA_API_TOKEN?: string; MULTICA_WORKSPACE_ID?: string },
  fetchImpl?: typeof fetch,
): RequirementSource | undefined {
  const { MULTICA_API_URL: apiUrl, MULTICA_API_TOKEN: token, MULTICA_WORKSPACE_ID: workspaceId } = settings
  if (!apiUrl || !token || !workspaceId) return undefined
  return httpRequirementSource({ apiUrl: apiUrl.replace(/\/$/, ''), token, workspaceId }, fetchImpl)
}
