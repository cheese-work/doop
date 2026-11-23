import { describe, expect, it } from 'vitest'
import Color from 'colorjs.io'
import type { FactColor } from '../shared/frameLint.ts'
import { colorDistance, nearDuplicateColors, type ColorFrame } from '../shared/frameLintColor.ts'

/* S7 of the CHE-9115 plan (fl-r1): rule 17 `near-duplicate-color`, rendered colors with ΔE2000 over 0 and under 3,
   a pure function over the colors the collector saw. colorjs.io defaults to ΔE1976; these tests pin ΔE2000. */

const color = (
  value: string,
  count = 1,
  selector = `.use-${value.replace(/\W/g, '')}`,
  doop_id?: string,
): FactColor => ({
  value,
  count,
  selector,
  ...(doop_id ? { doop_id } : {}),
})
const frame = (frame_id: string, ...colors: FactColor[]): ColorFrame => ({ frame_id, colors })

describe('colorDistance is ΔE2000', () => {
  it('is not the 1976 default', () => {
    const a = 'rgb(0, 0, 255)'
    const b = 'rgb(0, 0, 247)'
    const e1976 = new Color(a).deltaE(new Color(b))
    expect(e1976).toBeGreaterThan(3)
    expect(colorDistance(a, b)).toBeGreaterThan(0.9)
    expect(colorDistance(a, b)).toBeLessThan(1)
  })

  it('is 0 for equal colors and reads hex, rgb() and named colors', () => {
    expect(colorDistance('#3B82F6', 'rgb(59, 130, 246)')).toBe(0)
    expect(colorDistance('red', '#ff0000')).toBe(0)
    expect(colorDistance('#3B82F6', '#3B83F6')).toBeCloseTo(0.352, 3)
  })
})

describe('near-duplicate-color: the fixtures of the plan', () => {
  it('gives 1 finding for #3B82F6 and #3B83F6', () => {
    const result = nearDuplicateColors([frame('f1', color('#3B82F6', 12), color('#3B83F6', 2, '.cta', 'cta'))], 1)
    expect(result.findings).toHaveLength(1)
    expect(result.findings[0]).toMatchObject({
      frame_id: 'f1',
      rule: 'near-duplicate-color',
      level: 'warn',
      element: { doop_id: 'cta', selector: '.cta' },
    })
    expect(result.findings[0]?.message).toContain('ΔE 0.35')
    expect(result.findings[0]?.message).toContain('#3B83F6')
    expect(result.findings[0]?.message).toContain('#3B82F6')
    expect(result.note).toBe('checked all 1 frames')
  })

  it('names the less used color, and the later value on a tie', () => {
    const tie = nearDuplicateColors([frame('f1', color('#3B82F6', 4), color('#3B83F6', 4))], 1)
    expect(tie.findings).toHaveLength(1)
    expect(tie.findings[0]?.message.startsWith('#3B83F6')).toBe(true)
  })

  it('gives 0 findings on a clean palette', () => {
    const palette = [color('#ffffff'), color('#111827'), color('#3B82F6'), color('#10B981'), color('#E11D48')]
    const result = nearDuplicateColors([frame('f1', ...palette)], 1)
    expect(result.findings).toEqual([])
    expect(result.note).toBe('checked all 1 frames')
  })

  it('gives 0 for the same color written two ways: ΔE must be over 0', () => {
    const result = nearDuplicateColors([frame('f1', color('#3B82F6', 3), color('rgb(59, 130, 246)', 2))], 1)
    expect(result.findings).toEqual([])
  })
})

describe('near-duplicate-color: the boundary at ΔE 3', () => {
  it('flags a pair at ΔE 2.95 and not a pair at ΔE 3.30', () => {
    expect(colorDistance('#808080', '#888888')).toBeLessThan(3)
    expect(colorDistance('#808080', '#898989')).toBeGreaterThan(3)
    expect(nearDuplicateColors([frame('f1', color('#808080', 2), color('#888888'))], 1).findings).toHaveLength(1)
    expect(nearDuplicateColors([frame('f1', color('#808080', 2), color('#898989'))], 1).findings).toEqual([])
  })

  it('uses ΔE2000: a pair 3.3 apart in ΔE1976 is still flagged at 0.95', () => {
    const result = nearDuplicateColors([frame('f1', color('rgb(0, 0, 255)', 3), color('rgb(0, 0, 247)'))], 1)
    expect(result.findings).toHaveLength(1)
  })
})

describe('near-duplicate-color: aggregation', () => {
  it('compares colors across frames and attaches the finding to the frame that uses the minor color', () => {
    const result = nearDuplicateColors(
      [frame('f1', color('#3B82F6', 5)), frame('f2', color('#3B83F6', 1, '.pay'), color('#3B82F6', 2))],
      2,
    )
    expect(result.findings.map((f) => f.frame_id)).toEqual(['f2'])
    expect(result.findings[0]?.message).toContain('#3B83F6 (1 use) is ΔE 0.35 from #3B82F6 (7 uses)')
  })

  it('reports one finding per minor color, against its nearest more-used neighbor', () => {
    const result = nearDuplicateColors([frame('f1', color('#808080', 9), color('#838383', 2), color('#858585', 1))], 1)
    expect(result.findings.map((f) => f.message.slice(0, 7))).toEqual(['#838383', '#858585'])
  })

  it('ignores colors that are not opaque or cannot be parsed', () => {
    const result = nearDuplicateColors(
      [frame('f1', color('#3B82F6', 3), color('rgba(59, 131, 246, 0.5)'), color('not-a-color'))],
      1,
    )
    expect(result.findings).toEqual([])
  })
})

describe('near-duplicate-color: a capped or filtered run', () => {
  it('says "considered N of M frames" in each finding and never "clean"', () => {
    const frames = [frame('f1', color('#3B82F6', 3), color('#3B83F6')), frame('f2'), frame('f3')]
    const result = nearDuplicateColors(frames, 10)
    expect(result.considered).toBe(3)
    expect(result.total).toBe(10)
    expect(result.findings[0]?.message).toContain('considered 3 of 10 frames')
    expect(result.note).toBe('considered 3 of 10 frames')
  })

  it('has a note with the same words when the capped run found nothing, and the note never says clean', () => {
    const result = nearDuplicateColors([frame('f1', color('#3B82F6')), frame('f2')], 24)
    expect(result.findings).toEqual([])
    expect(result.note).toBe('considered 2 of 24 frames')
    expect(result.note).not.toMatch(/clean/i)
  })

  it('does not count a frame whose colors were cut at the cap as considered', () => {
    const cut: ColorFrame = { frame_id: 'f2', colors: [color('#808080')], colors_capped: true }
    const result = nearDuplicateColors([frame('f1', color('#3B82F6')), cut], 2)
    expect(result.considered).toBe(1)
    expect(result.note).toBe('considered 1 of 2 frames')
  })

  it('compares a large palette without comparing every pair', () => {
    const many = Array.from({ length: 600 }, (_, i) => {
      const hex = (n: number) => n.toString(16).padStart(2, '0')
      return color(`#${hex(i % 256)}${hex((i * 7) % 256)}${hex((i * 13) % 256)}`, 1, `.c${i}`)
    })
    const started = performance.now()
    nearDuplicateColors([frame('f1', ...many)], 1)
    expect(performance.now() - started).toBeLessThan(5000)
  })
})
