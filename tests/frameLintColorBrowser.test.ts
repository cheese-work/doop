import { describe, expect, it } from 'vitest'
import { FACT_COLOR_CAP } from '../shared/frameLint.ts'
import { nearDuplicateColors, type ColorFrame } from '../shared/frameLintColor.ts'
import { lintFrame, type LintRenderInput } from '../server/frameLint.ts'
import { findBrowserPath } from '../server/screenshot.ts'

/* S7 of the CHE-9115 plan (fl-r1): rule 17 on a real render. The collector reads computed colors, so a token and a
   literal give the same rendered color; Hallmark gate 48 (literals only) is silent on tokens. */

const FRAME = { width: 393, height: 852 }
const signal = () => new AbortController().signal

function page(head: string, body: string): string {
  return `<!doctype html><html><head><style>
    html,body{margin:0;padding:0;font-family:'DejaVu Sans',sans-serif;font-size:16px}${head}
  </style></head><body>${body}</body></html>`
}

async function colorsOf(html: string): Promise<ColorFrame> {
  const input: LintRenderInput = { frame: { id: 'f1', html, ...FRAME }, viewport: { ...FRAME } }
  const result = await lintFrame(input, { signal: signal() })
  expect(result.status).toBe('ok')
  return { frame_id: 'f1', colors: result.colors ?? [], colors_capped: result.colors_capped }
}

const NEAR_LITERALS = page(
  '',
  `<button data-doop-id="pay" style="background:#3B82F6;border:0;height:44px;width:120px"></button>
   <button data-doop-id="pay-2" style="background:#3B83F6;border:0;height:44px;width:120px"></button>
   <button style="background:#3B82F6;border:0;height:44px;width:120px"></button>`,
)

/* gate 48's boundary: both colors are tokens in the token block, so a literal check sees nothing */
const NEAR_TOKENS = page(
  ':root{--color-surface:#808080;--color-surface-2:#838383}',
  `<div data-doop-id="card" style="background:var(--color-surface);height:40px"></div>
   <div data-doop-id="card-2" style="background:var(--color-surface-2);height:40px"></div>
   <div style="background:var(--color-surface);height:40px"></div>`,
)

const CLEAN = page(
  '',
  `<div style="background:#ffffff;color:#111827;height:60px">Title</div>
   <div style="background:#3B82F6;height:60px"></div>
   <div style="background:#10B981;height:60px"></div>`,
)

describe.skipIf(!findBrowserPath())('near-duplicate-color on a real render', () => {
  it('collects the rendered colors, with the first element that uses each', async () => {
    const frame = await colorsOf(NEAR_LITERALS)
    const blue = frame.colors.find((c) => c.value === 'rgb(59, 130, 246)')
    expect(blue).toMatchObject({ count: 2, doop_id: 'pay', selector: '[data-doop-id="pay"]' })
    expect(frame.colors.find((c) => c.value === 'rgb(59, 131, 246)')).toMatchObject({ count: 1, doop_id: 'pay-2' })
    expect(frame.colors_capped).toBe(false)
  })

  it('gives 1 finding for #3B82F6 and #3B83F6', async () => {
    const result = nearDuplicateColors([await colorsOf(NEAR_LITERALS)], 1)
    expect(result.findings).toHaveLength(1)
    expect(result.findings[0]).toMatchObject({
      rule: 'near-duplicate-color',
      element: { doop_id: 'pay-2' },
    })
  })

  it('gives 1 finding for two token colors at ΔE 1.2: the gate 48 boundary', async () => {
    const result = nearDuplicateColors([await colorsOf(NEAR_TOKENS)], 1)
    expect(result.findings).toHaveLength(1)
    expect(result.findings[0]?.message).toContain('ΔE 1.')
    expect(result.findings[0]?.element?.doop_id).toBe('card-2')
  })

  it('gives 0 findings on a clean page', async () => {
    const result = nearDuplicateColors([await colorsOf(CLEAN)], 1)
    expect(result.findings).toEqual([])
    expect(result.note).toBe('checked all 1 frames')
  })

  it('counts a text color only for an element that holds text, and leaves out transparent and translucent colors', async () => {
    const frame = await colorsOf(
      page(
        '',
        `<div style="color:#FF0000"><div style="height:20px"></div></div>
         <p style="color:#00FF00;margin:0">words</p>
         <div style="background:rgba(59, 130, 246, 0.5);height:20px"></div>`,
      ),
    )
    const values = frame.colors.map((c) => c.value)
    expect(values).toContain('rgb(0, 255, 0)')
    expect(values).not.toContain('rgb(255, 0, 0)')
    expect(values.some((v) => v.includes('0.5') || v.includes('/'))).toBe(false)
    expect(values).not.toContain('rgba(0, 0, 0, 0)')
  })

  it('keeps the first FACT_COLOR_CAP distinct colors and says it cut the rest', async () => {
    const swatches = Array.from(
      { length: FACT_COLOR_CAP + 20 },
      (_, i) => `<div style="background:rgb(${i % 256}, ${Math.floor(i / 256) + 1}, 7);height:2px"></div>`,
    ).join('')
    const frame = await colorsOf(page('', swatches))
    expect(frame.colors).toHaveLength(FACT_COLOR_CAP)
    expect(frame.colors_capped).toBe(true)
    expect(nearDuplicateColors([frame], 1).considered).toBe(0)
  })
})
