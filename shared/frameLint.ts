/* Frame lint: rule types, the ruleset id, the Hallmark pin and the two rule registries (CHE-9115 S2, plan r6).
   The browser collects `FrameFacts`; the rules here are pure functions over them, so most rule tests run
   without a browser. The result and finding types live in `frameLintResult.ts` (S3a). Warning mode only:
   nothing here blocks a gate, a publish or a lock. */

import type { LintFinding, ViewportResult, RowStatus } from './frameLintResult.ts'
import { statesPageRule } from './frameLintStates.ts'

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

/** One element the collector saw, in document coordinates (CSS px). */
export interface FactElement {
  tag: string
  doop_id?: string
  /** a CSS path that finds the element again */
  selector: string
  rect: { x: number; y: number; width: number; height: number }
  /** index into `elements` of the nearest collected ancestor, or -1 */
  parent: number
  /** an ancestor below `body` clips the vertical overflow of this element */
  clipped_y: boolean
}

/** What the collector reports back as applied, so a variant test can compare it with the input. */
export interface AppliedInput {
  colorScheme: 'light' | 'dark'
  lang: string
  dir: 'ltr' | 'rtl'
  fontScale: number
}

export interface FrameFacts {
  /** the frame's own size: rule 3 compares boxes with `frame.height` */
  frame: { width: number; height: number }
  viewport: { width: number; height: number }
  applied: AppliedInput
  elements: FactElement[]
  /** the element walk hit `FACT_ELEMENT_CAP` */
  capped: boolean
  /** a font of the page failed to load, so the metrics may differ from the live image (plan risk 1) */
  fonts_fell_back: boolean
}

export const FACT_ELEMENT_CAP = 5000

export interface FrameRule {
  id: string
  run(facts: FrameFacts): LintFinding[]
}

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
  evaluate(frames: PageFrameInput[]): PageFinding[]
}

/** One viewport's outcome from `lintFrame` / `lintConfiguredPage`. */
export interface FrameViewportResult extends ViewportResult {
  status: RowStatus
  reason?: string
  /** absent when the render did not finish */
  applied?: AppliedInput
  findings: LintFinding[]
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

export const FRAME_RULES: FrameRule[] = [outsideFrameRule]
export const PAGE_RULES: PageRule[] = [statesPageRule]
