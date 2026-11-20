import { canvasPages, pageFrames } from './pages.ts'
import { PROTO_ATTRS, parseInteractions, readAttributes, scanInteractions, targetsFrame } from './prototype.ts'
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
export const COMPLETENESS_RULESET = 'g3-r7'

export const MOTION_PAGE_NAME = 'Motion'
export const COMPONENTS_PAGE_NAME = 'Components'
/** The Hallmark `sloplint` revision g3-r7 accepts (CHE-6854), static tier, `--json`, no browser flags. */
export const SLOPLINT_SHA = '407fa689f4a276f2fd389208d271d0fef08f5058'
export const COMPONENT_STATES = ['default', 'hover', 'focus', 'disabled', 'loading', 'error'] as const
/** Token groups the Components page defines as CSS variables, with the name prefixes that count for each. */
export const TOKEN_GROUPS = {
  color: ['color-'],
  type: ['type-', 'font-'],
  spacing: ['space-', 'spacing-'],
  radius: ['radius-'],
} as const
export const REQUIRED_STATES = ['loading', 'empty', 'error', 'disconnected'] as const
export const MOTION_FIELDS = ['trigger', 'property', 'duration', 'easing', 'reducedMotion'] as const
export const DOC_HEADINGS = [
  'Purpose',
  'UX reasoning',
  'UI reasoning',
  'Ergonomics',
  'States',
  'Motion',
  'Accessibility',
] as const
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

export interface MotionInput {
  pageId: string
  name: string
  frames: { id: string; name: string; updatedAt: number; hidden: boolean }[]
}

/** One sloplint result for a design frame at a version. `sha256` is the digest of the result JSON the reviewer sent; `NOT-RUN` is a frame with no usable result. */
export interface SloplintEntry {
  frameId: string
  updatedAt: number
  toolSha: string
  sha256: string
  status: 'ok' | 'NOT-RUN'
  /** the verified `sloplint --json` text the digest vouches for; absent on a NOT-RUN entry */
  resultJson?: string
}

export interface AttestedInputs {
  recon: { id: string; updatedAt: number }[]
  start: string | null
  /** the Motion page (g3-r6) and each of its frames at the version, name and visibility the run saw; a change to any ends the attestation */
  motion?: MotionInput | null
  /** the Components page, the same way (g3-r7) */
  components?: MotionInput | null
  /** the sloplint results the run read, for the design frames (g3-r7) */
  sloplint?: SloplintEntry[]
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
  /** the Multica key of the page's issue (CHE-123); without it the Motion page cannot be named */
  issueKey?: string | null
  /** sloplint results the caller vouches for (the server checks their digests); none means every frame is missing one */
  sloplint?: SloplintEntry[]
  /** the canvas's component definitions: a main or instance carries its component's id, so this is how the name is read */
  components?: { id: string; name: string }[]
  extraChecks?: ((ctx: CheckContext) => Missing[])[]
}

/* ---- reading frame HTML without a DOM ---- */

export interface El {
  tag: string
  attrs: Map<string, string>
  /** script and style bodies only */
  body?: string
  /** where the tag starts, and where its `>` is, in the HTML */
  pos: number
  openEnd: number
}

export function scanElements(html: string): El[] {
  const out: El[] = []
  const tagRe = /<!--[\s\S]*?-->|<(script|style)(?=[\s/>])|<([a-z][\w:-]*)/gi
  let m: RegExpExecArray | null
  while ((m = tagRe.exec(html))) {
    const raw = m[1] ?? m[2]
    if (!raw) continue
    const { attrs, end } = readAttributes(html, m.index + raw.length + 1)
    const el: El = { tag: raw.toLowerCase(), attrs, pos: m.index, openEnd: end === -1 ? html.length : end }
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
  return {
    recon,
    start: canvasPages(canvas).find((p) => p.id === pageId)?.startFrameId ?? null,
    motion: pageInput(canvas, MOTION_PAGE_NAME),
    components: pageInput(canvas, COMPONENTS_PAGE_NAME),
  }
}

/** A named page and each of its frames at the version, name and visibility the run saw. */
function pageInput(canvas: Canvas, name: string): MotionInput | null {
  const page = canvasPages(canvas).find((p) => p.name === name)
  return page
    ? {
        pageId: page.id,
        name: page.name,
        frames: pageFrames(canvas, page.id)
          .map((f) => ({ id: f.id, name: f.name, updatedAt: f.updatedAt, hidden: !!f.hidden }))
          .sort((a, b) => a.id.localeCompare(b.id)),
      }
    : null
}

const sameMotion = (a: MotionInput | null | undefined, b: MotionInput | null) =>
  !a || !b
    ? !a && !b
    : a.pageId === b.pageId &&
      a.name === b.name &&
      a.frames.length === b.frames.length &&
      a.frames.every((f, i) => {
        const g = b.frames[i]
        /* field by field: Postgres jsonb does not keep key order, so a stringified compare would never match a stored row */
        return f.id === g?.id && f.name === g.name && f.updatedAt === g.updatedAt && f.hidden === g.hidden
      })

const sameInputs = (a: AttestedInputs, b: AttestedInputs) =>
  a.start === b.start &&
  sameMotion(a.motion, b.motion ?? null) &&
  sameMotion(a.components, b.components ?? null) &&
  a.recon.length === b.recon.length &&
  a.recon.every((r, i) => r.id === b.recon[i]?.id && r.updatedAt === b.recon[i]?.updatedAt)

/* ---- the check ---- */

/* ---- g3-r6: motion page, spec rows and screen docs (CHE-6853) ---- */

const DOC_SUFFIX = ' · doc'
const isDocFrame = (f: Frame) => f.name.endsWith(DOC_SUFFIX)

const plainText = (html: string) =>
  html
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .trim()

/** Heading text to the trimmed text under it, up to the next heading. Script and style bodies are ignored; the first of a repeated heading wins. */
function docSections(html: string): Map<string, string> {
  const clean = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, '')
  const parts = clean.split(/<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]\s*>/i)
  const out = new Map<string, string>()
  for (let i = 1; i < parts.length; i += 2) {
    const name = plainText(parts[i]!)
      .toLowerCase()
      .replace(/[:.\s]+$/, '')
    if (!out.has(name)) out.set(name, plainText(parts[i + 1] ?? ''))
  }
  return out
}

/** Nothing, or only TBD, TODO, an ellipsis or a dash. */
const isPlaceholder = (text: string) => text === '' || /^(tbd|todo|\.{3}|…|[-–—])[\s.:]*$/i.test(text)

/** The last cell of each body row of the motion spec table: the animated frame, by id or name. */
function specRows(html: string): string[] {
  const clean = html.replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, '')
  const rows: string[] = []
  for (const [, row = ''] of clean.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/gi)) {
    const cells = [...row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td\s*>/gi)]
    if (cells.length) rows.push(plainText(cells[cells.length - 1]![1] ?? ''))
  }
  return rows
}

/** True when the frame has @keyframes, or an animation or transition with a duration above zero. */
function animates(els: El[]): boolean {
  const css = els.flatMap((el) => [el.body, el.attrs.get('style')]).join('\n')
  if (/@keyframes\b/i.test(css)) return true
  for (const [, , , value = ''] of css.matchAll(/\b(animation|transition)(-duration)?\s*:\s*([^;}]*)/gi))
    for (const [, n = '0'] of value.matchAll(/(?:^|[\s,(])(\d*\.?\d+)(?:ms|s)\b/gi)) if (Number(n) > 0) return true
  return false
}

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '')

/** The motion fields a `data-doop-motion` value lacks; an unreadable value lacks them all. */
function lackingFields(raw: string) {
  let block: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed && typeof parsed === 'object') block = parsed as Record<string, unknown>
  } catch {
    /* every field then reads as absent */
  }
  return MOTION_FIELDS.filter((f) => !str(block[f] ?? (f === 'reducedMotion' ? block['reduced-motion'] : undefined)))
}

export function checkPageCompleteness(canvas: Canvas, pageId: string, opts: CheckOptions = {}): CompletenessReport {
  const scanned = scanPage(canvas, pageId)
  const design = scanned.filter(isDesign)
  /* a doc frame is attested with the page but is not a screen: no wireframe, flow or doc rule applies to it */
  const screens = design.filter((s) => !isDocFrame(s.frame))
  const missing: Missing[] = []
  const frames = design.map((s) => ({ id: s.frame.id, updatedAt: s.frame.updatedAt }))
  const report = (scanHash: string | null = null): CompletenessReport => ({
    pageId,
    ruleset: COMPLETENESS_RULESET,
    scanHash,
    complete: missing.length === 0,
    missing,
    frames,
    inputs: {
      ...attestedInputs(canvas, pageId, scanned),
      ...(opts.sloplint ? { sloplint: opts.sloplint.filter((e) => frames.some((f) => f.id === e.frameId)) } : {}),
    },
    reviewerNotes: [REVIEWER_NOTE],
  })

  if (!screens.length) {
    missing.push({ code: 'no_design_frames', detail: 'the page has no design frame besides the recon frame' })
    return report()
  }
  const designEls = screens.flatMap((s) => s.els.map((el) => ({ el, frameId: s.frame.id })))

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
  if (!screens.some(isWire))
    missing.push({ code: 'wireframe_missing', detail: 'no frame has an element with data-doop-stage="wireframe"' })
  else if (screens.every(isWire))
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
    const lacking = lackingFields(el.attrs.get('data-doop-motion')!)
    if (lacking.length)
      missing.push({
        code: 'motion_incomplete',
        frameId,
        detail: `motion block in frame ${frameId} lacks ${lacking.join(', ')}`,
      })
  }

  /* g3-r6 1: every transition has a complete block on its element or in its frame */
  const complete = (el: El) =>
    el.attrs.has('data-doop-motion') && !lackingFields(el.attrs.get('data-doop-motion')!).length
  for (const s of screens) {
    const frameCovered = s.els.some(complete)
    for (const el of s.els) {
      if (frameCovered || complete(el)) continue
      const moves = parseInteractions({
        on: el.attrs.get(PROTO_ATTRS.on),
        action: el.attrs.get(PROTO_ATTRS.action),
        transition: el.attrs.get(PROTO_ATTRS.transition),
        duration: el.attrs.get(PROTO_ATTRS.duration),
        interactions: el.attrs.get(PROTO_ATTRS.interactions),
      }).filter((i) => i.transition !== 'instant')
      if (moves.length)
        missing.push({
          code: 'motion_per_transition',
          frameId: s.frame.id,
          detail: `<${el.tag}${el.attrs.has('id') ? ` id="${el.attrs.get('id')}"` : ''}> in frame ${s.frame.id} has a ${moves[0]!.transition} transition and no complete data-doop-motion (${MOTION_FIELDS.join(', ')}) on it or in its frame`,
        })
    }
  }

  /* g3-r6 2 and 4: the Motion page, the issue's spec frame, and an animated frame per spec row */
  const specName = `${opts.issueKey ?? '<ISSUE-KEY>'} · motion`
  const motionPage = canvasPages(canvas).find((p) => p.name === MOTION_PAGE_NAME)
  const motionFrames = motionPage ? pageFrames(canvas, motionPage.id).filter((f) => !f.hidden) : []
  const spec = opts.issueKey ? motionFrames.find((f) => f.name === specName) : undefined
  if (!spec)
    missing.push({
      code: 'motion_page_missing',
      detail: !opts.issueKey
        ? 'the page has no issue key (it is not bound to a Multica issue), so the frame "<ISSUE-KEY> · motion" on the Motion page cannot be looked for'
        : `no visible frame "${specName}" on a page named Motion`,
    })
  else {
    const rows = specRows(spec.html)
    if (!rows.length)
      missing.push({
        code: 'motion_frame_missing',
        frameId: spec.id,
        detail: `"${specName}" has no spec row (a table row whose last cell names the animated frame)`,
      })
    for (const ref of rows) {
      const target = motionFrames.find((f) => f.id === ref || f.name === ref)
      if (!target)
        missing.push({
          code: 'motion_frame_missing',
          frameId: spec.id,
          detail: `spec row names the animated frame "${ref}", which is not a visible frame on the Motion page`,
        })
      else if (!animates(scanElements(target.html)))
        missing.push({
          code: 'motion_frame_missing',
          frameId: target.id,
          detail: `animated frame "${ref}" holds no @keyframes, and no animation or transition with a duration above zero`,
        })
    }
  }

  /* g3-r6 3: every hi-fi screen has a doc frame with the 7 headings filled */
  for (const s of screens) {
    if (isWire(s)) continue
    const docName = `${s.frame.name}${DOC_SUFFIX}`
    const doc = design.find((d) => d.frame.name === docName)
    if (!doc) {
      missing.push({
        code: 'screen_doc_missing',
        frameId: s.frame.id,
        detail: `hi-fi frame ${s.frame.id} has no doc frame "${docName}" on its page`,
      })
      continue
    }
    const sections = docSections(doc.frame.html)
    for (const h of DOC_HEADINGS) {
      const text = sections.get(h.toLowerCase())
      if (text === undefined)
        missing.push({
          code: 'screen_doc_missing',
          frameId: s.frame.id,
          detail: `"${docName}" lacks the heading "${h}"`,
        })
      else if (isPlaceholder(text))
        missing.push({
          code: 'screen_doc_missing',
          frameId: s.frame.id,
          detail: `"${docName}" has no text under "${h}" (empty or a placeholder)`,
        })
    }
  }

  /* prototype: a start, wiring that lands on a frame of this page, every frame reachable */
  const page = canvasPages(canvas).find((p) => p.id === pageId)
  const byId = new Map(screens.map((s) => [s.frame.id, s.frame]))
  const readingOrder = [...screens].sort((a, b) => a.frame.y - b.frame.y || a.frame.x - b.frame.x)
  const explicitStart = page?.startFrameId && byId.has(page.startFrameId) ? page.startFrameId : null
  if (!explicitStart)
    missing.push({
      code: 'prototype_start_unset',
      detail: 'the page has no flow start; set it with set_prototype_start',
    })
  const edges = new Map<string, Set<string>>()
  let interactions = 0
  for (const s of screens) {
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
    for (const s of screens)
      if (!seen.has(s.frame.id))
        missing.push({
          code: 'flow_unreachable',
          frameId: s.frame.id,
          detail: `frame ${s.frame.id} ("${s.frame.name}") cannot be reached from the flow start`,
        })
  }

  missing.push(...sloplintFindings(design, opts.sloplint ?? []))
  missing.push(...componentFindings(canvas, design, spec, opts.issueKey ? specName : null, opts.components))

  for (const extra of opts.extraChecks ?? [])
    missing.push(...extra({ canvas, pageId, designFrames: design.map((s) => s.frame) }))

  return report(scanHash)
}

/* ---- g3-r7: sloplint per frame version, and references to the Components page (CHE-6854) ---- */

/** One finding for each design frame without an `ok` result from the pinned sloplint at the frame's current version. */
function sloplintFindings(design: ScannedFrame[], results: SloplintEntry[]): Missing[] {
  const out: Missing[] = []
  for (const { frame } of design) {
    const own = results.filter((r) => r.frameId === frame.id)
    const current = own.find((r) => r.updatedAt === frame.updatedAt)
    const why = !current
      ? own.length
        ? `only for an older version of the frame (it is at ${frame.updatedAt})`
        : 'none sent'
      : current.status === 'NOT-RUN'
        ? 'NOT-RUN'
        : current.toolSha !== SLOPLINT_SHA
          ? `from sloplint ${current.toolSha || '(no sha)'}, not the pinned ${SLOPLINT_SHA}`
          : !current.sha256
            ? 'with no sha256 of the result'
            : ''
    if (why)
      out.push({
        code: 'sloplint_missing',
        frameId: frame.id,
        detail: `frame ${frame.id} ("${frame.name}") has no sloplint result at version ${frame.updatedAt}: ${why}`,
      })
  }
  return out
}

const VOID_TAGS = new Set('area base br col embed hr img input link meta source track wbr'.split(' '))

/** Where the element's markup ends: its closing tag, or its own tag for a void element. */
function elementEnd(html: string, el: El): number {
  if (VOID_TAGS.has(el.tag) || html[el.openEnd - 1] === '/') return el.openEnd + 1
  const re = new RegExp(`<(/?)${el.tag}(?=[\\s/>])`, 'gi')
  re.lastIndex = el.openEnd + 1
  let depth = 1
  for (let m = re.exec(html); m; m = re.exec(html)) {
    depth += m[1] ? -1 : 1
    if (!depth) return m.index
  }
  return html.length
}

interface Component {
  name: string
  frameId: string
  /** the component's own element and everything inside it */
  els: El[]
}

type ComponentNames = ReadonlyMap<string, string>

/** A main (`data-doop-component`) or an instance (`data-doop-instance`): both name their component by id, or by name in a hand-written frame. */
function componentsIn({ frame, els }: ScannedFrame, names: ComponentNames): Component[] {
  return els
    .filter((el) => el.attrs.has('data-doop-component') || el.attrs.has('data-doop-instance'))
    .map((root) => {
      const end = elementEnd(frame.html, root)
      const ref = str(root.attrs.get('data-doop-component') ?? root.attrs.get('data-doop-instance'))
      return {
        name: names.get(ref) ?? ref,
        frameId: frame.id,
        els: els.filter((e) => e.pos >= root.pos && e.pos < end),
      }
    })
}

const tokenVars = (els: El[]) =>
  new Set(
    els
      .flatMap((el) => [el.body, el.attrs.get('style')])
      .flatMap((css) => [...(css ?? '').matchAll(/(?:^|[\s;{])--([\w-]+)\s*:/g)].map((m) => m[1]!.toLowerCase())),
  )

const normName = (s: string) => s.replace(/\s+/g, ' ').trim()

/** The first cell of each body row of the motion spec table: the name of what animates. */
function specNames(html: string): Set<string> {
  const clean = html.replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, '')
  const out = new Set<string>()
  for (const [, row = ''] of clean.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/gi)) {
    const cell = /<td\b[^>]*>([\s\S]*?)<\/td\s*>/i.exec(row)
    if (cell) out.add(normName(plainText(cell[1] ?? '')))
  }
  return out
}

/** Rules 2 to 4 of g3-r7: the Components page, what its components show, and the motion of each micro-interaction. */
function componentFindings(
  canvas: Canvas,
  design: ScannedFrame[],
  spec: Frame | undefined,
  specName: string | null,
  components: CheckOptions['components'] = [],
): Missing[] {
  const out: Missing[] = []
  const compNames: ComponentNames = new Map(components.map((c) => [c.id, c.name]))
  const page = canvasPages(canvas).find((p) => p.name === COMPONENTS_PAGE_NAME)
  const pageFramesVisible = page ? pageFrames(canvas, page.id).filter((f) => !f.hidden) : []
  const scanned = pageFramesVisible.map((frame) => ({ frame, els: scanElements(frame.html), isRecon: false }))
  const library = scanned.flatMap((s) => componentsIn(s, compNames)).filter((c) => c.name)

  /* components_page_missing: the page, a tokens frame with each group, and at least one component */
  const pageMissing = (detail: string) => out.push({ code: 'components_page_missing', detail })
  if (!page) pageMissing(`the canvas has no page named ${COMPONENTS_PAGE_NAME}`)
  else {
    const tokenFrames = scanned.filter((s) => s.els.some((el) => el.attrs.has('data-doop-tokens')))
    if (!tokenFrames.length) pageMissing(`the ${COMPONENTS_PAGE_NAME} page has no visible frame with data-doop-tokens`)
    else {
      const vars = tokenVars(tokenFrames.flatMap((s) => s.els))
      for (const [group, prefixes] of Object.entries(TOKEN_GROUPS))
        if (![...vars].some((v) => prefixes.some((p) => v.startsWith(p))))
          pageMissing(
            `the data-doop-tokens frame defines no ${group} token (a CSS variable --${prefixes.join('* or --')}*)`,
          )
    }
    if (!library.length)
      pageMissing(`the ${COMPONENTS_PAGE_NAME} page has no visible component (data-doop-component="<name>")`)
  }

  /* component_unknown: every component a design frame uses is on the page (nothing to compare against when it has none) */
  const known = new Set(library.map((c) => c.name))
  if (known.size)
    for (const s of design) {
      const unknown = new Set(
        componentsIn(s, compNames)
          .map((c) => c.name)
          .filter((n) => !known.has(n)),
      )
      for (const name of unknown)
        out.push({
          code: 'component_unknown',
          frameId: s.frame.id,
          detail: `frame ${s.frame.id} uses data-doop-component="${name}", which is not on the ${COMPONENTS_PAGE_NAME} page`,
        })
    }

  /* component_states_missing: variants and the six states, across every instance of a component */
  const shown = new Map<string, { variants: boolean; states: Set<string> }>()
  for (const c of library) {
    const entry = shown.get(c.name) ?? { variants: false, states: new Set<string>() }
    for (const el of c.els) {
      if (str(el.attrs.get('data-doop-variant'))) entry.variants = true
      if (el.attrs.has('data-doop-state')) entry.states.add(str(el.attrs.get('data-doop-state')).toLowerCase())
      const [state = '', ...reason] = (el.attrs.get('data-doop-state-na') ?? '').split(':')
      if (reason.join(':').trim()) entry.states.add(state.trim().toLowerCase())
    }
    shown.set(c.name, entry)
  }
  for (const [name, entry] of shown) {
    const lacking = [
      ...(entry.variants ? [] : ['a variant (data-doop-variant)']),
      ...COMPONENT_STATES.filter((st) => !entry.states.has(st)).map((st) => `state ${st}`),
    ]
    if (lacking.length)
      out.push({
        code: 'component_states_missing',
        detail: `component "${name}" lacks ${lacking.join(', ')} (data-doop-state="<state>", or data-doop-state-na="<state>: <reason>")`,
      })
  }

  /* motion_per_micro_interaction: each non-default component state, and each data-doop-interaction in a design frame */
  const micro: { name: string; el: El; frameId: string }[] = []
  for (const s of scanned) {
    const owner = new Map<El, Component>()
    for (const c of componentsIn(s, compNames)) for (const el of c.els) owner.set(el, c)
    for (const el of s.els) {
      const state = str(el.attrs.get('data-doop-state')).toLowerCase()
      const c = owner.get(el)
      if (state && state !== 'default' && c?.name) micro.push({ name: `${c.name} · ${state}`, el, frameId: s.frame.id })
    }
  }
  for (const s of design)
    for (const el of s.els)
      if (str(el.attrs.get('data-doop-interaction')))
        micro.push({ name: normName(str(el.attrs.get('data-doop-interaction'))), el, frameId: s.frame.id })
  const names = spec && specName ? specNames(spec.html) : null
  const rowless = new Set<string>()
  for (const { name, el, frameId } of micro) {
    if (str(el.attrs.get('data-doop-motion-na'))) {
      /* a stated reason stands in for the block */
    } else if (!el.attrs.has('data-doop-motion'))
      out.push({
        code: 'motion_per_micro_interaction',
        frameId,
        detail: `micro-interaction "${name}" in frame ${frameId} has no data-doop-motion (${MOTION_FIELDS.join(', ')}) and no data-doop-motion-na="<reason>"`,
      })
    else {
      const lacking = lackingFields(el.attrs.get('data-doop-motion')!)
      if (lacking.length)
        out.push({
          code: 'motion_per_micro_interaction',
          frameId,
          detail: `micro-interaction "${name}" in frame ${frameId} has a motion block that lacks ${lacking.join(', ')}`,
        })
    }
    if (names && !names.has(name) && !rowless.has(name)) {
      rowless.add(name)
      out.push({
        code: 'motion_per_micro_interaction',
        frameId,
        detail: `micro-interaction "${name}" has no row in "${specName}" (the first cell of a row is its name)`,
      })
    }
  }
  return out
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
