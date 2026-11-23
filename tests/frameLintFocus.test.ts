import { describe, expect, it } from 'vitest'
import { FRAME_RULES, type FactFocusable, type FrameFacts, type LintFinding } from '../shared/frameLint.ts'

/* S8 of the CHE-9115 plan (fl-r1): rule 21 `focus-order` on synthetic facts. The collector lists the controls the Tab
   key can reach in document order; the rule rebuilds the Tab walk (positive tabindex first, then the rest in document
   order) and compares it with the reading order. */

function stop(selector: string, tabindex: number, over: Partial<FactFocusable> = {}): FactFocusable {
  return { tag: 'button', selector, tabindex, ...over }
}

function facts(focusables: FactFocusable[] | undefined, over: Partial<FrameFacts> = {}): FrameFacts {
  return {
    frame: { width: 393, height: 852 },
    viewport: { width: 393, height: 852 },
    applied: { colorScheme: 'light', lang: '', dir: 'ltr', fontScale: 1 },
    elements: [],
    capped: false,
    fonts_fell_back: false,
    colors: [],
    colors_capped: false,
    ...(focusables ? { focusables } : {}),
    ...over,
  }
}

function run(f: FrameFacts): LintFinding[] {
  const rule = FRAME_RULES.find((candidate) => candidate.id === 'focus-order')
  expect(rule, 'rule focus-order is registered').toBeDefined()
  return rule ? rule.run(f) : []
}

describe('focus-order on synthetic facts', () => {
  it('reports tabindex="3" before tabindex="1": the Tab walk runs against the reading order', () => {
    const found = run(
      facts([
        stop('[data-doop-id="a"]', 3, { doop_id: 'a' }),
        stop('[data-doop-id="b"]', 1, { doop_id: 'b' }),
        stop('[data-doop-id="c"]', 0, { doop_id: 'c' }),
      ]),
    )
    expect(found.map((f) => f.element?.doop_id)).toEqual(['a', 'b'])
    expect(found[0]).toMatchObject({
      rule: 'focus-order',
      level: 'warn',
      viewport: { width: 393, height: 852 },
      element: { doop_id: 'a', selector: '[data-doop-id="a"]' },
    })
    expect(found[0]?.message).toContain('tabindex="3"')
    expect(found[0]?.message).toContain('2nd in the Tab walk')
    expect(found[0]?.message).toContain('1st in the reading order')
    expect(found[1]?.message).toContain('1st in the Tab walk')
  })

  it('reports a positive tabindex even when the Tab walk happens to match the reading order', () => {
    const found = run(facts([stop('#a', 1), stop('#b', 0)]))
    expect(found).toHaveLength(1)
    expect(found[0]?.message).toContain('tabindex="1"')
    expect(found[0]?.message).toContain('use the document order')
  })

  it('reports only the positive tabindex that jumps the queue, not the controls it pushes back', () => {
    const found = run(facts([stop('#a', 0), stop('#b', 0), stop('#c', 5), stop('#d', 0)]))
    expect(found.map((f) => f.element?.selector)).toEqual(['#c'])
    expect(found[0]?.message).toContain('1st in the Tab walk')
    expect(found[0]?.message).toContain('3rd in the reading order')
  })

  it('gives 0 findings for tabindex 0 and for natural order', () => {
    expect(run(facts([stop('#a', 0), stop('#b', 0), stop('#c', 0)]))).toEqual([])
  })

  it('gives 0 findings when the collector saw no focusable control, or did not collect any', () => {
    expect(run(facts([]))).toEqual([])
    expect(run(facts(undefined))).toEqual([])
  })

  it('breaks a tie of equal positive tabindex values by document order, as the browser does', () => {
    const found = run(facts([stop('#a', 2), stop('#b', 2)]))
    expect(found.map((f) => f.element?.selector)).toEqual(['#a', '#b'])
    expect(found[0]?.message).toContain('1st in the Tab walk')
    expect(found[1]?.message).toContain('2nd in the Tab walk')
  })
})
