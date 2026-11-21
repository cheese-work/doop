import { resolvePageIssue } from '../shared/pageIssue.ts'
import { canvasPages } from '../shared/pages.ts'
import type { Canvas } from '../shared/types.ts'

export interface PageRun {
  id: string
  kind: 'issue' | 'chat'
  status: string
  agentId: string | null
  startedAt: string | null
  completedAt: string | null
  /** opens the run's conversation in the Multica web app */
  hopInUrl: string
}

export interface RunsSource {
  issueRuns(issueId: string): Promise<PageRun[]>
  /** runs of the DM bound to `issueId`, or of the project DM when null.
   *  Absent until CHE-3073 7c's find-or-create DM resolver exists. */
  chatRuns?(canvasId: string, issueId: string | null): Promise<PageRun[]>
}

export type PageRunsResult =
  | { ok: true; issueId: string | null; chat: 'ok' | 'unavailable'; runs: PageRun[] }
  | { ok: false; status: 404 | 409; error: string }

/**
 * The Multica runs that touch a page: the runs of its bound issue plus the
 * chat runs of the issue's DM; an unbound (baseline) page has the project DM.
 * A stored link that is not a valid issue id fails closed — nothing is listed
 * and Multica is not asked.
 */
export async function listPageRuns(canvas: Canvas, pageId: string, source: RunsSource): Promise<PageRunsResult> {
  const page = canvasPages(canvas).find((p) => p.id === pageId)
  if (!page) return { ok: false, status: 404, error: 'page not found' }
  const issueId = resolvePageIssue(page)
  if (page.issueId !== undefined && !issueId) {
    return { ok: false, status: 409, error: 'This page has an invalid issue link. A member must rebind it.' }
  }
  const [issueRuns, chatRuns] = await Promise.all([
    issueId ? source.issueRuns(issueId) : Promise.resolve([]),
    source.chatRuns ? source.chatRuns(canvas.id, issueId) : Promise.resolve([]),
  ])
  const runs = [...issueRuns, ...chatRuns].sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''))
  return { ok: true, issueId, chat: source.chatRuns ? 'ok' : 'unavailable', runs }
}

export interface MulticaConfig {
  /** Multica API origin, e.g. https://host:19444 */
  apiUrl: string
  token: string
  workspaceId: string
  /** Multica web origin plus workspace slug, e.g. https://host:19443/cheese-work */
  webUrl: string
}

interface TaskRunRow {
  id?: unknown
  status?: unknown
  agent_id?: unknown
  created_at?: unknown
  dispatched_at?: unknown
  completed_at?: unknown
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)

/** Issue runs from Multica's `GET /api/issues/:id/task-runs`; chat runs wait for the DM resolver. */
export function httpRunsSource(config: MulticaConfig, fetchImpl: typeof fetch = fetch): RunsSource {
  return {
    async issueRuns(issueId) {
      const res = await fetchImpl(`${config.apiUrl}/api/issues/${encodeURIComponent(issueId)}/task-runs`, {
        headers: { Authorization: `Bearer ${config.token}`, 'X-Workspace-ID': config.workspaceId },
        signal: AbortSignal.timeout(10_000),
      })
      if (!res.ok) throw new Error(`Multica answered ${res.status} for the issue's runs`)
      const rows = (await res.json()) as TaskRunRow[]
      if (!Array.isArray(rows)) throw new Error('Multica returned an unexpected runs payload')
      return rows.flatMap((row) => {
        const id = str(row.id)
        if (!id) return []
        return [
          {
            id,
            kind: 'issue' as const,
            status: str(row.status) ?? 'unknown',
            agentId: str(row.agent_id),
            startedAt: str(row.dispatched_at) ?? str(row.created_at),
            completedAt: str(row.completed_at),
            hopInUrl: `${config.webUrl}/issues/${issueId}?run=${id}`,
          },
        ]
      })
    },
  }
}

/** The HTTP source when all four settings exist, else undefined (the route answers 503). */
export function multicaRunsSource(settings: {
  MULTICA_API_URL?: string
  MULTICA_API_TOKEN?: string
  MULTICA_WORKSPACE_ID?: string
  MULTICA_WEB_URL?: string
}): RunsSource | undefined {
  const { MULTICA_API_URL: apiUrl, MULTICA_API_TOKEN: token, MULTICA_WORKSPACE_ID: workspaceId } = settings
  const webUrl = settings.MULTICA_WEB_URL
  if (!apiUrl || !token || !workspaceId || !webUrl) return undefined
  return httpRunsSource({ apiUrl: apiUrl.replace(/\/$/, ''), token, workspaceId, webUrl: webUrl.replace(/\/$/, '') })
}
