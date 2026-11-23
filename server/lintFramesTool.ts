/* The `lint_frames` run (CHE-9115 S3, plan r6 "Riskiest flow trace"): render the frames of one window, two at a
   time, in the background lane of the renderer, under ONE absolute deadline. The result is built only by the S3a
   assembler, so its size does not depend on the page. Warning mode: nothing here blocks a gate, a publish or a lock. */

import { pageFrames } from '../shared/pages.ts'
import type { Canvas } from '../shared/types.ts'
import { PAGE_RULES, type FrameViewportResult } from '../shared/frameLint.ts'
import {
  DEFAULT_LIMITS,
  WINDOW_SIZE,
  assembleLintResult,
  resolveWindow,
  walkOrder,
  type AssembledLintResult,
  type LintResult,
  type LintRowInput,
  type WindowFrame,
} from '../shared/frameLintResult.ts'
import { lintFrame } from './frameLint.ts'
import { scanPage, type PageScan } from './frameLintPageScan.ts'

/** The whole call, from the first line of the handler to the reply. The SDK's default request timeout is 60 s. */
export const FRAME_LINT_DEADLINE_MS = 45_000
/** Frames rendered at the same time; the gate admits two background pages at most. */
const PARALLEL_FRAMES = 2
/** The second viewport of every frame, plan "lint_frames v1". */
const NARROW_VIEWPORT_WIDTH = 320

/* Where the three moments sit inside the deadline, as fractions of it: 40 s, 43 s and 44 s of 45 s. */
const STOP_SCHEDULING = 40 / 45
const ABORT_IN_FLIGHT = 43 / 45
const GIVE_UP_WAITING = 44 / 45

let deadlineOverride: number | null = null

/** Test hook: the only way the deadline changes. `null` restores the 45 s. */
export function setFrameLintDeadlineForTest(ms: number | null): void {
  deadlineOverride = ms
}

let scanBudgetOverride: number | null = null

/** Test hook: the page-rule scan budget in ms, counted from T0. `null` restores one third of the deadline. */
export function setFrameLintPageScanBudgetForTest(ms: number | null): void {
  scanBudgetOverride = ms
}

export interface LintFramesInput {
  canvas: Canvas
  pageId: string
  after?: string
  frame_ids?: readonly string[]
  /** when the call began (the handler's first line); the deadline counts from here, not from this function */
  startedAt?: number
  /** the MCP request's own signal: the client leaving aborts the same controller as the deadline */
  signal?: AbortSignal
}

/** Size limits of the whole-page rule scan (plan S3p): a frame over the first is skipped, a page over the second is
 *  not scanned. Both are by size alone, never by time. */
export const PAGE_SCAN_MAX_FRAME_CHARS = 1_500_000
export const PAGE_SCAN_MAX_PAGE_CHARS = 10_000_000
/** The scan stops at T0 + this fraction of the deadline: 15 s of 45 s. */
const PAGE_SCAN_BUDGET = 15 / 45

/** What the call reports when the scan did not finish by the time the reply is due. */
const pageScanTimedOut = (): PageScan => ({
  scope: 'NOT-RUN',
  reason: 'deadline',
  frames_scanned: 0,
  chars_scanned: 0,
  ms: 0,
  skipped: [],
  by_rule: {},
  findings: new Map(),
})

interface FrameSource {
  id: string
  name: string
  html: string
  width: number
  height: number
  createdAt: number
  updatedAt: number
}

function row(frame: WindowFrame, source: FrameSource | undefined, partial: Partial<LintRowInput>): LintRowInput {
  return {
    frame_id: frame.id,
    frame_name: source?.name ?? '',
    created_at: frame.createdAt,
    updated_at: source?.updatedAt ?? null,
    status: 'NOT-RUN',
    viewports: [],
    findings: [],
    page_findings: [],
    ...partial,
  }
}

/** A frame is covered only when every viewport finished: one that did not makes the row `NOT-RUN`, so it is retried. */
function merge(frame: WindowFrame, source: FrameSource, outs: FrameViewportResult[]): LintRowInput {
  const notRun = outs.find((o) => o.status === 'NOT-RUN')
  const partial = outs.find((o) => o.status === 'partial')
  const worst = notRun ?? partial
  return row(frame, source, {
    status: notRun ? 'NOT-RUN' : partial ? 'partial' : 'ok',
    ...(worst?.reason ? { reason: worst.reason } : {}),
    viewports: outs.map(({ width, height, status, ms }) => ({ width, height, status, ms })),
    findings: outs.flatMap((o) => o.findings),
  })
}

async function lintOne(frame: WindowFrame, source: FrameSource, signal: AbortSignal): Promise<LintRowInput> {
  const sizes = [{ width: source.width, height: source.height }]
  if (Math.round(source.width) !== NARROW_VIEWPORT_WIDTH) {
    sizes.push({ width: NARROW_VIEWPORT_WIDTH, height: source.height })
  }
  const outs: FrameViewportResult[] = []
  for (const viewport of sizes) {
    outs.push(
      await lintFrame(
        { frame: { id: source.id, html: source.html, width: source.width, height: source.height }, viewport },
        { signal },
      ),
    )
  }
  return merge(frame, source, outs)
}

/** The properties of the PostHog event `frame_lint_run` (S8): counts and timing only. No frame name, HTML, text or
 *  selector goes in, and no frame id: the rule ids in `by_rule` are the registered rule names. */
export function frameLintRunProperties(result: LintResult): Record<string, unknown> {
  return {
    ruleset: result.ruleset,
    frames_on_page: result.window.frames_on_page,
    rows: result.window.rows,
    frames_ok: result.summary.frames_ok,
    frames_not_run: result.summary.frames_not_run,
    page_complete: result.page_complete,
    by_rule: { ...result.summary.by_rule },
    omitted: { ...result.omitted },
    ms: result.elapsed_ms,
  }
}

const isDeadlineRow = (r: LintRowInput) => r.status === 'NOT-RUN' && (r.reason === 'deadline' || r.reason === 'aborted')

/** Lint one window of a page and return the assembled `fl-r1` reply. Throws `FrameLintInputError` for bad input. */
export async function runLintFrames(input: LintFramesInput): Promise<AssembledLintResult> {
  const t0 = input.startedAt ?? Date.now()
  const deadline = deadlineOverride ?? FRAME_LINT_DEADLINE_MS
  const frames = pageFrames(input.canvas, input.pageId)
  const window = resolveWindow(walkOrder(frames), { after: input.after, frame_ids: input.frame_ids }, WINDOW_SIZE)
  const wanted = new Set(window.frames.map((f) => f.id))
  const sources = new Map<string, FrameSource>()
  for (const f of frames) if (wanted.has(f.id)) sources.set(f.id, f)

  /* The page scan reads every frame on the page, whatever the window: a conclusion over a part of the page is none. */
  const scanBudget = scanBudgetOverride ?? deadline * PAGE_SCAN_BUDGET
  const byId = new Map(frames.map((f) => [f.id, f]))
  const scanFrames = walkOrder(frames).map(({ id }) => byId.get(id)!)

  const controller = new AbortController()
  const onClientGone = () => controller.abort('client')
  if (input.signal?.aborted) onClientGone()
  else input.signal?.addEventListener('abort', onClientGone, { once: true })
  const stopAt = t0 + deadline * STOP_SCHEDULING
  /* every timer is set against T0, so setup time already spent is not added on top of the deadline */
  const untilT0 = (fraction: number) => Math.max(0, t0 + deadline * fraction - Date.now())
  const abortTimer = setTimeout(() => controller.abort('deadline'), untilT0(ABORT_IN_FLIGHT))
  let giveUpTimer: ReturnType<typeof setTimeout> | undefined
  const giveUp = new Promise<void>((resolve) => {
    giveUpTimer = setTimeout(resolve, untilT0(GIVE_UP_WAITING))
  })

  const results: Array<LintRowInput | undefined> = new Array(window.frames.length)
  const started: boolean[] = new Array(window.frames.length).fill(false)
  let next = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      if (controller.signal.aborted || Date.now() >= stopAt) return
      const i = next++
      const frame = window.frames[i]
      if (!frame) return
      started[i] = true
      const source = sources.get(frame.id)
      results[i] = source
        ? await lintOne(frame, source, controller.signal)
        : row(frame, undefined, { reason: 'not on page' })
    }
  }

  /* started with the renders, not after them; it stops itself at T0 + its budget */
  const scanning = scanPage(scanFrames, PAGE_RULES, {
    budgetMs: Math.max(0, t0 + scanBudget - Date.now()),
    maxFrameChars: PAGE_SCAN_MAX_FRAME_CHARS,
    maxPageChars: PAGE_SCAN_MAX_PAGE_CHARS,
    signal: controller.signal,
  })
  let scan: PageScan | null = null
  try {
    await Promise.race([Promise.all(Array.from({ length: PARALLEL_FRAMES }, worker)), giveUp])
    scan = await Promise.race([scanning, giveUp.then(() => null)])
  } finally {
    clearTimeout(abortTimer)
    clearTimeout(giveUpTimer)
    input.signal?.removeEventListener('abort', onClientGone)
    controller.abort('deadline')
  }

  /* Rows are a prefix of the window. It ends at the first frame the deadline cut: the frames after it may have
     finished, but `next` resumes after the last row, so showing them would leave a gap behind the retry. */
  const rows: LintRowInput[] = []
  for (const [i, frame] of window.frames.entries()) {
    const done = results[i] ?? (started[i] ? row(frame, sources.get(frame.id), { reason: 'deadline' }) : undefined)
    if (!done) break
    rows.push(done)
    if (isDeadlineRow(done)) break
  }
  scan ??= pageScanTimedOut()
  for (const r of rows) r.page_findings = scan.findings.get(r.frame_id) ?? []
  const meta = { canvas_id: input.canvas.id, page_id: input.pageId, deadline_ms: deadline, elapsed_ms: Date.now() - t0 }
  return assembleLintResult(window, rows, scan, DEFAULT_LIMITS, meta)
}
