import { nanoid } from 'nanoid'
import * as persist from './db/persist.ts'
import { env } from './env.ts'
import {
  ledgerReport,
  requirementsHash,
  requirementsStillHold,
  type DeferredLine,
  type RequirementLine,
  type RequirementsNow,
} from './requirementLedger.ts'
import { multicaRequirementSource, type RequirementSource } from './requirementSource.ts'
import { store } from './store.ts'
import {
  attestationRowsFor,
  checkPageCompleteness,
  currentAttestation,
  type CompletenessReport,
  type SloplintEntry,
} from '../shared/designCompleteness.ts'
import { canvasPages } from '../shared/pages.ts'
import { resolvePageIssue } from '../shared/pageIssue.ts'
import type { Canvas } from '../shared/types.ts'

/**
 * G3, the server half: run the completeness check on one page and keep the
 * result as an attestation the agent cannot edit (CHE-6078 r5). G4, later,
 * reads attestations through `readAttestation`, never from comment text.
 * The requirement ledger (CHE-6373, CHE-6629) is one more row of the check:
 * the source lines come from the page's bound Multica issue, and their hash is
 * stored with the run so a source that changes ends the attestation.
 */

export type AttestedReport = CompletenessReport & {
  attestation_id: string | null
  /** lines the designer deferred; the decision card prints them for Cheese */
  deferred: DeferredLine[]
}

type RequirementRead =
  | { kind: 'lines'; lines: RequirementLine[]; hash: string; issue: string; key: string }
  | { kind: 'unavailable'; reason: string }
  | { kind: 'not_checked'; reason: string }

/** The requirement lines for a page. No Multica configured, a page with no bound issue, or a Multica that cannot answer means the row cannot run, and the run is blocked: an unchecked ledger never attests. */
async function readRequirements(
  canvas: Canvas,
  pageId: string,
  source: RequirementSource | undefined,
): Promise<RequirementRead> {
  if (!source) return { kind: 'not_checked', reason: 'Multica is not configured on this server' }
  const page = canvasPages(canvas).find((p) => p.id === pageId)
  const issueId = resolvePageIssue(page)
  if (page?.issueId !== undefined && page.issueId !== null && !issueId)
    return { kind: 'unavailable', reason: 'the page has an invalid issue link; a member must rebind it' }
  if (!issueId) return { kind: 'not_checked', reason: 'the page is not bound to a Multica issue' }
  try {
    const [lines, key] = await Promise.all([source.lines(issueId), source.issueKey(issueId)])
    return { kind: 'lines', lines, hash: requirementsHash(lines), issue: issueId, key }
  } catch (error) {
    return {
      kind: 'unavailable',
      reason: `Multica could not be read (${error instanceof Error ? error.message : 'error'})`,
    }
  }
}

export async function attestPage(
  canvas: Canvas,
  pageId: string,
  by: string,
  source: RequirementSource | undefined = multicaRequirementSource(env),
  sloplint: SloplintEntry[] = [],
): Promise<AttestedReport> {
  const requirements = await readRequirements(canvas, pageId, source)
  let ledger: ReturnType<typeof ledgerReport> | undefined
  const report = checkPageCompleteness(canvas, pageId, {
    issueKey: requirements.kind === 'lines' ? requirements.key : null,
    sloplint,
    extraChecks: [
      (ctx) => {
        if (requirements.kind === 'unavailable')
          return [{ code: 'req_source_unavailable', detail: `requirement ledger cannot run: ${requirements.reason}` }]
        if (requirements.kind === 'not_checked')
          return [{ code: 'req_not_checked', detail: `requirement ledger not checked: ${requirements.reason}` }]
        ledger = ledgerReport(requirements.lines, ctx)
        return ledger.missing
      },
    ],
  })
  if (requirements.kind === 'lines')
    report.inputs = { ...report.inputs, requirements: requirements.hash, requirementsIssue: requirements.issue }
  report.reviewerNotes.push(...(ledger?.notes ?? []))
  const runId = nanoid()
  const rows = attestationRowsFor(canvas, report, runId, Date.now(), by)
  await persist.saveAttestationRows(rows)
  /* an empty page has no frame to attest: nothing stored, nothing to cite */
  return { ...report, attestation_id: rows.length ? runId : null, deferred: ledger?.deferred ?? [] }
}

export interface AttestationView {
  id: string
  canvasId: string
  pageId: string
  ruleset: string
  scanHash: string | null
  complete: boolean
  missing: CompletenessReport['missing']
  frames: { frameId: string; updatedAt: number }[]
  createdAt: number
  createdBy: string
  /** true while every frame is still at the version the run saw and the ruleset has not moved */
  current: boolean
  /** who wrote the attested page and every page bound to the same issue (CHE-7064 D1.5) */
  authors: AttestationAuthor[]
  /** every writer is a named person or a verified agent task; false for an empty set, `unknown`, `system` */
  provenanceComplete: boolean
}

/** One distinct writer in the author set. '' means "none" for that identity field, as in the ledger. */
export interface AttestationAuthor {
  kind: 'agent' | 'user' | 'system' | 'unknown'
  agentId: string
  taskId: string
  userId: string
  provider: string
  model: string
  /** how the writer reached the set, from the ledger rows: `write`, `copy` and `legacy` */
  sources: string[]
}

const AUTHOR_KINDS: ReadonlySet<string> = new Set(['agent', 'user', 'system', 'unknown'])

/** The author set of an attested page: its own ledger rows plus the rows of every page, on any canvas, whose current
 *  issue is the same. Rows of one writer fold into one entry that lists each source. */
async function authorsOf(
  canvasId: string,
  pageId: string,
  canvas: Canvas | undefined,
): Promise<{ authors: AttestationAuthor[]; provenanceComplete: boolean }> {
  const pages = [{ canvasId, pageId }]
  const issueId = resolvePageIssue(canvas && canvasPages(canvas).find((p) => p.id === pageId))
  if (issueId) {
    for (const other of store.allCanvases()) {
      for (const page of canvasPages(other)) {
        if (resolvePageIssue(page) === issueId && !(other.id === canvasId && page.id === pageId))
          pages.push({ canvasId: other.id, pageId: page.id })
      }
    }
  }
  const byWriter = new Map<string, AttestationAuthor>()
  for (const row of await persist.listPageAuthorsOf(pages)) {
    const kind = AUTHOR_KINDS.has(row.kind) ? (row.kind as AttestationAuthor['kind']) : 'unknown'
    const key = [kind, row.agentId, row.taskId, row.userId].join('\u0000')
    const entry = byWriter.get(key) ?? {
      kind,
      agentId: row.agentId,
      taskId: row.taskId,
      userId: row.userId,
      provider: row.provider,
      model: row.model,
      sources: [],
    }
    entry.provider ||= row.provider
    entry.model ||= row.model
    if (!entry.sources.includes(row.source)) entry.sources.push(row.source)
    byWriter.set(key, entry)
  }
  const authors = [...byWriter.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, entry]) => ({ ...entry, sources: entry.sources.sort() }))
  const provenanceComplete =
    authors.length > 0 &&
    authors.every((a) => (a.kind === 'agent' ? !!a.agentId && !!a.taskId : a.kind === 'user' ? true : false))
  return { authors, provenanceComplete }
}

export async function readAttestation(
  runId: string,
  source: RequirementSource | undefined = multicaRequirementSource(env),
): Promise<AttestationView | null> {
  const rows = await persist.listAttestationRun(runId)
  const head = rows[0]
  if (!head) return null
  const canvas = store.getCanvas(head.canvasId)
  /* current needs a run that read the lines of this issue, and the source must still say the same; anything else (legacy, unchecked, rebound, unreadable) is not current */
  let requirementsNow: RequirementsNow | null = null
  if (canvas) {
    const now = await readRequirements(canvas, head.pageId, source)
    if (now.kind === 'lines') requirementsNow = { issue: now.issue, hash: now.hash }
  }
  const requirementsHold = requirementsStillHold(head.inputs, requirementsNow)
  const { authors, provenanceComplete } = await authorsOf(head.canvasId, head.pageId, canvas)
  return {
    id: runId,
    canvasId: head.canvasId,
    pageId: head.pageId,
    ruleset: head.ruleset,
    scanHash: head.scanHash,
    complete: head.result === 'complete',
    missing: head.missing,
    frames: rows.map((r) => ({ frameId: r.frameId, updatedAt: r.frameUpdatedAt })),
    createdAt: head.createdAt,
    createdBy: head.createdBy,
    current:
      !!canvas &&
      requirementsHold &&
      currentAttestation(canvas, head.pageId, rows, requirementsNow?.hash ?? null)?.runId === runId,
    authors,
    provenanceComplete,
  }
}

/** The view plus the issue the attested page is bound to now (null when unbound): the G4 service route's answer. */
export async function readServiceAttestation(
  runId: string,
): Promise<(AttestationView & { pageIssueId: string | null }) | null> {
  const view = await readAttestation(runId)
  if (!view) return null
  const page = store.getCanvas(view.canvasId)?.pages?.find((p) => p.id === view.pageId)
  return { ...view, pageIssueId: page?.issueId ?? null }
}
