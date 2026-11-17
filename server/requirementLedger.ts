import { createHash } from 'node:crypto'
import { scanElements, type CheckContext, type El, type Missing } from '../shared/designCompleteness.ts'
import { pageFrames } from '../shared/pages.ts'

/**
 * L1 of the minimap mechanism (CHE-6078 addendum A1r2, CHE-6373; built in
 * CHE-6629): the requirement ledger, one more row of the G3 completeness check.
 *
 * Source = the non-empty lines of the issue description and of every comment a
 * MEMBER wrote. Each line has an id `<commentId8>#<n>:<sha1(line)[:8]>`, so
 * editing a line changes its id and a new line is a missing one. The designer
 * writes a ledger (`<script type="application/json" id="doop-reqledger">`,
 * `{ "<id>": { "d": "map" | "ctx" | "defer", "reason": "…" } }`); the check
 * blocks a line that has no entry, an entry that names no line, a `d` that is
 * not exactly one of the three (fail closed), a `map` with no design element
 * carrying `data-req-ref="<id>"`, and a `ctx`/`defer` without a reason.
 *
 * It checks that an element with the ref EXISTS, never that it is drawn well:
 * that stays the reviewer's check against the table G3 already asks for.
 */

export interface SourceComment {
  id: string
  authorType: string
  content: string
}
export interface RequirementLine {
  id: string
  text: string
}
export interface DeferredLine {
  id: string
  text: string
  reason: string
}
export interface LedgerReport {
  missing: Missing[]
  /** `defer` lines: printed on the decision card for Cheese */
  deferred: DeferredLine[]
  /** every `ctx` and `defer` line with its reason, for the reviewer's table */
  notes: string[]
}

export const LEDGER_ID = 'doop-reqledger'
export const DISPOSITIONS = ['map', 'ctx', 'defer'] as const
type Disposition = (typeof DISPOSITIONS)[number]

const sha1 = (text: string) => createHash('sha1').update(text).digest('hex').slice(0, 8)
const clip = (text: string) => (text.length > 80 ? `${text.slice(0, 79)}…` : text)

function* splitLines(content: string): Generator<string> {
  for (const raw of content.split(/\r?\n/)) {
    const text = raw.trim()
    if (text) yield text
  }
}

/** The source lines, in order: the description first, then each member comment. Agent and system text is never a source. */
export function requirementLines(description: string | null, comments: SourceComment[]): RequirementLine[] {
  const out: RequirementLine[] = []
  const add = (prefix: string, content: string) => {
    let n = 0
    for (const text of splitLines(content)) out.push({ id: `${prefix}#${n++}:${sha1(text)}`, text })
  }
  if (description) add('desc', description)
  for (const c of comments) if (c.authorType === 'member') add(c.id.slice(0, 8), c.content)
  return out
}

/** One hash over the source lines; the attestation stores it, and a changed source ends the attestation. */
export function requirementsHash(lines: RequirementLine[]): string {
  return createHash('sha256')
    .update(JSON.stringify(lines.map((l) => [l.id, l.text])))
    .digest('hex')
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

const disposition = (entry: unknown): Disposition | null =>
  isObject(entry) && typeof entry.d === 'string' && (DISPOSITIONS as readonly string[]).includes(entry.d)
    ? (entry.d as Disposition)
    : null

const reasonOf = (entry: unknown) => (isObject(entry) && typeof entry.reason === 'string' ? entry.reason.trim() : '')

/** The ledger the page carries: undefined when absent, or the problem when it cannot be read. */
function readLedger(ctx: CheckContext): { ledger?: Record<string, unknown>; problem?: string } {
  const scripts: El[] = pageFrames(ctx.canvas, ctx.pageId).flatMap((frame) =>
    scanElements(frame.html).filter((el) => el.tag === 'script' && el.attrs.get('id') === LEDGER_ID),
  )
  if (!scripts.length) return {}
  if (scripts.length > 1) return { problem: `${scripts.length} <script id="${LEDGER_ID}"> blocks; keep exactly one` }
  let parsed: unknown
  try {
    parsed = JSON.parse(scripts[0]!.body ?? '')
  } catch {
    return { problem: `<script id="${LEDGER_ID}"> is not valid JSON` }
  }
  if (!isObject(parsed)) return { problem: `<script id="${LEDGER_ID}"> must hold an object keyed by line id` }
  return { ledger: parsed }
}

export function ledgerReport(lines: RequirementLine[], ctx: CheckContext): LedgerReport {
  const report: LedgerReport = { missing: [], deferred: [], notes: [] }
  const { ledger, problem } = readLedger(ctx)
  if (problem) {
    report.missing.push({ code: 'req_ledger_invalid', detail: problem })
    return report
  }
  if (!ledger && !lines.length) return report
  if (!ledger)
    report.missing.push({
      code: 'req_ledger_missing',
      detail: `${lines.length} requirement line(s) from Cheese and no <script type="application/json" id="${LEDGER_ID}"> on the page`,
    })
  const has = (id: string) => !!ledger && Object.hasOwn(ledger, id)
  const refs = new Set(
    ctx.designFrames.flatMap((f) => scanElements(f.html).flatMap((el) => el.attrs.get('data-req-ref') ?? [])),
  )
  const where = (l: RequirementLine) => `requirement line [${l.id}] "${clip(l.text)}"`

  for (const l of lines) {
    if (!has(l.id)) {
      report.missing.push({ code: 'req_missing', detail: `${where(l)} has no entry in the ledger` })
      continue
    }
    const entry = ledger![l.id]
    const d = disposition(entry)
    if (!d) {
      report.missing.push({
        code: 'req_bad_disposition',
        detail: `${where(l)} needs d to be exactly one of ${DISPOSITIONS.join(' | ')}`,
      })
    } else if (d === 'map') {
      if (!refs.has(l.id))
        report.missing.push({
          code: 'req_no_element',
          detail: `${where(l)} is mapped but no design element has data-req-ref="${l.id}"`,
        })
    } else {
      const reason = reasonOf(entry)
      if (!reason) {
        report.missing.push({ code: 'req_bad_reason', detail: `${where(l)} is ${d} without a reason` })
        continue
      }
      report.notes.push(`${where(l)} is ${d}: ${reason}`)
      if (d === 'defer') report.deferred.push({ id: l.id, text: l.text, reason })
    }
  }
  if (ledger) {
    const known = new Set(lines.map((l) => l.id))
    for (const id of Object.keys(ledger))
      if (!known.has(id))
        report.missing.push({
          code: 'req_unknown',
          detail: `ledger entry [${id}] is not a line of the issue or its member comments`,
        })
  }
  return report
}

/** The extra check G3 runs: the ledger row. */
export function requirementLedgerCheck(lines: RequirementLine[]): (ctx: CheckContext) => Missing[] {
  return (ctx) => ledgerReport(lines, ctx).missing
}

export interface RequirementsNow {
  issue: string
  hash: string
}

/**
 * Does a stored run still describe the requirement source? Only a run that read
 * the lines (hash and issue both recorded) of the same issue at the same hash.
 * A legacy run, a run that never checked the ledger, a rebind to another issue
 * with identical lines, and an unreadable source all fail closed (Terra P1, 4585a23).
 */
export function requirementsStillHold(
  inputs: { requirements?: string | null; requirementsIssue?: string | null },
  now: RequirementsNow | null,
): boolean {
  if (typeof inputs.requirements !== 'string' || typeof inputs.requirementsIssue !== 'string') return false
  return !!now && now.issue === inputs.requirementsIssue && now.hash === inputs.requirements
}
