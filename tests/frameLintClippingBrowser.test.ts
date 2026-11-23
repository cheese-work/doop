import { describe, expect, it } from 'vitest'
import { lintFrame, type LintRenderInput } from '../server/frameLint.ts'
import { findBrowserPath } from '../server/screenshot.ts'

/* S4 of the CHE-9115 plan (fl-r1): rules 1 `border-clipped`, 2 `text-clipped`, 4 `control-occluded` and
   16 `radius-bleed` on a real render. Fixtures set DejaVu Sans with explicit sizes (plan risk 1). Each case also
   asserts that no other rule fires, so a fixture proves its own rule and nothing else. The Hallmark gate 73 and F25
   boundary fixtures sit next to their rules. */

const FRAME = { width: 393, height: 852 }
const signal = () => new AbortController().signal

function page(body: string): string {
  return `<!doctype html><html><head><style>
    html,body{margin:0;padding:0;font-family:'DejaVu Sans',sans-serif;font-size:16px}
    *{box-sizing:border-box}
  </style></head><body>${body}</body></html>`
}

function input(html: string, over: Partial<LintRenderInput> = {}): LintRenderInput {
  return { frame: { id: 'f1', html, ...FRAME }, viewport: { ...FRAME }, ...over }
}

async function rulesOf(html: string, over: Partial<LintRenderInput> = {}) {
  const result = await lintFrame(input(html, over), { signal: signal() })
  expect(result.status).toBe('ok')
  return result
}

describe.skipIf(!findBrowserPath())('border-clipped on a real render', () => {
  it('flags a bordered box whose right edge an overflow:hidden parent cuts off', async () => {
    const result = await rulesOf(
      page(`<div style="width:300px;overflow:hidden">
        <div data-doop-id="field" style="width:320px;height:40px;border:1px solid #333"></div>
      </div>`),
    )
    expect(result.findings.map((f) => f.rule)).toEqual(['border-clipped'])
    expect(result.findings[0]).toMatchObject({ level: 'warn', element: { doop_id: 'field' } })
    expect(result.findings[0]?.message).toContain('right')
  })

  it('gives 0 findings when the bordered box fits its overflow:hidden parent', async () => {
    const result = await rulesOf(
      page(`<div style="width:300px;overflow:hidden">
        <div style="width:300px;height:40px;border:1px solid #333"></div>
      </div>`),
    )
    expect(result.findings).toEqual([])
  })

  it('gives 0 findings when the cut side has no border', async () => {
    const result = await rulesOf(
      page(`<div style="width:300px;overflow:hidden">
        <div style="width:320px;height:40px;border-left:1px solid #333"></div>
      </div>`),
    )
    expect(result.findings).toEqual([])
  })

  it('gives 0 findings in a scroll container, where the box scrolls into view', async () => {
    const result = await rulesOf(
      page(`<div style="width:300px;overflow:auto">
        <div style="width:320px;height:40px;border:1px solid #333"></div>
      </div>`),
    )
    expect(result.findings).toEqual([])
  })

  it('gives 0 findings for an absolute box that escapes the clip of a non-positioned ancestor', async () => {
    const result = await rulesOf(
      page(`<div style="position:relative;height:100px">
        <div style="width:300px;overflow:hidden">
          <div style="position:absolute;left:0;top:0;width:320px;height:40px;border:1px solid #333"></div>
        </div>
      </div>`),
    )
    expect(result.findings).toEqual([])
  })
})

describe.skipIf(!findBrowserPath())('text-clipped on a real render', () => {
  const LABEL = `<div style="width:140px;overflow:hidden;white-space:nowrap;font-size:1rem" data-doop-id="label">Notifications</div>`

  it('flags text that an overflow:hidden box cuts', async () => {
    const result = await rulesOf(
      page(
        `<div style="width:100px;overflow:hidden;white-space:nowrap" data-doop-id="label">Notifications and more</div>`,
      ),
    )
    expect(result.findings.map((f) => f.rule)).toEqual(['text-clipped'])
    expect(result.findings[0]).toMatchObject({ element: { doop_id: 'label' } })
  })

  it('gives 0 findings when the text fits', async () => {
    const result = await rulesOf(page(LABEL))
    expect(result.findings).toEqual([])
  })

  it('flags the same label at fontScale 2, where scale 1 does not (the variant fixture)', async () => {
    const at1 = await rulesOf(page(LABEL), { fontScale: 1 })
    expect(at1.findings).toEqual([])
    const at2 = await rulesOf(page(LABEL), { fontScale: 2 })
    expect(at2.applied?.fontScale).toBe(2)
    expect(at2.findings.map((f) => f.rule)).toEqual(['text-clipped'])
    expect(at2.findings[0]).toMatchObject({ element: { doop_id: 'label' } })
  })

  it('gives 0 findings on the F25 boundary: text hidden by display:none at 320 px', async () => {
    const result = await rulesOf(
      page(`<div style="width:100px;overflow:hidden;white-space:nowrap">
        <span style="display:none">Words shown at 1440 and hidden on a phone, much too long for the box</span>ok
      </div>`),
      { viewport: { width: 320, height: 852 } },
    )
    expect(result.findings).toEqual([])
  })

  it('gives 0 findings for text hidden by visibility:hidden', async () => {
    const result = await rulesOf(
      page(
        `<div style="width:100px;overflow:hidden;white-space:nowrap;visibility:hidden">Notifications and more</div>`,
      ),
    )
    expect(result.findings).toEqual([])
  })

  it('flags the F25 case at 320 px: text cut by overflow:hidden', async () => {
    const result = await rulesOf(
      page(`<div style="width:100px;overflow:hidden;white-space:nowrap">Words shown at 1440 and cut on a phone</div>`),
      { viewport: { width: 320, height: 852 } },
    )
    expect(result.findings.map((f) => f.rule)).toEqual(['text-clipped'])
  })

  it('gives 0 findings for an intentional ellipsis truncation', async () => {
    const result = await rulesOf(
      page(
        `<div style="width:100px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis">Notifications and more</div>`,
      ),
    )
    expect(result.findings).toEqual([])
  })

  it('flags the lines a fixed-height box cuts off', async () => {
    const result = await rulesOf(
      page(
        `<p style="width:120px;height:30px;overflow:hidden;margin:0;line-height:20px">one two three four five six seven eight</p>`,
      ),
    )
    expect(result.findings.map((f) => f.rule)).toEqual(['text-clipped'])
  })
})

describe.skipIf(!findBrowserPath())('control-occluded on a real render', () => {
  const scrim = `<div data-doop-id="scrim" style="position:absolute;left:0;top:0;width:200px;height:200px;background:rgba(0,0,0,.3)"></div>`

  it('flags a covered icon-only button', async () => {
    const result = await rulesOf(
      page(
        `<button aria-label="Close" data-doop-id="close" style="position:absolute;left:20px;top:20px;width:44px;height:44px"><svg width="16" height="16" aria-hidden="true"><circle cx="8" cy="8" r="6"/></svg></button>${scrim}`,
      ),
    )
    expect(result.findings.map((f) => f.rule)).toEqual(['control-occluded'])
    expect(result.findings[0]).toMatchObject({ level: 'error', element: { doop_id: 'close' } })
    expect(result.findings[0]?.message).toContain('scrim')
  })

  it('flags a covered input', async () => {
    const result = await rulesOf(
      page(
        `<input aria-label="Email" data-doop-id="email" style="position:absolute;left:20px;top:20px;width:160px;height:36px">${scrim}`,
      ),
    )
    expect(result.findings.map((f) => f.rule)).toEqual(['control-occluded'])
    expect(result.findings[0]).toMatchObject({ element: { doop_id: 'email' } })
  })

  it('gives 0 findings on the gate 73 boundary: a covered paragraph and a covered text button', async () => {
    const result = await rulesOf(
      page(`<p style="position:absolute;left:20px;top:20px;margin:0">Covered paragraph text</p>
        <button style="position:absolute;left:20px;top:80px;width:120px;height:36px">Pay now</button>${scrim}`),
    )
    expect(result.findings).toEqual([])
  })

  it('gives 0 findings for an icon-only button nothing covers', async () => {
    const result = await rulesOf(
      page(
        `<button aria-label="Close" style="position:absolute;left:20px;top:20px;width:44px;height:44px"><svg width="16" height="16" aria-hidden="true"><circle cx="8" cy="8" r="6"/></svg></button>`,
      ),
    )
    expect(result.findings).toEqual([])
  })

  it('gives 0 findings for a control that is not clickable anyway (pointer-events:none)', async () => {
    const result = await rulesOf(
      page(
        `<button aria-label="Close" style="position:absolute;left:20px;top:20px;width:44px;height:44px;pointer-events:none"><svg width="16" height="16"><circle cx="8" cy="8" r="6"/></svg></button>${scrim}`,
      ),
    )
    expect(result.findings).toEqual([])
  })

  it('gives 0 findings when the control sits inside the label that covers it', async () => {
    const result = await rulesOf(
      page(`<style>label{position:relative;display:block;width:160px;height:40px}
        label::after{content:'';position:absolute;inset:0}</style>
        <label><input aria-label="Agree" type="checkbox" style="position:absolute;left:0;top:0;width:20px;height:20px"></label>`),
    )
    expect(result.findings).toEqual([])
  })
})

describe.skipIf(!findBrowserPath())('radius-bleed on a real render', () => {
  const card = (inner: string) =>
    `<div data-doop-id="card" style="margin:20px;width:300px;height:200px;border-radius:16px;background:#fff;border:0">${inner}</div>`

  it('flags a painted child whose square corners poke out of the rounded card', async () => {
    const result = await rulesOf(page(card(`<div data-doop-id="hero" style="height:100px;background:#36c"></div>`)))
    expect(result.findings.map((f) => f.rule)).toEqual(['radius-bleed'])
    expect(result.findings[0]).toMatchObject({ level: 'warn', element: { doop_id: 'hero' } })
    expect(result.findings[0]?.message).toContain('top-left')
  })

  it('flags the cut when the card clips its overflow', async () => {
    const result = await rulesOf(
      page(
        `<div data-doop-id="card" style="margin:20px;width:300px;height:200px;border-radius:16px;overflow:hidden;background:#fff">
          <div data-doop-id="hero" style="height:100px;border:2px solid #36c"></div></div>`,
      ),
    )
    expect(result.findings.map((f) => f.rule)).toEqual(['radius-bleed'])
    expect(result.findings[0]?.message).toContain('cuts')
  })

  it('gives 0 findings when the child carries the same radius at the corners', async () => {
    const result = await rulesOf(
      page(card(`<div style="height:100px;background:#36c;border-radius:16px 16px 0 0"></div>`)),
    )
    expect(result.findings).toEqual([])
  })

  it('gives 0 findings when the child is inset past the curve', async () => {
    const result = await rulesOf(page(card(`<div style="margin:16px;height:100px;background:#36c"></div>`)))
    expect(result.findings).toEqual([])
  })

  it('gives 0 findings for an unpainted wrapper', async () => {
    const result = await rulesOf(page(card(`<div style="height:100px"></div>`)))
    expect(result.findings).toEqual([])
  })
})

describe.skipIf(!findBrowserPath())('a clean frame', () => {
  it('gives 0 findings across all four rules', async () => {
    const result = await rulesOf(
      page(`
        <header style="height:80px;padding:16px">Account</header>
        <div style="margin:20px;border-radius:16px;background:#f5f5f5;padding:16px;overflow:hidden">
          <div style="border:1px solid #999;border-radius:8px;padding:8px;width:100%">Notifications</div>
          <button aria-label="Close" style="margin-top:12px;width:44px;height:44px"><svg width="16" height="16" aria-hidden="true"><circle cx="8" cy="8" r="6"/></svg></button>
          <input aria-label="Email" style="display:block;margin-top:12px;width:200px;height:36px">
        </div>`),
    )
    expect(result.findings).toEqual([])
  })
})
