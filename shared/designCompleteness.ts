import { canvasPages, pageFrames } from './pages.ts'
import { readAttributes, scanInteractions, targetsFrame } from './prototype.ts'
import type { Canvas, Frame } from './types.ts'

/**
 * G3 of the design process (CHE-6078 r5, "Yêu cầu 5"): what makes one page of
 * a canvas, one design direction, complete. A pure check over the canvas; the
 * server stores each run as an attestation (server/db/persist.ts) that the
 * UX verdict and the later decision-card validation (G4) point at.
 *
 * The machine checks that each artefact EXISTS, never that it is drawn well.
 * That half stays with the reviewer (see REVIEWER_NOTE).
 */

/** Bump when a rule changes: older attestations then stop counting. */
export const COMPLETENESS_RULESET = 'g3-r5.1'

export const REQUIRED_STATES = ['loading', 'empty', 'error', 'disconnected'] as const
export const MOTION_FIELDS = ['trigger', 'property', 'duration', 'easing', 'reducedMotion'] as const
export const RECON_DECISIONS = ['keep', 'change', 'remove', 'n/a'] as const

const REVIEWER_NOTE =
  'The machine only checks that each Keep/Change item has an element with data-recon-ref. Whether it is drawn right (for example the composer position for each sort direction) is the reviewer’s check against the recon table; a verdict without that table is NOT-RUN.'

export interface Missing {
  code: string
  frameId?: string
  detail: string
}

export interface CompletenessReport {
  pageId: string
  ruleset: string
  /** the code-scan hash the recon inventory carries, when it carries one */
  scanHash: string | null
  complete: boolean
  missing: Missing[]
  /** the frames this run looked at, with the version it saw */
  frames: { id: string; updatedAt: number }[]
  /** the other inputs the verdict depends on: the recon frame(s) at their version and the page's flow start */
  inputs: AttestedInputs
  reviewerNotes: string[]
}

export interface AttestedInputs {
  recon: { id: string; updatedAt: number }[]
  start: string | null
  /** hash of the requirement lines the ledger row read (CHE-6373); absent when that row did not run */
  requirements?: string | null
  /** the Multica issue those lines came from; a rebind to another issue ends the attestation */
  requirementsIssue?: string | null
}

/** One stored row: a frame at a version, inside one run of the check. */
export interface AttestationRow {
  runId: string
  canvasId: string
  pageId: string
  frameId: string
  frameUpdatedAt: number
  ruleset: string
  scanHash: string | null
  inputs: AttestedInputs
  result: 'complete' | 'incomplete'
  missing: Missing[]
  createdAt: number
  createdBy: string
}

/** Plug-in point for the requirement ledger (CHE-6373, server/requirementLedger.ts): extra
 *  checks over the same page, whose findings count like any other. */
export interface CheckContext {
  canvas: Canvas
  pageId: string
  designFrames: Frame[]
}
export interface CheckOptions {
  extraChecks?: ((ctx: CheckContext) => Missing[])[]
}

/* ---- reading frame HTML without a DOM ---- */

export interface El {
  tag: string
  attrs: Map<string, string>
  /** script and style bodies only */
  body?: string
}

export function scanElements(html: string): El[] {
  const out: El[] = []
  const tagRe = /<!--[\s\S]*?-->|<(script|style)(?=[\s/>])|<([a-z][\w:-]*)/gi
  let m: RegExpExecArray | null
  while ((m = tagRe.exec(html))) {
    const raw = m[1] ?? m[2]
    if (!raw) continue
    const { attrs, end } = readAttributes(html, m.index + raw.length + 1)
    const el: El = { tag: raw.toLowerCase(), attrs }
    if (m[1] && end !== -1) {
      const close = new RegExp(`</${m[1]}\\s*>`, 'i').exec(html.slice(end + 1))
      el.body = html.slice(end + 1, close ? end + 1 + close.index : undefined)
      tagRe.lastIndex = close ? end + 1 + close.index + close[0].length : html.length
    } else if (end !== -1) tagRe.lastIndex = end + 1
    out.push(el)
  }
  return out
}

const RECON_ID = 'doop-recon'

function reconScripts(els: El[]): El[] {
  return els.filter((el) => el.tag === 'script' && el.attrs.get('id') === RECON_ID)
}

/** The bodies of the `doop-recon` scripts in one piece of frame HTML (empty: it is not a recon frame). */
export const reconBodies = (html: string): string[] => reconScripts(scanElements(html)).map((el) => el.body ?? '')

const RECON_SHELL = new Set(['html', 'head', 'body', 'meta'])

/** True when the HTML is nothing but one `doop-recon` script (in an optional html/head/body shell): no design markup, text or other script. */
export function isReconOnly(html: string): boolean {
  const els = scanElements(html)
  const recon = reconScripts(els)
  if (recon.length !== 1 || els.some((el) => el !== recon[0] && !RECON_SHELL.has(el.tag))) return false
  const text = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<[^>]*>/g, '')
  return text.replace(/&nbsp;|\s/g, '') === ''
}

/* ---- what is a design frame ---- */

interface ScannedFrame {
  frame: Frame
  els: El[]
  isRecon: boolean
}

function scanPage(canvas: Canvas, pageId: string): ScannedFrame[] {
  return pageFrames(canvas, pageId).map((frame) => {
    const els = scanElements(frame.html)
    return { frame, els, isRecon: reconScripts(els).length > 0 }
  })
}

const isDesign = (s: ScannedFrame) => !s.isRecon && !s.frame.hidden

/** The frames an attestation covers: the page's visible frames that are not the recon frame. */
export function designFrames(canvas: Canvas, pageId: string): Frame[] {
  return scanPage(canvas, pageId)
    .filter(isDesign)
    .map((s) => s.frame)
}

/** Everything besides the design frames that a verdict reads: recon frames (any, hidden or not) and the flow start. */
function attestedInputs(canvas: Canvas, pageId: string, scanned = scanPage(canvas, pageId)): AttestedInputs {
  const recon = scanned
    .filter((s) => s.isRecon)
    .map((s) => ({ id: s.frame.id, updatedAt: s.frame.updatedAt }))
    .sort((a, b) => a.id.localeCompare(b.id))
  return { recon, start: canvasPages(canvas).find((p) => p.id === pageId)?.startFrameId ?? null }
}

const sameInputs = (a: AttestedInputs, b: AttestedInputs) =>
  a.start === b.start &&
  a.recon.length === b.recon.length &&
  a.recon.every((r, i) => r.id === b.recon[i]?.id && r.updatedAt === b.recon[i]?.updatedAt)

/* ---- the check ---- */

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '')

export function checkPageCompleteness(canvas: Canvas, pageId: string, opts: CheckOptions = {}): CompletenessReport {
  const scanned = scanPage(canvas, pageId)
  const design = scanned.filter(isDesign)
  const missing: Missing[] = []
  const frames = design.map((s) => ({ id: s.frame.id, updatedAt: s.frame.updatedAt }))
  const report = (scanHash: string | null = null): CompletenessReport => ({
    pageId,
    ruleset: COMPLETENESS_RULESET,
    scanHash,
    complete: missing.length === 0,
    missing,
    frames,
    inputs: attestedInputs(canvas, pageId, scanned),
    reviewerNotes: [REVIEWER_NOTE],
  })

  if (!design.length) {
    missing.push({ code: 'no_design_frames', detail: 'the page has no design frame besides the recon frame' })
    return report()
  }
  const designEls = design.flatMap((s) => s.els.map((el) => ({ el, frameId: s.frame.id })))

  /* recon: every inventory item is handled, and kept or changed items are drawn */
  let scanHash: string | null = null
  const refs = new Set(
    designEls.flatMap(({ el }) => (el.attrs.has('data-recon-ref') ? [el.attrs.get('data-recon-ref')!] : [])),
  )
  const reconFrames = scanned.filter((s) => s.isRecon)
  if (!reconFrames.length)
    missing.push({
      code: 'recon_missing',
      detail: `no frame carries <script type="application/json" id="${RECON_ID}">`,
    })
  for (const s of reconFrames) {
    const body = reconScripts(s.els)[0]?.body ?? ''
    let parsed: unknown
    try {
      parsed = JSON.parse(body)
    } catch {
      missing.push({
        code: 'recon_invalid',
        frameId: s.frame.id,
        detail: `${RECON_ID} in frame ${s.frame.id} is not valid JSON`,
      })
      continue
    }
    const root = parsed as { scanHash?: unknown; candidates?: unknown } | unknown[] | null
    const list = Array.isArray(root) ? root : root && typeof root === 'object' ? root.candidates : undefined
    if (!Array.isArray(list)) {
      missing.push({ code: 'recon_invalid', frameId: s.frame.id, detail: `${RECON_ID} has no candidates list` })
      continue
    }
    if (!Array.isArray(root) && root && typeof root.scanHash === 'string' && !scanHash) scanHash = root.scanHash
    for (const [i, c] of list.entries()) {
      const item = (c && typeof c === 'object' ? c : {}) as Record<string, unknown>
      const id = str(item.id)
      if (!id) {
        missing.push({ code: 'recon_invalid', frameId: s.frame.id, detail: `candidate #${i + 1} has no id` })
        continue
      }
      const where = item.file ? ` (${str(item.file)}${item.line ? `:${str(item.line)}` : ''})` : ''
      const decision = str(item.decision)
      if (!(RECON_DECISIONS as readonly string[]).includes(decision)) {
        missing.push({
          code: 'recon_unresolved',
          detail: `candidate "${id}"${where} has no decision (${RECON_DECISIONS.join(' | ')})`,
        })
        continue
      }
      if (decision !== 'keep' && !str(item.reason))
        missing.push({
          code: 'recon_reason_missing',
          detail: `candidate "${id}"${where} is ${decision} without a reason`,
        })
      if ((decision === 'keep' || decision === 'change') && !refs.has(id))
        missing.push({
          code: 'recon_ref_missing',
          detail: `candidate "${id}"${where} is ${decision} but no design element has data-recon-ref="${id}"`,
        })
    }
  }

  /* wireframe before hi-fi */
  const isWire = (s: ScannedFrame) => s.els.some((el) => el.attrs.get('data-doop-stage') === 'wireframe')
  if (!design.some(isWire))
    missing.push({ code: 'wireframe_missing', detail: 'no frame has an element with data-doop-stage="wireframe"' })
  else if (design.every(isWire))
    missing.push({ code: 'hifi_missing', detail: 'every frame is a wireframe; a hi-fi frame is required too' })

  /* states: drawn, or marked not applicable with a reason */
  const drawn = new Set(
    designEls.flatMap(({ el }) =>
      el.attrs.has('data-doop-state') ? [str(el.attrs.get('data-doop-state')).toLowerCase()] : [],
    ),
  )
  const notApplicable = new Set<string>()
  for (const { el } of designEls) {
    const v = el.attrs.get('data-doop-state-na')
    if (v === undefined) continue
    const [state = '', ...reason] = v.split(':')
    if (reason.join(':').trim()) notApplicable.add(state.trim().toLowerCase())
  }
  for (const state of REQUIRED_STATES)
    if (!drawn.has(state) && !notApplicable.has(state))
      missing.push({
        code: 'state_missing',
        detail: `state "${state}" is not drawn (add data-doop-state="${state}", or data-doop-state-na="${state}: <reason>")`,
      })

  /* motion: at least one block, each with all five fields */
  const motion = designEls.filter(({ el }) => el.attrs.has('data-doop-motion'))
  if (!motion.length)
    missing.push({ code: 'motion_missing', detail: `no element has data-doop-motion (${MOTION_FIELDS.join(', ')})` })
  for (const { el, frameId } of motion) {
    let block: Record<string, unknown> = {}
    try {
      const parsed: unknown = JSON.parse(el.attrs.get('data-doop-motion')!)
      if (parsed && typeof parsed === 'object') block = parsed as Record<string, unknown>
    } catch {
      /* every field then reads as absent */
    }
    const lacking = MOTION_FIELDS.filter(
      (f) => !str(block[f] ?? (f === 'reducedMotion' ? block['reduced-motion'] : undefined)),
    )
    if (lacking.length)
      missing.push({
        code: 'motion_incomplete',
        frameId,
        detail: `motion block in frame ${frameId} lacks ${lacking.join(', ')}`,
      })
  }

  /* prototype: a start, wiring that lands on a frame of this page, every frame reachable */
  const page = canvasPages(canvas).find((p) => p.id === pageId)
  const byId = new Map(design.map((s) => [s.frame.id, s.frame]))
  const readingOrder = [...design].sort((a, b) => a.frame.y - b.frame.y || a.frame.x - b.frame.x)
  const explicitStart = page?.startFrameId && byId.has(page.startFrameId) ? page.startFrameId : null
  if (!explicitStart)
    missing.push({
      code: 'prototype_start_unset',
      detail: 'the page has no flow start; set it with set_prototype_start',
    })
  const edges = new Map<string, Set<string>>()
  let interactions = 0
  for (const s of design) {
    for (const el of scanInteractions(s.frame.html)) {
      for (const i of el.interactions) {
        interactions++
        if (!targetsFrame(i)) continue
        if (!byId.has(i.target)) {
          missing.push({
            code: 'prototype_target_broken',
            frameId: s.frame.id,
            detail: `${el.label} in frame ${s.frame.id} goes to ${i.target}, which is not a design frame on this page`,
          })
          continue
        }
        if (!edges.has(s.frame.id)) edges.set(s.frame.id, new Set())
        edges.get(s.frame.id)!.add(i.target)
      }
    }
  }
  if (!interactions)
    missing.push({ code: 'prototype_missing', detail: 'no element has data-doop-on / data-doop-action' })
  else {
    const start = explicitStart ?? readingOrder[0]!.frame.id
    const seen = new Set([start])
    const queue = [start]
    for (let id = queue.shift(); id; id = queue.shift()) {
      for (const next of edges.get(id) ?? []) {
        if (seen.has(next)) continue
        seen.add(next)
        queue.push(next)
      }
    }
    for (const s of design)
      if (!seen.has(s.frame.id))
        missing.push({
          code: 'flow_unreachable',
          frameId: s.frame.id,
          detail: `frame ${s.frame.id} ("${s.frame.name}") cannot be reached from the flow start`,
        })
  }

  for (const extra of opts.extraChecks ?? [])
    missing.push(...extra({ canvas, pageId, designFrames: design.map((s) => s.frame) }))

  return report(scanHash)
}

/* ---- attestations ---- */

/** The rows to store for one run: one per design frame, all carrying the page-level result. */
export function attestationRowsFor(
  canvas: Canvas,
  report: CompletenessReport,
  runId: string,
  at: number,
  by: string,
): AttestationRow[] {
  return report.frames.map((f) => ({
    runId,
    canvasId: canvas.id,
    pageId: report.pageId,
    frameId: f.id,
    frameUpdatedAt: f.updatedAt,
    ruleset: report.ruleset,
    scanHash: report.scanHash,
    inputs: report.inputs,
    result: report.complete ? 'complete' : 'incomplete',
    missing: report.missing,
    createdAt: at,
    createdBy: by,
  }))
}

/**
 * The newest complete run that still describes the page: same ruleset, and
 * exactly the page's current design frames, each at the version the run saw.
 * An edit, an added frame or a removed frame ends it, and so does any change to the recon frame, the flow start or the requirement lines. Null means "attest again".
 * G4 reads this from the stored rows, never from comment text.
 */
export function currentAttestation(
  canvas: Canvas,
  pageId: string,
  rows: AttestationRow[],
  /** the requirement hash the source gives now; null when it cannot be read */
  requirementsNow: string | null = null,
): AttestationRow | null {
  const now = new Map(designFrames(canvas, pageId).map((f) => [f.id, f.updatedAt]))
  const inputsNow = attestedInputs(canvas, pageId)
  const runs = new Map<string, AttestationRow[]>()
  for (const row of rows) if (row.pageId === pageId) runs.set(row.runId, [...(runs.get(row.runId) ?? []), row])
  const newestFirst = [...runs.values()].sort((a, b) => b[0]!.createdAt - a[0]!.createdAt)
  for (const run of newestFirst) {
    const head = run[0]!
    if (head.result !== 'complete' || head.ruleset !== COMPLETENESS_RULESET) continue
    if (run.length !== now.size) continue
    if (!sameInputs(head.inputs, inputsNow)) continue
    /* a run that read requirement lines is only current while the source still hashes the same */
    if (typeof head.inputs.requirements === 'string' && head.inputs.requirements !== requirementsNow) continue
    if (run.every((r) => now.get(r.frameId) === r.frameUpdatedAt)) return head
  }
  return null
}
