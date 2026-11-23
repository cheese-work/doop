/* The frame-lint harness (CHE-9115 S2): render one frame at one viewport, collect geometry facts from the DOM, and
   run the pure rules of `shared/frameLint.ts` over them. It reads DOM geometry and computed style only and takes no
   screenshot. A render that does not finish is a `NOT-RUN` result with a reason, never a clean one. */

import type { Page } from 'puppeteer-core'
import { RendererBusyError } from './renderBrowser.ts'
import { LOAD_TIMEOUT_MS, loadFrameInto, withRenderPage } from './screenshot.ts'
import {
  AXE_RULE_IDS,
  AXE_TARGET_RULE_ID,
  FACT_COLOR_CAP,
  FACT_ELEMENT_CAP,
  FRAME_RULES,
  type AppliedInput,
  type FactColor,
  type FactControlKind,
  type AxeFact,
  type FactElement,
  type FactRect,
  type FactRef,
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

/** The axe-core script, read once from the installed package. axe-core is MPL-2.0, used unmodified and loaded from
 *  `node_modules`: no copy of it lives in this repo. It is injected with `page.evaluate`, so no network request is
 *  made and the frame's own CSP does not apply. */
let axeSource: Promise<string> | undefined
function loadAxeSource(): Promise<string> {
  axeSource ??= import('axe-core').then((mod) => (mod.default ?? mod).source)
  return axeSource
}

/** What the page-side collector returns, before the harness adds the frame size. */
interface CollectedFacts {
  applied: AppliedInput
  elements: FactElement[]
  capped: boolean
  fonts_fell_back: boolean
  colors: FactColor[]
  colors_capped: boolean
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
  const wantsAxe = FRAME_RULES.some((rule) => rule.needsAxe && (!opts.rules || opts.rules.includes(rule.id)))
  const axe = wantsAxe ? await collectAxe(page) : undefined
  const facts: FrameFacts = {
    frame: { width: frame.width, height: frame.height },
    viewport: { width: viewport.width, height: viewport.height },
    ...collected,
    ...(axe ? { axe } : {}),
  }
  const findings = runRules(facts, opts.rules)
  /* a run that lost a source of facts is never clean: say which */
  const reason = collected.capped
    ? `fact cap ${FACT_ELEMENT_CAP} elements`
    : wantsAxe && !axe
      ? 'axe did not run'
      : undefined
  return {
    width: viewport.width,
    height: viewport.height,
    status: reason ? 'partial' : 'ok',
    ...(reason ? { reason } : {}),
    ms: Date.now() - started,
    applied: collected.applied,
    findings,
    colors: collected.colors,
    colors_capped: collected.colors_capped,
  }
}

/** The registered frame rules over `facts`, optionally narrowed to `ids`. */
export function runRules(facts: FrameFacts, ids?: string[]): LintFinding[] {
  return FRAME_RULES.filter((rule) => !ids || ids.includes(rule.id)).flatMap((rule) => rule.run(facts))
}

async function collectFacts(page: Page): Promise<CollectedFacts> {
  /* tsx/esbuild annotates nested functions with __name; page.evaluate serializes the callback without that helper */
  await page.evaluate('globalThis.__name = (target) => target')
  return page.evaluate(
    (cap: number, colorCap: number): CollectedFacts => {
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
      const elements: FactElement[] = []
      const styles = new WeakMap<Element, CSSStyleDeclaration>()
      const styleOf = (el: Element): CSSStyleDeclaration => {
        let style = styles.get(el)
        if (!style) {
          style = getComputedStyle(el)
          styles.set(el, style)
        }
        return style
      }
      const BIG = 1e7
      const clipsAxis = (value: string): boolean => value === 'hidden' || value === 'clip'
      /* The box that `overflow: hidden|clip` ancestors leave visible to `el` (null when none clips). A fixed box
       escapes every ancestor and an absolute one the ancestors it is not inside, which the climb tracks in `mode`. */
      const clipOf = (el: Element, includeSelf: boolean): { box: FactRect; truncates: boolean } | null => {
        let left = -BIG
        let top = -BIG
        let right = BIG
        let bottom = BIG
        let found = false
        let truncates = false
        let mode = styleOf(el).position
        for (
          let node: Element | null = includeSelf ? el : el.parentElement;
          node && node !== document.body && node !== root;
          node = node.parentElement
        ) {
          if (mode === 'fixed') break
          const style = styleOf(node)
          if (mode === 'absolute' && style.position === 'static' && node !== el) continue
          const clipX = clipsAxis(style.overflowX)
          const clipY = clipsAxis(style.overflowY)
          if (clipX || clipY) {
            const box = node.getBoundingClientRect()
            if (clipX) {
              left = Math.max(left, box.left + node.clientLeft + scrollX)
              right = Math.min(right, box.left + node.clientLeft + node.clientWidth + scrollX)
            }
            if (clipY) {
              top = Math.max(top, box.top + node.clientTop + scrollY)
              bottom = Math.min(bottom, box.top + node.clientTop + node.clientHeight + scrollY)
            }
            found = true
            const clamp = style.getPropertyValue('-webkit-line-clamp')
            if (style.textOverflow === 'ellipsis' || (clamp !== '' && clamp !== 'none')) truncates = true
          }
          mode = style.position
        }
        return found
          ? { box: { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) }, truncates }
          : null
      }
      const ownTextLines = (el: Element): FactRect[] => {
        const lines: FactRect[] = []
        for (const node of Array.from(el.childNodes)) {
          if (node.nodeType !== Node.TEXT_NODE || !(node.textContent ?? '').trim()) continue
          const range = document.createRange()
          range.selectNodeContents(node)
          for (const box of Array.from(range.getClientRects())) {
            if (box.width > 0 && box.height > 0) {
              lines.push({ x: box.left + scrollX, y: box.top + scrollY, width: box.width, height: box.height })
            }
          }
        }
        return lines
      }
      const FIELD_SKIP_TYPES = new Set(['hidden', 'submit', 'button', 'reset', 'image'])
      const controlKind = (el: Element): FactControlKind | null => {
        const tag = el.tagName
        if (tag === 'SELECT' || tag === 'TEXTAREA') return 'field'
        if (tag === 'INPUT') return FIELD_SKIP_TYPES.has((el as HTMLInputElement).type) ? null : 'field'
        const named =
          tag === 'BUTTON' || el.getAttribute('role') === 'button' || (tag === 'A' && el.hasAttribute('href'))
        if (!named || (el.textContent ?? '').trim() !== '') return null
        return tag === 'A' ? 'image-link' : 'icon-button'
      }
      const refOf = (el: Element): FactRef => {
        const id = el.getAttribute('data-doop-id')
        return { tag: el.tagName.toLowerCase(), ...(id ? { doop_id: id } : {}), selector: selectorOf(el) }
      }
      /* what the center of a control hits, when that is not the control, something inside it, something it sits inside
       or its own label */
      const occluderOf = (el: Element, style: CSSStyleDeclaration, box: DOMRect): FactRef | undefined => {
        if (style.pointerEvents === 'none' || style.visibility !== 'visible' || style.opacity === '0') return undefined
        if (box.width < 8 || box.height < 8) return undefined
        const cx = box.left + box.width / 2
        const cy = box.top + box.height / 2
        if (cx < 0 || cy < 0 || cx >= innerWidth || cy >= innerHeight) return undefined
        const hit = document.elementFromPoint(cx, cy)
        if (!hit || hit === el || el.contains(hit) || hit.contains(el)) return undefined
        const labels = (el as HTMLInputElement).labels
        const label = hit.closest('label')
        if (labels && label && Array.from(labels).includes(label)) return undefined
        return refOf(hit)
      }
      const isTransparent = (color: string): boolean => color === 'transparent' || /,\s*0\)$/.test(color)
      let capped = false
      /* opaque rendered colors, keyed by the computed string; translucent ones depend on what they cover */
      const colors = new Map<string, { value: string; count: number; selector: string; doop_id?: string }>()
      let colorsCapped = false
      const addColor = (value: string, selector: () => string, doopId: string | null): void => {
        /* the computed value is `rgba(…)` or has a `/ alpha` only when it is not opaque */
        if (value.startsWith('rgba(') || value.includes('/') || value === 'transparent') return
        const seen = colors.get(value)
        if (seen) {
          seen.count++
        } else if (colors.size >= colorCap) {
          colorsCapped = true
        } else {
          colors.set(value, { value, count: 1, selector: selector(), ...(doopId ? { doop_id: doopId } : {}) })
        }
      }
      const nearestRecorded = (el: Element): number => {
        for (let node = el.parentElement; node; node = node.parentElement) {
          const found = indexOf.get(node)
          if (found !== undefined) return found
        }
        return -1
      }
      /* the S4 facts: border, clips, own text, control occlusion, corner radii and what the box paints */
      const addClippingFacts = (fact: FactElement, el: Element, style: CSSStyleDeclaration, rect: DOMRect): void => {
        const border = {
          top: parseFloat(style.borderTopWidth) || 0,
          right: parseFloat(style.borderRightWidth) || 0,
          bottom: parseFloat(style.borderBottomWidth) || 0,
          left: parseFloat(style.borderLeftWidth) || 0,
        }
        const bordered = border.top > 0 || border.right > 0 || border.bottom > 0 || border.left > 0
        if (bordered) {
          fact.border = border
          const clip = clipOf(el, false)
          if (clip) fact.clip = clip.box
        }
        if (style.visibility === 'visible') {
          const lines = ownTextLines(el)
          const clip = lines.length > 0 ? clipOf(el, true) : null
          /* a one-pixel box that clips is the screen-reader-only idiom, whose text is meant to be cut */
          if (clip && clip.box.width > 2 && clip.box.height > 2) {
            fact.text = { lines, truncates: clip.truncates }
            fact.content_clip = clip.box
          }
        }
        const kind = controlKind(el)
        if (kind) {
          const occluder = occluderOf(el, style, rect)
          fact.control = { kind, ...(occluder ? { occluded_by: occluder } : {}) }
        }
        const radii = [
          style.borderTopLeftRadius,
          style.borderTopRightRadius,
          style.borderBottomRightRadius,
          style.borderBottomLeftRadius,
        ].map((value) => {
          const first = value.split(' ')[0] ?? ''
          const size = parseFloat(first) || 0
          const px = first.endsWith('%') ? (size * rect.width) / 100 : size
          return Math.max(0, Math.min(px, rect.width / 2, rect.height / 2))
        })
        if (radii.some((r) => r > 0)) {
          fact.radius = [radii[0] ?? 0, radii[1] ?? 0, radii[2] ?? 0, radii[3] ?? 0]
          if (style.overflowX !== 'visible' || style.overflowY !== 'visible') fact.clips = true
        }
        const replaced = el.tagName === 'IMG' || el.tagName === 'VIDEO' || el.tagName === 'CANVAS'
        if (bordered || replaced || style.backgroundImage !== 'none' || !isTransparent(style.backgroundColor)) {
          fact.paints_box = true
        }
      }
      const all = document.body ? [document.body, ...Array.from(document.body.querySelectorAll('*'))] : []
      for (const el of all) {
        const parent = el.parentElement
        const style = getComputedStyle(el)
        /* an ancestor below body that clips the vertical overflow of its content; a fixed box escapes it */
        const parentClips =
          parent && parent !== document.body && parent !== root ? clippedBy.get(parent) === true : false
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
        if (rect.width > 0 && rect.height > 0 && style.visibility === 'visible') {
          const ownText = Array.from(el.childNodes).some((n) => n.nodeType === 3 && (n.textContent ?? '').trim() !== '')
          const selector = () => selectorOf(el)
          addColor(style.backgroundColor, selector, doopId)
          if (ownText) addColor(style.color, selector, doopId)
          if (style.borderTopStyle !== 'none' && parseFloat(style.borderTopWidth) > 0) {
            addColor(style.borderTopColor, selector, doopId)
          }
        }
        const fact: FactElement = {
          tag: el.tagName.toLowerCase(),
          ...(doopId ? { doop_id: doopId } : {}),
          selector: selectorOf(el),
          rect: { x: rect.left + scrollX, y: rect.top + scrollY, width: rect.width, height: rect.height },
          parent: nearestRecorded(el),
          clipped_y: clippedAbove,
        }
        if (el !== document.body) addClippingFacts(fact, el, style, rect)
        elements.push(fact)
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
        colors: [...colors.values()],
        colors_capped: colorsCapped,
      }
    },
    FACT_ELEMENT_CAP,
    FACT_COLOR_CAP,
  )
}

/** One violation node as the page reports it, before the harness drops mirrored pairs. */
interface AxeNode extends AxeFact {
  /** axe's CSS targets of the neighbours that made this node fail `target-size` */
  related: string[]
  /** axe's own CSS target of this node, the key `related` names */
  axe_target: string
}

/** Run the six axe rules in the page. Returns `undefined` when axe could not be injected or run (a page that
 *  blocks `window.axe`, an axe error): the caller reports the viewport as `partial`, never clean. */
async function collectAxe(page: Page): Promise<AxeFact[] | undefined> {
  try {
    await page.evaluate(await loadAxeSource())
    await page.evaluate('globalThis.__name = (target) => target')
    const nodes = await page.evaluate(
      async (ids: string[]): Promise<AxeNode[]> => {
        const axe = (window as unknown as { axe: { run(ctx: Document, opts: object): Promise<AxeRunResult> } }).axe
        interface AxeCheck {
          message: string
          relatedNodes: Array<{ target: unknown[] }>
        }
        interface AxeRunResult {
          violations: Array<{
            id: string
            help: string
            nodes: Array<{ target: unknown[]; any: AxeCheck[] }>
          }>
        }
        const css = (target: unknown[]): string => {
          const first = target[0]
          return Array.isArray(first) ? first.join(' ') : String(first)
        }
        const result = await axe.run(document, { runOnly: { type: 'rule', values: ids }, resultTypes: ['violations'] })
        const out: AxeNode[] = []
        for (const violation of result.violations) {
          for (const node of violation.nodes) {
            const selector = css(node.target)
            let doopId: string | null = null
            try {
              doopId = document.querySelector(selector)?.getAttribute('data-doop-id') ?? null
            } catch {
              /* a selector the page cannot resolve keeps axe's own text */
            }
            const message = violation.id === 'target-size' ? (node.any[0]?.message ?? violation.help) : violation.help
            out.push({
              rule: violation.id,
              ...(doopId ? { doop_id: doopId } : {}),
              selector: doopId ? `[data-doop-id="${doopId.replace(/["\\]/g, '\\$&')}"]` : selector,
              message: message.replace(/\s+/g, ' ').trim(),
              related: node.any.flatMap((check) => check.relatedNodes.map((related) => css(related.target))),
              axe_target: selector,
            })
          }
        }
        return out
      },
      [...AXE_RULE_IDS],
    )
    return dropMirroredPairs(nodes)
  } catch {
    return undefined
  }
}

/** axe reports both buttons of a crowded pair (each names the other as its neighbour). Report the pair once: a
 *  node is dropped when an earlier reported `target-size` node is one of its neighbours. */
export function dropMirroredPairs(nodes: AxeNode[]): AxeFact[] {
  const reported = new Set<string>()
  const kept: AxeFact[] = []
  for (const node of nodes) {
    if (node.rule === AXE_TARGET_RULE_ID) {
      if (node.related.some((neighbour) => reported.has(neighbour))) continue
      reported.add(node.axe_target)
    }
    const { related: _related, axe_target: _target, ...fact } = node
    kept.push(fact)
  }
  return kept
}
