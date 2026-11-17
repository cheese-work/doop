import { nanoid } from 'nanoid'
import * as persist from './db/persist.ts'
import { store } from './store.ts'
import {
  attestationRowsFor,
  checkPageCompleteness,
  currentAttestation,
  type CompletenessReport,
} from '../shared/designCompleteness.ts'
import type { Canvas } from '../shared/types.ts'

/**
 * G3, the server half: run the completeness check on one page and keep the
 * result as an attestation the agent cannot edit (CHE-6078 r5). G4, later,
 * reads attestations through `readAttestation`, never from comment text.
 * The requirement ledger (CHE-6373) plugs in through `extraChecks` below.
 */

export type AttestedReport = CompletenessReport & { attestation_id: string | null }

export async function attestPage(canvas: Canvas, pageId: string, by: string): Promise<AttestedReport> {
  const report = checkPageCompleteness(canvas, pageId)
  const runId = nanoid()
  const rows = attestationRowsFor(canvas, report, runId, Date.now(), by)
  await persist.saveAttestationRows(rows)
  /* an empty page has no frame to attest: nothing stored, nothing to cite */
  return { ...report, attestation_id: rows.length ? runId : null }
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
}

export async function readAttestation(runId: string): Promise<AttestationView | null> {
  const rows = await persist.listAttestationRun(runId)
  const head = rows[0]
  if (!head) return null
  const canvas = store.getCanvas(head.canvasId)
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
    current: !!canvas && currentAttestation(canvas, head.pageId, rows)?.runId === runId,
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
