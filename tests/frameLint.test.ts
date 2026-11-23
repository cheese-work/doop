import { describe, expect, it } from 'vitest'
import {
  FRAME_LINT_RULESET,
  FRAME_RULES,
  HALLMARK_PIN,
  PAGE_RULES,
  outsideFrameRule,
  type AxeFact,
  type FactElement,
  type FrameFacts,
} from '../shared/frameLint.ts'
import { dropMirroredPairs, lintFrame, runRules } from '../server/frameLint.ts'

/* S2 of the CHE-9115 plan (fl-r1): rule 3 `outside-frame` on synthetic facts, and the harness paths that need no
   browser. The rule is a pure function over what the collector saw. */

function el(over: Partial<FactElement> & Pick<FactElement, 'rect'>): FactElement {
  return { tag: 'div', selector: 'div', parent: -1, clipped_y: false, ...over }
}

function facts(elements: FactElement[], over: Partial<FrameFacts> = {}): FrameFacts {
  return {
    frame: { width: 393, height: 852 },
    viewport: { width: 393, height: 852 },
    applied: { colorScheme: 'light', lang: '', dir: 'ltr', fontScale: 1 },
    elements,
    capped: false,
    fonts_fell_back: false,
    colors: [],
    colors_capped: false,
    ...over,
  }
}

const box = (x: number, y: number, width: number, height: number) => ({ x, y, width, height })

describe('the registries', () => {
  it('names the ruleset, the frame rules (rule 3 and the two axe rules) and the page rules registered so far', () => {
    expect(FRAME_LINT_RULESET).toBe('fl-r1')
    expect(FRAME_RULES.map((rule) => rule.id)).toEqual([
      'outside-frame',
      'border-clipped',
      'text-clipped',
      'control-occluded',
      'radius-bleed',
      'interactive-name',
      'target-spacing',
    ])
    expect(PAGE_RULES.map((rule) => rule.id)).toEqual(['states', 'repeated-markup'])
    expect(HALLMARK_PIN).toMatch(/^[0-9a-f]{40}$/)
  })
})

describe('outside-frame on synthetic facts', () => {
  it('reports a box that reaches past the bottom edge', () => {
    const found = outsideFrameRule.run(
      facts([el({ doop_id: 'bar', selector: '[data-doop-id="bar"]', rect: box(0, 900, 393, 60) })]),
    )
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({
      rule: 'outside-frame',
      level: 'error',
      viewport: { width: 393, height: 852 },
      element: { doop_id: 'bar', selector: '[data-doop-id="bar"]' },
    })
    expect(found[0]?.message).toContain('108px past the bottom edge of the 852px frame')
  })

  it('stays silent on the gate 34 case: a child wider than the frame (horizontal only)', () => {
    expect(outsideFrameRule.run(facts([el({ rect: box(0, 0, 420, 40) })]))).toEqual([])
    expect(outsideFrameRule.run(facts([el({ rect: box(380, 10, 100, 40) })]))).toEqual([])
  })

  it('stays silent on a box that ends exactly on the edge or half a pixel past it', () => {
    expect(outsideFrameRule.run(facts([el({ rect: box(0, 800, 393, 52) })]))).toEqual([])
    expect(outsideFrameRule.run(facts([el({ rect: box(0, 800, 393, 52.5) })]))).toEqual([])
    expect(outsideFrameRule.run(facts([el({ rect: box(0, 800, 393, 53) })]))).toHaveLength(1)
  })

  it('reports only the outermost box that crosses, not each descendant', () => {
    const found = outsideFrameRule.run(
      facts([
        el({ tag: 'body', rect: box(0, 0, 393, 1000) }),
        el({ selector: 'body > div', parent: 0, rect: box(0, 800, 393, 200) }),
        el({ selector: 'body > div > p', parent: 1, rect: box(0, 900, 393, 40) }),
      ]),
    )
    expect(found.map((f) => f.element?.selector)).toEqual(['body > div'])
  })

  it('reports a crossing child of a parent that stays inside the frame', () => {
    const found = outsideFrameRule.run(
      facts([
        el({ selector: 'body > div', rect: box(0, 0, 393, 800) }),
        el({ selector: 'body > div > p', parent: 0, rect: box(0, 790, 393, 100) }),
      ]),
    )
    expect(found.map((f) => f.element?.selector)).toEqual(['body > div > p'])
  })

  it('skips html, body, empty boxes and content an ancestor clips', () => {
    const found = outsideFrameRule.run(
      facts([
        el({ tag: 'html', rect: box(0, 0, 393, 2000) }),
        el({ tag: 'body', rect: box(0, 0, 393, 2000) }),
        el({ rect: box(0, 900, 0, 40) }),
        el({ rect: box(0, 900, 393, 0) }),
        el({ rect: box(0, 900, 393, 40), clipped_y: true }),
      ]),
    )
    expect(found).toEqual([])
  })

  it('downgrades to warn when a font fell back, and omits an absent doop_id', () => {
    const [finding] = outsideFrameRule.run(
      facts([el({ selector: 'body > div', rect: box(0, 900, 393, 40) })], { fonts_fell_back: true }),
    )
    expect(finding?.level).toBe('warn')
    expect(finding?.element).toEqual({ selector: 'body > div' })
  })

  it('measures against the frame height, not the viewport height', () => {
    const tall = facts([el({ rect: box(0, 500, 320, 200) })], {
      frame: { width: 393, height: 600 },
      viewport: { width: 320, height: 600 },
    })
    expect(outsideFrameRule.run(tall)).toHaveLength(1)
    expect(outsideFrameRule.run({ ...tall, frame: { width: 393, height: 700 } })).toEqual([])
  })
})

describe('the axe rules on synthetic axe facts (S5)', () => {
  const axeFacts = (axe: AxeFact[]) => facts([], { axe })
  const node = (rule: string, over: Partial<AxeFact> = {}): AxeFact => ({
    rule,
    selector: '[data-doop-id="x"]',
    doop_id: 'x',
    message: 'axe says so',
    ...over,
  })

  it.each(['button-name', 'link-name', 'label', 'aria-command-name', 'input-button-name'])(
    'maps axe %s to interactive-name (error)',
    (rule) => {
      const found = runRules(axeFacts([node(rule)]))
      expect(found).toHaveLength(1)
      expect(found[0]).toMatchObject({
        rule: 'interactive-name',
        level: 'error',
        viewport: { width: 393, height: 852 },
        element: { doop_id: 'x', selector: '[data-doop-id="x"]' },
      })
      expect(found[0]?.message).toContain('axe says so')
    },
  )

  it('maps axe target-size to target-spacing (warn) and omits an absent doop_id', () => {
    const found = runRules(axeFacts([node('target-size', { doop_id: undefined, selector: 'body > button' })]))
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ rule: 'target-spacing', level: 'warn', element: { selector: 'body > button' } })
    expect(found[0]?.element).not.toHaveProperty('doop_id')
  })

  it('ignores an axe rule it does not map, and facts with no axe result', () => {
    expect(runRules(axeFacts([node('color-contrast')]))).toEqual([])
    expect(runRules(facts([]))).toEqual([])
  })

  it('narrows to the ids asked for', () => {
    const both = axeFacts([node('button-name'), node('target-size')])
    expect(runRules(both, ['target-spacing']).map((f) => f.rule)).toEqual(['target-spacing'])
    expect(runRules(both, ['interactive-name']).map((f) => f.rule)).toEqual(['interactive-name'])
  })
})

describe('dropMirroredPairs', () => {
  const n = (rule: string, target: string, related: string[] = []) => ({
    rule,
    selector: target,
    message: 'm',
    axe_target: target,
    related,
  })

  it('reports a crowded pair once and keeps a node whose neighbour was not reported', () => {
    const kept = dropMirroredPairs([
      n('target-size', '#a', ['#b']),
      n('target-size', '#b', ['#a']),
      n('target-size', '#c', ['#d']),
    ])
    expect(kept.map((f) => f.selector)).toEqual(['#a', '#c'])
  })

  it('never drops a name violation, and strips the bookkeeping fields', () => {
    const kept = dropMirroredPairs([n('target-size', '#a', ['#b']), n('button-name', '#b', ['#a'])])
    expect(kept.map((f) => f.rule)).toEqual(['target-size', 'button-name'])
    expect(kept[0]).toEqual({ rule: 'target-size', selector: '#a', message: 'm' })
  })
})

describe('runRules', () => {
  const crossing = facts([el({ rect: box(0, 900, 393, 60) })])

  it('runs every registered rule when no ids are given', () => {
    expect(runRules(crossing)).toHaveLength(1)
  })

  it('narrows to the ids asked for', () => {
    expect(runRules(crossing, ['outside-frame'])).toHaveLength(1)
    expect(runRules(crossing, ['some-other-rule'])).toEqual([])
  })
})

describe('lintFrame without a browser', () => {
  const input = {
    frame: { id: 'f1', html: '<p>hi</p>', width: 393, height: 852 },
    viewport: { width: 393, height: 852 },
  }

  it('answers NOT-RUN "aborted" when the signal is already aborted, and never a clean row', async () => {
    const result = await lintFrame(input, { signal: AbortSignal.abort() })
    expect(result).toMatchObject({ width: 393, height: 852, status: 'NOT-RUN', reason: 'aborted', findings: [] })
    expect(result.applied).toBeUndefined()
  })

  it('answers NOT-RUN "deadline" when the handler aborted with the deadline reason', async () => {
    const result = await lintFrame(input, { signal: AbortSignal.abort('deadline') })
    expect(result).toMatchObject({ status: 'NOT-RUN', reason: 'deadline', findings: [] })
  })
})
