/* The bounded `fl-r1` result envelope and the keyset walk (CHE-9115 S3a, plan r6 "Response bound and
   continuation"). Pure code: no browser, no MCP. Every size is measured on the serialized text, escapes
   included, so the reply never passes `max_bytes` whatever the page holds. */

export const FRAME_LINT_RULESET = 'fl-r1'
export const FRAME_LINT_MAX_RESPONSE_BYTES = 120_000
export const ENVELOPE_RESERVE_BYTES = 12_000
export const ROW_MAX_BYTES = 32_000
export const ROW_BASE_MAX_BYTES = 4_000
export const WINDOW_SIZE = 24
export const FRAME_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/
export const AFTER_PATTERN = /^\d{1,16}:[A-Za-z0-9_-]{1,64}$/

export const STRING_CAPS = {
  frame_name: 120,
  message: 200,
  selector: 200,
  doop_id: 120,
  reason: 160,
  rule: 64,
} as const

export const NOT_COVERED = [
  'hallmark:34',
  'hallmark:40 (CHE-9135)',
  'hallmark:48',
  'hallmark:73',
  'hallmark:75 (CHE-9135)',
  'hallmark:26a',
  'hallmark:F25',
] as const

export interface LintLimits {
  max_bytes: number
  max_rows: number
  max_findings_per_rule_per_row: number
  max_findings_per_row: number
  row_max_bytes: number
  envelope_reserve_bytes: number
}

export const DEFAULT_LIMITS: LintLimits = {
  max_bytes: FRAME_LINT_MAX_RESPONSE_BYTES,
  max_rows: WINDOW_SIZE,
  max_findings_per_rule_per_row: 20,
  max_findings_per_row: 40,
  row_max_bytes: ROW_MAX_BYTES,
  envelope_reserve_bytes: ENVELOPE_RESERVE_BYTES,
}

export type FindingLevel = 'error' | 'warn' | 'info'
export type RowStatus = 'ok' | 'partial' | 'NOT-RUN'
export type RowPageRules = 'ok' | 'skipped' | 'NOT-RUN'
export type PageScope = 'all frames' | 'all frames except skipped' | 'NOT-RUN'

export interface LintFinding {
  rule: string
  level: FindingLevel
  viewport?: { width: number; height: number }
  element?: { doop_id?: string; selector?: string }
  message: string
}

export interface ViewportResult {
  width: number
  height: number
  status: string
  ms: number
}

/** One row as the harness reports it, before any cap. */
export interface LintRowInput {
  frame_id: string
  frame_name: string
  created_at: number | null
  updated_at: number | null
  status: RowStatus
  reason?: string
  viewports: ViewportResult[]
  findings: LintFinding[]
  page_findings: LintFinding[]
}

export interface LintRow {
  frame_id: string
  frame_name: string
  created_at: number | null
  updated_at: number | null
  status: RowStatus
  page_rules: RowPageRules
  reason?: string
  viewports: ViewportResult[]
  findings: LintFinding[]
  page_findings: LintFinding[]
  truncated: Record<string, number>
}

export interface PageScanInput {
  scope: PageScope
  reason: string | null
  frames_scanned: number
  chars_scanned: number
  ms: number
  skipped: Array<{ frame_id: string; reason: string }>
  /** Full page-rule counts over the whole page; ignored when scope is NOT-RUN. */
  by_rule: Record<string, number>
}

export interface FrameKey {
  id: string
  createdAt: number
}

export interface WindowFrame {
  id: string
  /** null: the id is not on the page. */
  createdAt: number | null
}

export interface LintWindow {
  mode: 'page' | 'ids'
  after: string | null
  frames_on_page: number
  frames: WindowFrame[]
  frames_before: number
  frames_after: number
  not_on_page: number
}

export interface AssembleMeta {
  canvas_id?: string
  page_id?: string
  deadline_ms?: number
  elapsed_ms?: number
}

export interface LintResult {
  ruleset: typeof FRAME_LINT_RULESET
  canvas_id: string
  page_id: string
  blocking: false
  deadline_ms: number
  elapsed_ms: number
  page_complete: boolean
  page_rules: {
    scope: PageScope
    reason: string | null
    frames_on_page: number
    frames_scanned: number
    chars_scanned: number
    ms: number
    skipped: Array<{ frame_id: string; reason: string }>
    skipped_count: number
  }
  window: {
    mode: 'page' | 'ids'
    after: string | null
    frames_on_page: number
    rows: number
    frames_before: number
    frames_after: number
    not_on_page: number
  }
  frames: LintRow[]
  omitted: { not_reached: number; rows_byte_cap: number; findings: number; strings_cut: number }
  retry_frame_ids: string[]
  next: { after: string } | { frame_ids: string[] } | null
  limits: LintLimits
  summary: {
    by_rule: Record<string, number>
    frames_ok: number
    frames_not_run: number
    coverage: {
      render_ok: number
      render_not_run: number
      page_rules_ok: number
      page_rules_skipped: number
      page_rules_not_run: number
    }
  }
  not_covered: readonly string[]
}

export interface AssembledLintResult {
  result: LintResult
  /** `head + rows.join(',') + tail`, the exact reply text. */
  text: string
  bytes: number
  parts: { head: string; rows: string[]; tail: string; envelopeBytes: number }
}

export class FrameLintInputError extends Error {
  readonly code = 'input'
}

export function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value))
}

const ELLIPSIS = '…'
const ELLIPSIS_BYTES = 3
/** Rule names are registry-bound; this only keeps a hostile `by_rule` or `truncated` map inside the envelope. */
const MAX_RULE_KEYS = 32
const OTHER_RULES = 'other'
const MAX_SKIPPED_LISTED = 10
const MAX_RETRY_IDS = 24
const MAX_VIEWPORTS = 4
const ID_CAP = 64
const VIEWPORT_STATUS_CAP = 32

/** Escaped bytes one code point takes inside a JSON string, without the quotes. */
function escapedBytes(codePoint: number): number {
  if (codePoint < 0x20)
    return codePoint === 8 || (codePoint >= 9 && codePoint <= 10) || codePoint === 12 || codePoint === 13 ? 2 : 6
  if (codePoint === 0x22 || codePoint === 0x5c) return 2
  if (codePoint < 0x80) return 1
  if (codePoint < 0x800) return 2
  if (codePoint >= 0xd800 && codePoint <= 0xdfff) return 6 // a lone surrogate is written as \udXXX
  return codePoint < 0x10000 ? 3 : 4
}

/** Cut on a code point so that `jsonBytes(value) - 2 <= maxEscapedBytes`, ending in `…` when it cut. One pass,
 *  at most `maxEscapedBytes + 1` code points, whatever the input length. */
export function cutString(value: string, maxEscapedBytes: number): { value: string; cut: boolean } {
  const bodyLimit = maxEscapedBytes - ELLIPSIS_BYTES
  let used = 0
  let bodyEnd = 0
  for (let i = 0; i < value.length;) {
    const codePoint = value.codePointAt(i)!
    const width = codePoint > 0xffff ? 2 : 1
    used += escapedBytes(codePoint)
    if (used > maxEscapedBytes) return { value: value.slice(0, bodyEnd) + ELLIPSIS, cut: true }
    i += width
    if (used <= bodyLimit) bodyEnd = i
  }
  return { value, cut: false }
}

interface Tally {
  cuts: number
}

function capped(value: string, cap: number, tally: Tally): string {
  const out = cutString(value, cap)
  if (out.cut) tally.cuts++
  return out.value
}

type RuleKey = (rule: string) => { value: string; cut: boolean }

function ruleKeyMemo(): RuleKey {
  const memo = new Map<string, { value: string; cut: boolean }>()
  return (rule) => {
    let hit = memo.get(rule)
    if (!hit) {
      hit = cutString(rule, STRING_CAPS.rule)
      memo.set(rule, hit)
    }
    return hit
  }
}

function foldRuleCounts(counts: ReadonlyMap<string, number>, keyOf: RuleKey): Record<string, number> {
  const out = new Map<string, number>()
  for (const [rule, n] of counts) {
    let key = keyOf(rule).value
    if (!out.has(key) && out.size >= MAX_RULE_KEYS) key = OTHER_RULES
    out.set(key, (out.get(key) ?? 0) + n)
  }
  return Object.fromEntries(out)
}

function cutCount(counts: ReadonlyMap<string, number>, keyOf: RuleKey): number {
  let n = 0
  for (const rule of counts.keys()) if (keyOf(rule).cut) n++
  return n
}

function addCount(counts: Map<string, number>, rule: string, by = 1): void {
  counts.set(rule, (counts.get(rule) ?? 0) + by)
}

interface Candidate {
  finding: LintFinding
  page: boolean
  bytes: number
  cuts: number
}

function cutFinding(f: LintFinding, page: boolean): Candidate {
  const tally: Tally = { cuts: 0 }
  // key order is the wire order: rule, level, viewport, element, message
  const rule = capped(f.rule, STRING_CAPS.rule, tally)
  const element = f.element && {
    ...(f.element.doop_id === undefined ? {} : { doop_id: capped(f.element.doop_id, STRING_CAPS.doop_id, tally) }),
    ...(f.element.selector === undefined ? {} : { selector: capped(f.element.selector, STRING_CAPS.selector, tally) }),
  }
  const finding: LintFinding = {
    rule,
    level: f.level,
    ...(f.viewport ? { viewport: { width: f.viewport.width, height: f.viewport.height } } : {}),
    ...(element ? { element } : {}),
    message: capped(f.message, STRING_CAPS.message, tally),
  }
  return { finding, page, bytes: jsonBytes(finding), cuts: tally.cuts }
}

/** One row, every string cut and the findings grown one at a time up to `row_max_bytes` of measured text.
 *  A render `NOT-RUN` row carries no findings; a row whose page rules did not run carries no page findings. */
export function buildRow(
  input: LintRowInput,
  pageRules: RowPageRules,
  limits: LintLimits = DEFAULT_LIMITS,
): { row: LintRow; text: string; bytes: number; strings_cut: number; findings_dropped: number } {
  const tally: Tally = { cuts: 0 }
  const keyOf = ruleKeyMemo()
  const row: LintRow = {
    frame_id: input.frame_id,
    frame_name: capped(input.frame_name, STRING_CAPS.frame_name, tally),
    created_at: input.created_at,
    updated_at: input.updated_at,
    status: input.status,
    page_rules: pageRules,
    ...(input.reason === undefined ? {} : { reason: capped(input.reason, STRING_CAPS.reason, tally) }),
    viewports: input.viewports.slice(0, MAX_VIEWPORTS).map((v) => ({
      width: v.width,
      height: v.height,
      status: capped(v.status, VIEWPORT_STATUS_CAP, tally),
      ms: v.ms,
    })),
    findings: [],
    page_findings: [],
    truncated: {},
  }

  // 1. count caps: 20 per rule, 40 per row. Only a finding that passes is cut and measured.
  const capDropped = new Map<string, number>()
  const perRule = new Map<string, number>()
  const candidates: Candidate[] = []
  const consider = (list: readonly LintFinding[], page: boolean) => {
    for (const f of list) {
      const n = perRule.get(f.rule) ?? 0
      if (n >= limits.max_findings_per_rule_per_row || candidates.length >= limits.max_findings_per_row) {
        addCount(capDropped, f.rule)
        continue
      }
      perRule.set(f.rule, n + 1)
      candidates.push(cutFinding(f, page))
    }
  }
  consider(input.status === 'NOT-RUN' ? [] : input.findings, false)
  consider(pageRules === 'NOT-RUN' ? [] : input.page_findings, true)

  // 2. byte cap: the longest prefix of candidates whose exact row size, truncated map included, fits.
  const truncatedWhenStoppingAt = (stop: number) => {
    const counts = new Map(capDropped)
    for (let i = stop; i < candidates.length; i++) addCount(counts, candidates[i]!.finding.rule)
    return counts
  }
  const baseBytes = jsonBytes(row) // empty arrays and an empty truncated map
  let kept = 0
  let findingsBytes = 0
  let nFindings = 0
  let nPage = 0
  const sizeIf = (count: number, bytes: number, nF: number, nP: number) =>
    baseBytes +
    bytes +
    Math.max(nF - 1, 0) +
    Math.max(nP - 1, 0) +
    jsonBytes(foldRuleCounts(truncatedWhenStoppingAt(count), keyOf)) -
    2
  for (; kept < candidates.length; kept++) {
    const next = candidates[kept]!
    const nF = nFindings + (next.page ? 0 : 1)
    const nP = nPage + (next.page ? 1 : 0)
    if (sizeIf(kept + 1, findingsBytes + next.bytes, nF, nP) > limits.row_max_bytes) break
    findingsBytes += next.bytes
    nFindings = nF
    nPage = nP
  }
  for (let i = 0; i < kept; i++) {
    const c = candidates[i]!
    ;(c.page ? row.page_findings : row.findings).push(c.finding)
    tally.cuts += c.cuts
  }
  const dropped = truncatedWhenStoppingAt(kept)
  row.truncated = foldRuleCounts(dropped, keyOf)
  tally.cuts += cutCount(dropped, keyOf)
  let findingsDropped = 0
  for (const n of dropped.values()) findingsDropped += n

  const text = JSON.stringify(row)
  return { row, text, bytes: Buffer.byteLength(text), strings_cut: tally.cuts, findings_dropped: findingsDropped }
}

function compareKeys(a: FrameKey, b: FrameKey): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

function frameKey(frame: { id: string; createdAt: number | null }): string {
  return `${frame.createdAt}:${frame.id}`
}

/** Walk order is `(createdAt, id)`, not paint order: `createdAt` never changes when a frame is brought to front.
 *  Copies only the two key fields, so a name on the input is never held. */
export function walkOrder(frames: readonly FrameKey[]): FrameKey[] {
  return frames.map((frame) => ({ id: frame.id, createdAt: frame.createdAt })).sort(compareKeys)
}

export function parseAfter(after: string): FrameKey {
  if (typeof after !== 'string' || !AFTER_PATTERN.test(after)) {
    throw new FrameLintInputError('after must look like "<createdAt>:<frameId>"')
  }
  const split = after.indexOf(':')
  const createdAt = Number(after.slice(0, split))
  if (!Number.isSafeInteger(createdAt)) throw new FrameLintInputError('after has a createdAt that is too large')
  return { createdAt, id: after.slice(split + 1) }
}

/** The first `size` frames strictly after `after` (the whole page when null). `after` may name a deleted frame. */
export function windowAfter(order: readonly FrameKey[], after: FrameKey | null, size = WINDOW_SIZE): LintWindow {
  let start = 0
  if (after) {
    let hi = order.length
    while (start < hi) {
      const mid = (start + hi) >>> 1
      if (compareKeys(order[mid]!, after) <= 0) start = mid + 1
      else hi = mid
    }
  }
  const frames: WindowFrame[] = order.slice(start, start + size).map((f) => ({ id: f.id, createdAt: f.createdAt }))
  return {
    mode: 'page',
    after: after ? frameKey(after) : null,
    frames_on_page: order.length,
    frames,
    frames_before: start,
    frames_after: order.length - start - frames.length,
    not_on_page: 0,
  }
}

/** The requested ids in walk order, duplicates removed; ids that are not on the page follow, in request order. */
export function windowByIds(order: readonly FrameKey[], ids: readonly string[], size = WINDOW_SIZE): LintWindow {
  if (ids.length === 0) throw new FrameLintInputError('frame_ids must name at least one frame')
  if (ids.length > size) throw new FrameLintInputError(`frame_ids takes at most ${size} ids`)
  for (const id of ids) {
    if (typeof id !== 'string' || !FRAME_ID_PATTERN.test(id))
      throw new FrameLintInputError('frame_ids holds a malformed id')
  }
  const wanted = new Set(ids)
  const frames: WindowFrame[] = order.filter((f) => wanted.has(f.id)).map((f) => ({ id: f.id, createdAt: f.createdAt }))
  const present = new Set(frames.map((f) => f.id))
  const missing: WindowFrame[] = [...wanted].filter((id) => !present.has(id)).map((id) => ({ id, createdAt: null }))
  return {
    mode: 'ids',
    after: null,
    frames_on_page: order.length,
    frames: [...frames, ...missing],
    frames_before: 0,
    frames_after: 0,
    not_on_page: missing.length,
  }
}

export function resolveWindow(
  order: readonly FrameKey[],
  input: { after?: string; frame_ids?: readonly string[] },
  size = WINDOW_SIZE,
): LintWindow {
  if (input.after !== undefined && input.frame_ids !== undefined) {
    throw new FrameLintInputError('after and frame_ids cannot be used together')
  }
  if (input.frame_ids !== undefined) return windowByIds(order, input.frame_ids, size)
  return windowAfter(order, input.after === undefined ? null : parseAfter(input.after), size)
}

/** The window's first frame as a row, for a harness that returned none: progress never depends on it. */
function placeholderRow(frame: WindowFrame): LintRowInput {
  return {
    frame_id: frame.id,
    frame_name: '',
    created_at: frame.createdAt,
    updated_at: null,
    status: 'NOT-RUN',
    reason: frame.createdAt === null ? 'not on page' : 'deadline',
    viewports: [],
    findings: [],
    page_findings: [],
  }
}

function entries(parts: Record<string, unknown>): string {
  return Object.entries(parts)
    .map(([key, value]) => `${JSON.stringify(key)}:${JSON.stringify(value)}`)
    .join(',')
}

/**
 * Assemble the reply from the harness rows (one per window frame, in window order, a prefix of it). The text is
 * `head + rows.join(',') + tail`; rows are added in window order and stop before the row that would pass
 * `max_bytes - envelope_reserve_bytes`. The first row always fits, so `next` always moves the walk forward.
 * A frame that is not a returned row is only a count: it is never serialized.
 */
export function assembleLintResult(
  window: LintWindow,
  rows: readonly LintRowInput[],
  pageScan: PageScanInput,
  limits: LintLimits = DEFAULT_LIMITS,
  meta: AssembleMeta = {},
): AssembledLintResult {
  const frames = window.frames
  if (rows.length > frames.length) throw new Error('assembleLintResult: more rows than window frames')
  const inputs = rows.length === 0 && frames.length > 0 ? [placeholderRow(frames[0]!)] : rows
  inputs.forEach((row, i) => {
    if (row.frame_id !== frames[i]!.id) throw new Error(`assembleLintResult: row ${i} is not window frame ${i}`)
  })
  const considered = Math.min(inputs.length, limits.max_rows)
  const scanRan = pageScan.scope !== 'NOT-RUN'
  const skipped = new Set(pageScan.skipped.map((s) => s.frame_id))
  const pageRulesAt = (i: number): RowPageRules => {
    if (frames[i]!.createdAt === null || !scanRan) return 'NOT-RUN'
    return skipped.has(inputs[i]!.frame_id) ? 'skipped' : 'ok'
  }

  // Full per-rule counts over every considered row, also the rows the byte cap drops. Counting never serializes.
  const keyOf = ruleKeyMemo()
  const ruleCounts = new Map<string, number>()
  for (let i = 0; i < considered; i++) {
    const row = inputs[i]!
    if (row.status === 'NOT-RUN') continue
    for (const f of row.findings) addCount(ruleCounts, f.rule)
  }
  if (scanRan) for (const [rule, n] of Object.entries(pageScan.by_rule)) addCount(ruleCounts, rule, n)

  const rowBudget = limits.max_bytes - limits.envelope_reserve_bytes
  const built: Array<ReturnType<typeof buildRow>> = []
  let rowBytes = 0
  for (let i = 0; i < considered; i++) {
    const next = buildRow(inputs[i]!, pageRulesAt(i), limits)
    const added = next.bytes + (built.length > 0 ? 1 : 0)
    if (built.length > 0 && rowBytes + added > rowBudget) break
    rowBytes += added
    built.push(next)
  }
  const k = built.length
  const returned = built.map((b) => b.row)

  const tally: Tally = { cuts: 0 }
  for (const b of built) tally.cuts += b.strings_cut
  const byRule = foldRuleCounts(ruleCounts, keyOf)
  tally.cuts += cutCount(ruleCounts, keyOf)

  const coverage = { render_ok: 0, render_not_run: 0, page_rules_ok: 0, page_rules_skipped: 0, page_rules_not_run: 0 }
  const retry: string[] = []
  for (const [i, row] of returned.entries()) {
    if (row.status === 'NOT-RUN') coverage.render_not_run++
    else coverage.render_ok++
    if (row.page_rules === 'ok') coverage.page_rules_ok++
    else if (row.page_rules === 'skipped') coverage.page_rules_skipped++
    else coverage.page_rules_not_run++
    const worthRetry = (row.status === 'NOT-RUN' || row.page_rules === 'NOT-RUN') && frames[i]!.createdAt !== null
    if (worthRetry && retry.length < MAX_RETRY_IDS) retry.push(row.frame_id)
  }

  const rest = frames.slice(k)
  const lastReturned = frames[k - 1]
  const next: LintResult['next'] =
    window.mode === 'ids'
      ? rest.length > 0
        ? { frame_ids: rest.map((f) => f.id) }
        : null
      : rest.length === 0 && window.frames_after === 0
        ? null
        : { after: frameKey(lastReturned!) }

  const pageComplete =
    window.mode === 'page' &&
    window.after === null &&
    window.frames_after === 0 &&
    k === frames.length &&
    pageScan.scope === 'all frames' &&
    returned.every((row) => row.status !== 'NOT-RUN')

  const before = {
    ruleset: FRAME_LINT_RULESET as typeof FRAME_LINT_RULESET,
    canvas_id: capped(meta.canvas_id ?? '', ID_CAP, tally),
    page_id: capped(meta.page_id ?? '', ID_CAP, tally),
    blocking: false as const,
    deadline_ms: meta.deadline_ms ?? 0,
    elapsed_ms: meta.elapsed_ms ?? 0,
    page_complete: pageComplete,
    page_rules: {
      scope: pageScan.scope,
      reason: pageScan.reason === null ? null : capped(pageScan.reason, STRING_CAPS.reason, tally),
      frames_on_page: window.frames_on_page,
      frames_scanned: pageScan.frames_scanned,
      chars_scanned: pageScan.chars_scanned,
      ms: pageScan.ms,
      skipped: pageScan.skipped.slice(0, MAX_SKIPPED_LISTED).map((s) => ({
        frame_id: capped(s.frame_id, ID_CAP, tally),
        reason: capped(s.reason, STRING_CAPS.reason, tally),
      })),
      skipped_count: pageScan.skipped.length,
    },
    window: {
      mode: window.mode,
      after: window.after,
      frames_on_page: window.frames_on_page,
      rows: k,
      frames_before: window.frames_before,
      frames_after: window.frames_after,
      not_on_page: window.not_on_page,
    },
  }
  const after = {
    omitted: {
      not_reached: frames.length - considered,
      rows_byte_cap: considered - k,
      findings: built.reduce((sum, b) => sum + b.findings_dropped, 0),
      strings_cut: tally.cuts,
    },
    retry_frame_ids: retry,
    next,
    limits: { ...limits },
    summary: {
      by_rule: byRule,
      frames_ok: coverage.render_ok,
      frames_not_run: coverage.render_not_run,
      coverage,
    },
    not_covered: NOT_COVERED,
  }

  const head = `{${entries(before)},"frames":[`
  const tail = `],${entries(after)}}`
  const rowTexts = built.map((b) => b.text)
  const text = head + rowTexts.join(',') + tail
  const result: LintResult = { ...before, frames: returned, ...after }
  return {
    result,
    text,
    bytes: Buffer.byteLength(text),
    parts: { head, rows: rowTexts, tail, envelopeBytes: Buffer.byteLength(head) + Buffer.byteLength(tail) },
  }
}
