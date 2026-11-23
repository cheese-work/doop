/* Frame lint: rule types, the ruleset id, the Hallmark pin and the two rule registries (CHE-9115 S2, plan r6).
   The browser collects `FrameFacts`; the rules here are pure functions over them, so most rule tests run
   without a browser. The result and finding types live in `frameLintResult.ts` (S3a). Warning mode only:
   nothing here blocks a gate, a publish or a lock. */

import type { LintFinding, ViewportResult, RowStatus } from './frameLintResult.ts'
import { statesPageRule } from './frameLintStates.ts'
import { repeatedMarkupRule } from './frameLintRepeated.ts'

export { FRAME_LINT_RULESET } from './frameLintResult.ts'
export type { LintFinding, FindingLevel } from './frameLintResult.ts'

/** The Hallmark commit the overlap inventory was read from (plan "Hallmark sloplint overlap"). */
export const HALLMARK_PIN = '407fa689f4a276f2fd389208d271d0fef08f5058'

/** Gates `skills/hallmark/scripts/sloplint.mjs` emits at the pin. frame-lint checks none of them as its own predicate;
 *  the boundary fixtures are the proof, these lists are the inventory a later pin must rebuild before `fl-r2`. */
export const HALLMARK_STATIC_EMITTERS = [
  '1',
  '2a',
  '2b',
  '3',
  '4',
  '6a',
  '6b',
  '8',
  '10a',
  '10b',
  '11',
  '12',
  '15',
  '17',
  '18',
  '19',
  '20',
  '22',
  '23',
  '24a',
  '24b',
  '25',
  '26a',
  '26b',
  '27',
  '28a',
  '28b',
  '29',
  '30a',
  '30b',
  '33',
  '34',
  '37',
  '38i',
  '38ii',
  '38iii',
  '39a',
  '40',
  '41',
  '42',
  '46a',
  '47a',
  '47b',
  '47c',
  '48',
  '49',
  '50',
  '53',
  '54',
  '56',
  '58',
  '62',
  '63',
  '64',
  '65',
  '67',
  '68',
  '69',
  '70',
  '74',
  '76',
  'F1',
  'F2',
  'F3',
  'F4',
  'F5',
  'F6',
  'F7',
  'F8',
  'F9',
  'F15',
  'F16',
  'F18',
  'F21',
  'F22',
  'F23',
  'F24',
] as const

/** Gates `skills/hallmark/scripts/sloplint-render.mjs` emits at the pin. */
export const HALLMARK_RENDER_EMITTERS = [
  '3',
  '23',
  '25',
  '26a',
  '34',
  '39b',
  '40',
  '41',
  '44a',
  '44b',
  '44c',
  '44d',
  '56',
  '58',
  '59',
  '62',
  '71',
  '72',
  '73',
  '75',
  '76',
  '77',
  '78',
  '79',
  '80',
  '81',
  '82',
  '83',
  '85',
  'F17',
  'F18',
  'F19',
  'F20',
  'F25',
  'F26',
] as const

/** A box in document coordinates (CSS px). */
export interface FactRect {
  x: number
  y: number
  width: number
  height: number
}

export type FactControlKind = 'icon-button' | 'field' | 'image-link'

/** An element a rule names, as the collector found it again by a CSS path. */
export interface FactRef {
  tag: string
  doop_id?: string
  selector: string
}

/** One element the collector saw, in document coordinates (CSS px). The optional facts below are set only where they
 *  apply, so a rule reads one as "this element has it" and an element without any costs nothing. */
export interface FactElement {
  tag: string
  doop_id?: string
  /** a CSS path that finds the element again */
  selector: string
  rect: FactRect
  /** index into `elements` of the nearest collected ancestor, or -1 */
  parent: number
  /** an ancestor below `body` clips the vertical overflow of this element */
  clipped_y: boolean
  /** border widths in px; set when any side is drawn (S4) */
  border?: { top: number; right: number; bottom: number; left: number }
  /** the box that `overflow: hidden|clip` ancestors leave visible to this element (a fixed box escapes them, an
   *  absolute one escapes those it is not inside); set on bordered elements an ancestor clips */
  clip?: FactRect
  /** the text this element owns, one box per line fragment; `truncates` marks an intended cut (ellipsis, line clamp) */
  text?: { lines: FactRect[]; truncates: boolean }
  /** the box left visible to that text: the same as `clip`, but the element's own `overflow` counts too */
  content_clip?: FactRect
  /** an interactive control with no text of its own, and the element its center hits if that is not itself */
  control?: { kind: FactControlKind; occluded_by?: FactRef }
  /** corner radii in px: top-left, top-right, bottom-right, bottom-left; set when any is above 0 */
  radius?: [number, number, number, number]
  /** `overflow` is not `visible` on either axis, so the box rounds its content */
  clips?: boolean
  /** the box paints something of its own: a background, an image, a border, or it is a replaced element */
  paints_box?: boolean
}

/** What the collector reports back as applied, so a variant test can compare it with the input. */
export interface AppliedInput {
  colorScheme: 'light' | 'dark'
  lang: string
  dir: 'ltr' | 'rtl'
  fontScale: number
}

/** One rendered color the collector saw, with the first element that uses it (plan rule 17). `value` is the computed
 *  CSS color string; `count` is how many elements use it as text, background or border color. */
export interface FactColor {
  value: string
  count: number
  selector: string
  doop_id?: string
}

/** One axe-core violation node, reduced to what the rules need. */
export interface AxeFact {
  /** the axe rule id (`button-name`, `target-size`, ...) */
  rule: string
  doop_id?: string
  /** `[data-doop-id="..."]` when the element has one, else axe's own CSS target */
  selector: string
  /** axe's one-line reason for this node */
  message: string
}

/** One control the Tab key reaches, in document order (plan rule 21). `tabindex` is the effective value: the
 *  attribute when it is a non-negative integer, else 0 for a natively focusable control. Controls that are hidden,
 *  disabled, inert or have `tabindex="-1"` are not in the Tab walk and are not collected. */
export interface FactFocusable {
  tag: string
  doop_id?: string
  selector: string
  tabindex: number
}

export interface FrameFacts {
  /** the frame's own size: rule 3 compares boxes with `frame.height` */
  frame: { width: number; height: number }
  viewport: { width: number; height: number }
  applied: AppliedInput
  elements: FactElement[]
  /** the element walk hit `FACT_ELEMENT_CAP` */
  capped: boolean
  /** axe-core violations for `AXE_RULE_IDS`; absent when axe did not run */
  axe?: AxeFact[]
  /** a font of the page failed to load, so the metrics may differ from the live image (plan risk 1) */
  fonts_fell_back: boolean
  /** distinct opaque rendered colors, first `FACT_COLOR_CAP` seen */
  colors: FactColor[]
  /** more distinct colors than `FACT_COLOR_CAP` were seen, so `colors` is a part */
  colors_capped: boolean
  /** the controls the Tab key reaches, in document order; absent when the collector did not list them */
  focusables?: FactFocusable[]
  /** more focusable controls than `FACT_FOCUS_CAP` were seen, so `focusables` is a part */
  focusables_capped?: boolean
}

export const FACT_ELEMENT_CAP = 5000
export const FACT_COLOR_CAP = 256
export const FACT_FOCUS_CAP = 1000

export interface FrameRule {
  id: string
  /** the collector must run axe-core for this rule */
  needsAxe?: boolean
  run(facts: FrameFacts): LintFinding[]
}

/** The axe-core rules S5 runs (`runOnly`), and the frame-lint rule each one maps to. axe-core 4.14.1 (MPL-2.0) is
 *  used unmodified and is not copied into the repo. */
export const AXE_NAME_RULE_IDS = [
  'button-name',
  'link-name',
  'label',
  'aria-command-name',
  'input-button-name',
] as const
export const AXE_TARGET_RULE_ID = 'target-size'
export const AXE_RULE_IDS: readonly string[] = [...AXE_NAME_RULE_IDS, AXE_TARGET_RULE_ID]

/** One frame as a page rule sees it. `facts` is what the rule's `collect` returned for the frame's HTML, or `null` when
 *  the frame was skipped (over the size or fact cap). A skipped frame is counted, never read as clean. */
export interface PageFrameInput {
  frame_id: string
  hidden?: boolean
  facts: unknown
}

/** A page finding names the frame it belongs to; the scan files it under that frame's row. */
export interface PageFinding extends LintFinding {
  frame_id: string
}

/** A rule over the HTML of every frame on a page (repeated markup, states). `collect` reads one frame's HTML
 *  (parse5, no browser); `evaluate` runs over what was collected from every frame, so a conclusion never rests on
 *  part of the page. S3p wires the scan; S6 and S7 register their rules. */
export interface PageRule {
  id: string
  collect(html: string): unknown
  /** true when `collect` returned a part of the frame because it passed the per-frame fact cap; the scan then skips
   *  the frame for every rule, so no rule reads a part of it as the whole */
  over?(facts: unknown): boolean
  evaluate(frames: PageFrameInput[]): PageFinding[]
}

/** One viewport's outcome from `lintFrame` / `lintConfiguredPage`. */
export interface FrameViewportResult extends ViewportResult {
  status: RowStatus
  reason?: string
  /** absent when the render did not finish */
  applied?: AppliedInput
  findings: LintFinding[]
  /** rendered colors for the page color rule (17); absent when the render did not finish */
  colors?: FactColor[]
  colors_capped?: boolean
}

/** Rule 3 `outside-frame`, bottom edge only: a box that reaches past the bottom of a fixed-height frame is cut off
 *  by the canvas. Horizontal overflow is Hallmark gate 34's and is not checked here. Only the outermost element
 *  that crosses is reported, and an element an ancestor clips is not cut by the canvas. */
export const outsideFrameRule: FrameRule = {
  id: 'outside-frame',
  run(facts) {
    const { elements, frame } = facts
    const limit = frame.height
    const crosses = (index: number): boolean => {
      const el = elements[index]
      if (!el || el.tag === 'html' || el.tag === 'body') return false
      return el.rect.width > 0 && el.rect.height > 0 && el.rect.y + el.rect.height > limit + 0.5
    }
    const findings: LintFinding[] = []
    elements.forEach((el, index) => {
      if (el.clipped_y || !crosses(index) || (el.parent >= 0 && crosses(el.parent))) return
      const past = Math.round(el.rect.y + el.rect.height - limit)
      findings.push({
        rule: 'outside-frame',
        level: facts.fonts_fell_back ? 'warn' : 'error',
        viewport: { width: facts.viewport.width, height: facts.viewport.height },
        element: { ...(el.doop_id ? { doop_id: el.doop_id } : {}), selector: el.selector },
        message: `Reaches ${past}px past the bottom edge of the ${limit}px frame, so the canvas cuts it off`,
      })
    })
    return findings
  },
}

/** A px tolerance for rounding: a box within 1px of an edge does not cross it. */
const EDGE_TOLERANCE = 1
const SIDES = ['top', 'right', 'bottom', 'left'] as const
type Side = (typeof SIDES)[number]

function findingOf(
  facts: FrameFacts,
  rule: string,
  level: LintFinding['level'],
  el: FactElement,
  message: string,
): LintFinding {
  return {
    rule,
    level,
    viewport: { width: facts.viewport.width, height: facts.viewport.height },
    element: { ...(el.doop_id ? { doop_id: el.doop_id } : {}), selector: el.selector },
    message,
  }
}

/** How far each edge of `rect` lies outside `clip`; positive means cut. */
function overshoot(rect: FactRect, clip: FactRect): Record<Side, number> {
  return {
    top: clip.y - rect.y,
    right: rect.x + rect.width - (clip.x + clip.width),
    bottom: rect.y + rect.height - (clip.y + clip.height),
    left: clip.x - rect.x,
  }
}

function intersectionArea(a: FactRect, b: FactRect): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  return w > 0 && h > 0 ? w * h : 0
}

/** The sides of `el` whose drawn border lies past the clip of an ancestor. A box clipped away entirely is hidden, not
 *  cut, and the rule leaves it to the hiding rules. */
function cutBorderSides(el: FactElement): Array<[Side, number]> {
  const { border, clip, rect } = el
  if (!border || !clip || intersectionArea(rect, clip) === 0) return []
  const over = overshoot(rect, clip)
  return SIDES.filter((side) => border[side] > 0 && over[side] > EDGE_TOLERANCE).map((side) => [side, over[side]])
}

/** Rule 1 `border-clipped`: a box with a drawn border that an `overflow: hidden|clip` ancestor cuts, so the border
 *  is missing on that side (a field one px too wide for its card). Only the outermost box is reported: its own
 *  bordered children that ride along inside it are not. A scroll container is not a clip, because the box scrolls
 *  into view. */
export const borderClippedRule: FrameRule = {
  id: 'border-clipped',
  run(facts) {
    const findings: LintFinding[] = []
    facts.elements.forEach((el) => {
      const parent = el.parent >= 0 ? facts.elements[el.parent] : undefined
      const parentSides = new Set((parent ? cutBorderSides(parent) : []).map(([side]) => side))
      const cut = cutBorderSides(el).filter(([side]) => !parentSides.has(side))
      if (cut.length === 0) return
      const parts = cut.map(([side, px]) => `${side} ${Math.round(px)}px`).join(', ')
      findings.push(
        findingOf(
          facts,
          'border-clipped',
          'warn',
          el,
          `An ancestor that clips overflow cuts off the border of this box (${parts} past the edge)`,
        ),
      )
    })
    return findings
  },
}

/** Rule 2 `text-clipped`: text that an `overflow` box cuts, not text hidden by `display` or `visibility` (the collector
 *  does not see those). An ellipsis or a line clamp is a cut on purpose and is not reported. Text that is gone
 *  entirely, such as a collapsed panel, is not cut text either; a line gone while another line shows is. A line box is
 *  taller than the glyphs, so the vertical tolerance is a third of the line, not a pixel. */
export const textClippedRule: FrameRule = {
  id: 'text-clipped',
  run(facts) {
    const findings: LintFinding[] = []
    for (const el of facts.elements) {
      const clip = el.content_clip
      if (!el.text || !clip || el.text.truncates || el.text.lines.length === 0) continue
      let total = 0
      let visible = 0
      let cutSome = false
      let goneSome = false
      let shownSome = false
      for (const line of el.text.lines) {
        const over = overshoot(line, clip)
        const horizontal = Math.max(over.left, over.right, 0)
        const vertical = Math.max(over.top, over.bottom, 0)
        const seen = intersectionArea(line, clip)
        total += line.width * line.height
        visible += seen
        const cut = horizontal > EDGE_TOLERANCE || vertical > Math.max(EDGE_TOLERANCE, line.height / 3)
        if (seen > 0) shownSome = true
        if (cut && seen > 0) cutSome = true
        if (cut && seen === 0) goneSome = true
      }
      if (!(cutSome || (goneSome && shownSome))) continue
      const percent = total > 0 ? Math.round((visible / total) * 100) : 0
      findings.push(
        findingOf(
          facts,
          'text-clipped',
          facts.fonts_fell_back ? 'warn' : 'error',
          el,
          `An overflow box cuts this text off: ${percent}% visible`,
        ),
      )
    }
    return findings
  },
}

/** Rule 4 `control-occluded`, narrowed from Hallmark gate 73: an interactive control with no text of its own (icon-only
 *  button, form field, image link) whose center another element hits, so a click lands elsewhere. Covered text and
 *  covered text buttons are Hallmark's, not this rule's. The collector hit-tests inside the viewport only. */
export const controlOccludedRule: FrameRule = {
  id: 'control-occluded',
  run(facts) {
    const findings: LintFinding[] = []
    for (const el of facts.elements) {
      const by = el.control?.occluded_by
      if (!by) continue
      findings.push(
        findingOf(
          facts,
          'control-occluded',
          'error',
          el,
          `Another element, ${by.selector}, covers the center of this ${el.control?.kind}, so a click lands there`,
        ),
      )
    }
    return findings
  },
}

const CORNERS = ['top-left', 'top-right', 'bottom-right', 'bottom-left'] as const

/** The corners of `child` whose square edge sticks out of the rounded `parent` corner. */
function bleedingCorners(child: FactElement, parent: FactElement, radius: [number, number, number, number]): number[] {
  const c = child.rect
  const p = parent.rect
  const own = child.radius ?? [0, 0, 0, 0]
  const gaps = [
    [c.x - p.x, c.y - p.y],
    [p.x + p.width - (c.x + c.width), c.y - p.y],
    [p.x + p.width - (c.x + c.width), p.y + p.height - (c.y + c.height)],
    [c.x - p.x, p.y + p.height - (c.y + c.height)],
  ] as const
  const out: number[] = []
  gaps.forEach(([dx, dy], corner) => {
    const r = radius[corner] ?? 0
    /* past the parent edge it is plain overflow, which `outside-frame` and Hallmark gate 34 own */
    if (r <= 0 || dx < -EDGE_TOLERANCE || dy < -EDGE_TOLERANCE) return
    const x = Math.max(dx, 0)
    const y = Math.max(dy, 0)
    if (x >= r || y >= r || (r - x) ** 2 + (r - y) ** 2 <= r * r) return
    if ((own[corner] ?? 0) >= r - Math.max(x, y) - EDGE_TOLERANCE) return
    out.push(corner)
  })
  return out
}

/** Rule 16 `radius-bleed`, a Cheese extra: a painted box whose square corner sticks out of the rounded corner of the
 *  card it sits in, or whose border that rounded `overflow` cuts. A background or image that a clip rounds is the
 *  usual image-in-a-card pattern and is fine. Only the outermost bleeding box is reported. */
export const radiusBleedRule: FrameRule = {
  id: 'radius-bleed',
  run(facts) {
    const { elements } = facts
    const findings: LintFinding[] = []
    const flagged = new Set<number>()
    elements.forEach((el, index) => {
      if (!el.paints_box) return
      let skip = false
      let at = el.parent
      let rounded: FactElement | undefined
      while (at >= 0) {
        const ancestor = elements[at]
        if (!ancestor) break
        if (flagged.has(at)) skip = true
        if (ancestor.radius) {
          rounded = ancestor
          break
        }
        at = ancestor.parent
      }
      if (skip || !rounded?.radius || !(rounded.paints_box || rounded.clips)) return
      if (rounded.clips && !el.border) return
      const corners = bleedingCorners(el, rounded, rounded.radius)
      if (corners.length === 0) return
      flagged.add(index)
      const names = corners.map((corner) => CORNERS[corner]).join(', ')
      const radius = Math.round(Math.max(...rounded.radius))
      findings.push(
        findingOf(
          facts,
          'radius-bleed',
          'warn',
          el,
          rounded.clips
            ? `The ${radius}px rounded overflow of its parent cuts the border at the ${names} corner`
            : `The square ${names} corner sticks out of the ${radius}px rounded corner of its parent`,
        ),
      )
    })
    return findings
  },
}

function axeFinding(facts: FrameFacts, node: AxeFact, rule: string, level: LintFinding['level']): LintFinding {
  return {
    rule,
    level,
    viewport: { width: facts.viewport.width, height: facts.viewport.height },
    element: { ...(node.doop_id ? { doop_id: node.doop_id } : {}), selector: node.selector },
    message: node.message,
  }
}

/** Rule 8 `interactive-name`: the accessible name of a control, not the label of the graphic inside it. Gate 33
 *  checks `<svg>` and `<canvas>` for `aria-hidden` or `aria-label` and stays its own check. */
export const interactiveNameRule: FrameRule = {
  id: 'interactive-name',
  needsAxe: true,
  run: (facts) =>
    (facts.axe ?? [])
      .filter((node) => (AXE_NAME_RULE_IDS as readonly string[]).includes(node.rule))
      .map((node) => axeFinding(facts, node, 'interactive-name', 'error')),
}

/** Rule 7 `target-spacing`: axe `target-size` unmodified (WCAG 2.5.8: under 24 x 24 CSS px and not enough space).
 *  No own height threshold, so Hallmark gate 39b's 44 to 52 px band stays its own check. */
export const targetSpacingRule: FrameRule = {
  id: 'target-spacing',
  needsAxe: true,
  run: (facts) =>
    (facts.axe ?? [])
      .filter((node) => node.rule === AXE_TARGET_RULE_ID)
      .map((node) => axeFinding(facts, node, 'target-spacing', 'warn')),
}

function ordinal(n: number): string {
  const tail = n % 100
  if (tail >= 11 && tail <= 13) return `${n}th`
  return `${n}${({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th'}`
}

/** Rule 21 `focus-order`: the Tab walk compared with the reading order. The browser walks controls with a positive
 *  `tabindex` first (lowest value first, document order on a tie), then the rest in document order. The reading
 *  order is the document order, which a screen reader follows. A positive `tabindex` is the only way to make the two
 *  differ, so each control that has one gets a finding: it says where the control lands in each order, and says
 *  so even when the two orders happen to agree, because the next edit to the markup breaks that. */
export const focusOrderRule: FrameRule = {
  id: 'focus-order',
  run(facts) {
    const stops = facts.focusables ?? []
    if (!stops.some((stop) => stop.tabindex > 0)) return []
    const walk = stops
      .map((stop, index) => ({ stop, index }))
      .sort((a, b) => {
        if (a.stop.tabindex > 0 && b.stop.tabindex > 0) return a.stop.tabindex - b.stop.tabindex || a.index - b.index
        if (a.stop.tabindex > 0) return -1
        if (b.stop.tabindex > 0) return 1
        return a.index - b.index
      })
    const walkPosition = new Map(walk.map(({ index }, position) => [index, position + 1]))
    const findings: LintFinding[] = []
    stops.forEach((stop, index) => {
      if (stop.tabindex <= 0) return
      const tab = walkPosition.get(index) ?? index + 1
      const reading = index + 1
      findings.push({
        rule: 'focus-order',
        level: 'warn',
        viewport: { width: facts.viewport.width, height: facts.viewport.height },
        element: { ...(stop.doop_id ? { doop_id: stop.doop_id } : {}), selector: stop.selector },
        message:
          tab === reading
            ? `tabindex="${stop.tabindex}" puts this control ${ordinal(tab)} in the Tab walk, as in the reading order, but a positive tabindex takes over the Tab order; use the document order instead`
            : `tabindex="${stop.tabindex}" puts this control ${ordinal(tab)} in the Tab walk but ${ordinal(reading)} in the reading order; remove it and order the markup instead`,
      })
    })
    return findings
  },
}

export const FRAME_RULES: FrameRule[] = [
  outsideFrameRule,
  borderClippedRule,
  textClippedRule,
  controlOccludedRule,
  radiusBleedRule,
  interactiveNameRule,
  targetSpacingRule,
  focusOrderRule,
]
export const PAGE_RULES: PageRule[] = [statesPageRule, repeatedMarkupRule]
