/* The frame-lint harness (CHE-9115 S2): render one frame at one viewport, collect geometry facts from the DOM, and
   run the pure rules of `shared/frameLint.ts` over them. It reads DOM geometry and computed style only and takes no
   screenshot. A render that does not finish is a `NOT-RUN` result with a reason, never a clean one. */

import type { Page } from 'puppeteer-core'
import { RendererBusyError } from './renderBrowser.ts'
import { LOAD_TIMEOUT_MS, loadFrameInto, withRenderPage } from './screenshot.ts'
import {
  FACT_ELEMENT_CAP,
  FRAME_RULES,
  type AppliedInput,
  type FactElement,
  type FrameFacts,
  type FrameViewportResult,
  type LintFinding,
} from '../shared/frameLint.ts'

/** The most a viewport may hold a render slot: the 8 s load, the settle wait and the collector. */
const LINT_STEP_TIMEOUT_MS = 20_000

export interface LintRenderInput {
  /** `html` is already resolved for the variant's data state */
  frame: { id: string; html: string; width: number; height: number }
  viewport: { width: number; height: number }
  media?: {
    colorScheme?: 'light' | 'dark'
    reducedMotion?: 'reduce' | 'no-preference'
    forcedColors?: 'active' | 'none'
  }
  locale?: { lang: string; dir: 'ltr' | 'rtl' }
  /** root font-size multiplier, 1 = 100% */
  fontScale?: number
}

export interface LintOptions {
  /** run only these rule ids; unset runs every registered frame rule */
  rules?: string[]
  signal: AbortSignal
}

/** What the page-side collector returns, before the harness adds the frame size. */
interface CollectedFacts {
  applied: AppliedInput
  elements: FactElement[]
  capped: boolean
  fonts_fell_back: boolean
}

/** Why a run was aborted: the abort reason `deadline` is the handler's, anything else is the caller leaving. */
function abortedReason(signal: AbortSignal): string {
  return signal.reason === 'deadline' ? 'deadline' : 'aborted'
}

function notRun(viewport: { width: number; height: number }, reason: string, started: number): FrameViewportResult {
  return { ...viewport, status: 'NOT-RUN', reason, ms: Date.now() - started, findings: [] }
}

/** Render one frame in its own page at one viewport and lint it. Never throws: a failure is a `NOT-RUN` result. */
export async function lintFrame(input: LintRenderInput, opts: LintOptions): Promise<FrameViewportResult> {
  const started = Date.now()
  const { viewport } = input
  if (opts.signal.aborted) return notRun(viewport, abortedReason(opts.signal), started)
  try {
    return await withRenderPage(
      'linting the frame',
      LINT_STEP_TIMEOUT_MS,
      async (page) => {
        if (input.media) await page.emulateMediaFeatures(mediaFeatures(input.media))
        const loaded = await loadFrameInto(page, {
          html: input.frame.html,
          width: viewport.width,
          height: viewport.height,
        })
        await applyLocaleAndScale(page, input)
        const result = await runOnPage(page, input.frame, viewport, opts, started)
        if (!loaded && result.status === 'ok') {
          return { ...result, status: 'partial' as const, reason: `load timeout ${LOAD_TIMEOUT_MS}ms` }
        }
        return result
      },
      { priority: 'background', signal: opts.signal, retry: false },
    )
  } catch (error) {
    if (opts.signal.aborted) return notRun(viewport, abortedReason(opts.signal), started)
    if (error instanceof RendererBusyError) return notRun(viewport, 'renderer busy', started)
    return notRun(viewport, `render error: ${error instanceof Error ? error.name : 'unknown'}`, started)
  }
}

/** Lint a page the caller has already set up (a variant state that needs script). The frame is the viewport. */
export async function lintConfiguredPage(
  page: Page,
  meta: { frameId: string; viewport: { width: number; height: number } },
  opts: LintOptions,
): Promise<FrameViewportResult> {
  const started = Date.now()
  if (opts.signal.aborted) return notRun(meta.viewport, abortedReason(opts.signal), started)
  try {
    return await runOnPage(page, meta.viewport, meta.viewport, opts, started)
  } catch (error) {
    if (opts.signal.aborted) return notRun(meta.viewport, abortedReason(opts.signal), started)
    return notRun(meta.viewport, `render error: ${error instanceof Error ? error.name : 'unknown'}`, started)
  }
}

function mediaFeatures(media: NonNullable<LintRenderInput['media']>) {
  return [
    ...(media.colorScheme ? [{ name: 'prefers-color-scheme', value: media.colorScheme }] : []),
    ...(media.reducedMotion ? [{ name: 'prefers-reduced-motion', value: media.reducedMotion }] : []),
    ...(media.forcedColors ? [{ name: 'forced-colors', value: media.forcedColors }] : []),
  ]
}

/** `lang` and `dir` go on `<html>`, and one root font-size rule carries the scale. */
async function applyLocaleAndScale(page: Page, input: LintRenderInput): Promise<void> {
  const { locale, fontScale } = input
  if (!locale && fontScale === undefined) return
  await page.evaluate(
    (lang, dir, scale) => {
      const root = document.documentElement
      if (lang) root.setAttribute('lang', lang)
      if (dir) root.setAttribute('dir', dir)
      if (scale !== null) {
        const style = document.createElement('style')
        style.setAttribute('data-doop-lint', 'font-scale')
        style.textContent = `html{font-size:${scale * 100}% !important}`
        document.head.appendChild(style)
      }
    },
    locale?.lang ?? '',
    locale?.dir ?? '',
    fontScale ?? null,
  )
}

async function runOnPage(
  page: Page,
  frame: { width: number; height: number },
  viewport: { width: number; height: number },
  opts: LintOptions,
  started: number,
): Promise<FrameViewportResult> {
  const collected = await collectFacts(page)
  const facts: FrameFacts = {
    frame: { width: frame.width, height: frame.height },
    viewport: { width: viewport.width, height: viewport.height },
    ...collected,
  }
  const findings = runRules(facts, opts.rules)
  return {
    width: viewport.width,
    height: viewport.height,
    status: collected.capped ? 'partial' : 'ok',
    ...(collected.capped ? { reason: `fact cap ${FACT_ELEMENT_CAP} elements` } : {}),
    ms: Date.now() - started,
    applied: collected.applied,
    findings,
  }
}

/** The registered frame rules over `facts`, optionally narrowed to `ids`. */
export function runRules(facts: FrameFacts, ids?: string[]): LintFinding[] {
  return FRAME_RULES.filter((rule) => !ids || ids.includes(rule.id)).flatMap((rule) => rule.run(facts))
}

async function collectFacts(page: Page): Promise<CollectedFacts> {
  /* tsx/esbuild annotates nested functions with __name; page.evaluate serializes the callback without that helper */
  await page.evaluate('globalThis.__name = (target) => target')
  return page.evaluate((cap: number): CollectedFacts => {
    const SKIP = new Set(['HEAD', 'SCRIPT', 'STYLE', 'META', 'LINK', 'TITLE', 'NOSCRIPT', 'TEMPLATE', 'BASE'])
    const root = document.documentElement
    const selectorOf = (el: Element): string => {
      const id = el.getAttribute('data-doop-id')
      if (id) return `[data-doop-id="${id.replace(/["\\]/g, '\\$&')}"]`
      const parts: string[] = []
      for (let node: Element | null = el; node && node !== root; node = node.parentElement) {
        const tag = node.tagName.toLowerCase()
        const same = node.parentElement
          ? Array.from(node.parentElement.children).filter((c) => c.tagName === node!.tagName)
          : []
        parts.unshift(same.length > 1 ? `${tag}:nth-of-type(${same.indexOf(node) + 1})` : tag)
      }
      return parts.join(' > ')
    }
    const indexOf = new Map<Element, number>()
    const clippedBy = new Map<Element, boolean>()
    const elements: Array<{
      tag: string
      doop_id?: string
      selector: string
      rect: { x: number; y: number; width: number; height: number }
      parent: number
      clipped_y: boolean
    }> = []
    let capped = false
    const nearestRecorded = (el: Element): number => {
      for (let node = el.parentElement; node; node = node.parentElement) {
        const found = indexOf.get(node)
        if (found !== undefined) return found
      }
      return -1
    }
    const all = document.body ? [document.body, ...Array.from(document.body.querySelectorAll('*'))] : []
    for (const el of all) {
      const parent = el.parentElement
      const style = getComputedStyle(el)
      /* an ancestor below body that clips the vertical overflow of its content; a fixed box escapes it */
      const parentClips = parent && parent !== document.body && parent !== root ? clippedBy.get(parent) === true : false
      const ownClip = el !== document.body && style.overflowY !== 'visible'
      clippedBy.set(el, parentClips || ownClip)
      const clippedAbove = style.position === 'fixed' ? false : parentClips
      if (SKIP.has(el.tagName) || style.display === 'none' || el.closest('svg') !== el.closest('svg:not(svg svg)'))
        continue
      if (elements.length >= cap) {
        capped = true
        break
      }
      const rect = el.getBoundingClientRect()
      indexOf.set(el, elements.length)
      const doopId = el.getAttribute('data-doop-id')
      elements.push({
        tag: el.tagName.toLowerCase(),
        ...(doopId ? { doop_id: doopId } : {}),
        selector: selectorOf(el),
        rect: { x: rect.left + scrollX, y: rect.top + scrollY, width: rect.width, height: rect.height },
        parent: nearestRecorded(el),
        clipped_y: clippedAbove,
      })
    }
    const rootSize = parseFloat(getComputedStyle(root).fontSize) || 16
    let fontsFellBack = false
    document.fonts.forEach((face) => {
      if (face.status === 'error') fontsFellBack = true
    })
    return {
      applied: {
        colorScheme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
        lang: root.getAttribute('lang') ?? '',
        dir: getComputedStyle(root).direction === 'rtl' ? 'rtl' : 'ltr',
        fontScale: rootSize / 16,
      },
      elements,
      capped,
      fonts_fell_back: fontsFellBack,
    }
  }, FACT_ELEMENT_CAP)
}
