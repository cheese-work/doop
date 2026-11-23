/* The `lint_frames` run (CHE-9115 S3, plan r6 "Riskiest flow trace"): render the frames of one window, two at a
   time, in the background lane of the renderer, under ONE absolute deadline. The result is built only by the S3a
   assembler, so its size does not depend on the page. Warning mode: nothing here blocks a gate, a publish or a lock. */

import { pageFrames } from '../shared/pages.ts'
import type { Canvas } from '../shared/types.ts'
import type { FrameViewportResult } from '../shared/frameLint.ts'
import {
  DEFAULT_LIMITS,
  WINDOW_SIZE,
  assembleLintResult,
  resolveWindow,
  walkOrder,
  type AssembledLintResult,
  type LintRowInput,
  type PageScanInput,
  type WindowFrame,
} from '../shared/frameLintResult.ts'
import { lintFrame } from './frameLint.ts'

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

/** What the page-rule scan reports until S3p wires it. */
const PAGE_SCAN_NOT_WIRED: PageScanInput = {
  scope: 'NOT-RUN',
  reason: 'not wired',
  frames_scanned: 0,
  chars_scanned: 0,
  ms: 0,
  skipped: [],
  by_rule: {},
}

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

  try {
    await Promise.race([Promise.all(Array.from({ length: PARALLEL_FRAMES }, worker)), giveUp])
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
  const meta = { canvas_id: input.canvas.id, page_id: input.pageId, deadline_ms: deadline, elapsed_ms: Date.now() - t0 }
  return assembleLintResult(window, rows, PAGE_SCAN_NOT_WIRED, DEFAULT_LIMITS, meta)
}
