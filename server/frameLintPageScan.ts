/* The whole-page rule scan (CHE-9115 S3p, plan r6 "What a filtered, capped or partial run concludes"): page rules
   (repeated markup, states) read the HTML of every frame on a page with parse5 and conclude over all of it, or
   conclude nothing. Whole page or nothing, on every call, whatever `frame_ids` or `after` the caller gave:
   - the input is chosen by size only: a frame over `maxFrameChars`, or one whose facts pass a rule's per-frame cap,
     is `skipped` and named; a page input over `maxPageChars` is `NOT-RUN` before any parse;
   - parse5 cannot be interrupted, so time only cancels: a scan that passes its budget stops, drops every collected
     fact and is `NOT-RUN deadline`, so no finding ever comes from a part of the page;
   - one frame per turn of the event loop, so the renders that run at the same time are not starved.
   Nothing is cached: the next call scans the whole page again. Pure server code; no browser, no store. */

import type { PageFinding, PageFrameInput, PageRule } from '../shared/frameLint.ts'
import type { LintFinding, PageScanInput } from '../shared/frameLintResult.ts'

export interface ScanFrame {
  id: string
  html: string
  hidden?: boolean
}

export interface ScanOptions {
  /** ms the scan may run, from its first line */
  budgetMs: number
  maxFrameChars: number
  maxPageChars: number
  signal?: AbortSignal
}

/** `PageScanInput` for the assembler, plus the findings filed under the frame each belongs to. */
export type PageScan = PageScanInput & { findings: Map<string, LintFinding[]> }

const turn = () => new Promise<void>((resolve) => setImmediate(resolve))

export async function scanPage(
  frames: readonly ScanFrame[],
  rules: readonly PageRule[],
  options: ScanOptions,
): Promise<PageScan> {
  const started = performance.now()
  const skipped: PageScanInput['skipped'] = []
  const tooBig = new Set<ScanFrame>()
  let chars = 0
  for (const frame of frames) {
    if (frame.html.length > options.maxFrameChars) {
      skipped.push({ frame_id: frame.id, reason: `html over ${options.maxFrameChars} chars` })
      tooBig.add(frame)
    } else {
      chars += frame.html.length
    }
  }
  const notRun = (reason: string): PageScan => ({
    scope: 'NOT-RUN',
    reason,
    frames_scanned: 0,
    chars_scanned: 0,
    ms: Math.round(performance.now() - started),
    skipped,
    by_rule: {},
    findings: new Map(),
  })
  const stopped = () => options.signal?.aborted === true || performance.now() - started >= options.budgetMs

  if (chars > options.maxPageChars) return notRun(`page over ${options.maxPageChars} chars`)

  /* collect: one frame per turn, every rule on it */
  const collected: Array<{ frame: ScanFrame; facts: unknown[] | null }> = []
  for (const frame of frames) {
    if (tooBig.has(frame)) {
      collected.push({ frame, facts: null })
      continue
    }
    if (stopped()) return notRun('deadline')
    let facts: unknown[] | null = null
    try {
      const all = rules.map((rule) => rule.collect(frame.html))
      if (rules.some((rule, i) => rule.over?.(all[i]))) {
        skipped.push({ frame_id: frame.id, reason: 'facts over cap' })
      } else {
        facts = all
      }
    } catch {
      skipped.push({ frame_id: frame.id, reason: 'rule failed' })
    }
    collected.push({ frame, facts })
    await turn()
  }
  if (stopped()) return notRun('deadline')

  /* evaluate over every collected fact; a skipped frame is passed with `facts: null`, counted and never clean */
  const findings = new Map<string, LintFinding[]>()
  const byRule: Record<string, number> = {}
  for (const [index, rule] of rules.entries()) {
    const inputs: PageFrameInput[] = collected.map(({ frame, facts }) => ({
      frame_id: frame.id,
      ...(frame.hidden ? { hidden: true } : {}),
      facts: facts ? facts[index] : null,
    }))
    let out: PageFinding[]
    try {
      out = rule.evaluate(inputs)
    } catch {
      return notRun('rule failed')
    }
    for (const { frame_id, ...finding } of out) {
      const list = findings.get(frame_id) ?? []
      list.push(finding)
      findings.set(frame_id, list)
      byRule[finding.rule] = (byRule[finding.rule] ?? 0) + 1
    }
    await turn()
    if (stopped()) return notRun('deadline')
  }

  const scanned = collected.filter(({ facts }) => facts)
  return {
    scope: skipped.length > 0 ? 'all frames except skipped' : 'all frames',
    reason: null,
    frames_scanned: scanned.length,
    chars_scanned: scanned.reduce((sum, { frame }) => sum + frame.html.length, 0),
    ms: Math.round(performance.now() - started),
    skipped,
    by_rule: byRule,
    findings,
  }
}
