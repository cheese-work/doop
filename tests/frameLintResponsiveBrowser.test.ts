import { describe, expect, it } from 'vitest'
import { lintFrame } from '../server/frameLint.ts'
import { findBrowserPath } from '../server/screenshot.ts'

/* S8 of the CHE-9115 plan (fl-r1): the kept frame rules at 320 px (rules 1, 2, 3, 4 and 16) and rule 21 `focus-order`,
   on a real render. `lint_frames` lints every frame at its own size and at 320 px wide with the frame's height, so each
   fixture here is one frame of 393 x 852 linted at both widths. Fixtures set DejaVu Sans with explicit sizes (plan
   risk 1). A fixture proves its own rule and nothing else. */

const FRAME = { width: 393, height: 852 }
const signal = () => new AbortController().signal

function page(body: string): string {
  return `<!doctype html><html><head><style>
    html,body{margin:0;padding:0;font-family:'DejaVu Sans',sans-serif;font-size:16px}
    *{box-sizing:border-box}
  </style></head><body>${body}</body></html>`
}

/** the findings of one frame at one width, with the frame's own height */
async function at(html: string, width: number) {
  const result = await lintFrame(
    { frame: { id: 'f1', html, ...FRAME }, viewport: { width, height: FRAME.height } },
    { signal: signal() },
  )
  expect(result.status).toBe('ok')
  return result.findings
}

const rules = (findings: Array<{ rule: string }>) => findings.map((f) => f.rule)

describe.skipIf(!findBrowserPath())('the 320 px pass on a real render', () => {
  it('rule 16: a child bleeds past the card radius only at 320 px', async () => {
    const html = page(`<style>
        .card{margin:16px;height:200px;border-radius:24px;background:#fff}
        .hero{margin:24px;height:100px;background:#36c}
        @media (max-width:340px){.hero{margin:0}}
      </style>
      <div class="card" data-doop-id="card"><div class="hero" data-doop-id="hero"></div></div>`)
    expect(await at(html, 393)).toEqual([])
    const narrow = await at(html, 320)
    expect(rules(narrow)).toEqual(['radius-bleed'])
    expect(narrow[0]).toMatchObject({ viewport: { width: 320, height: 852 }, element: { doop_id: 'hero' } })
  })

  it('rule 2: a label clips only at 320 px', async () => {
    const html = page(
      `<div style="margin:0 16px;overflow:hidden;white-space:nowrap" data-doop-id="label">Notification settings and preferences</div>`,
    )
    expect(await at(html, 393)).toEqual([])
    const narrow = await at(html, 320)
    expect(rules(narrow)).toEqual(['text-clipped'])
    expect(narrow[0]).toMatchObject({ viewport: { width: 320, height: 852 }, element: { doop_id: 'label' } })
  })

  it('rule 3: content reflows past the bottom edge only at 320 px', async () => {
    const html = page(`<div style="height:760px"></div>
      <p data-doop-id="note" style="margin:0 16px;font-size:16px;line-height:24px">Your order ships in two days and you can follow it from the orders screen, or from the notification we send.</p>`)
    expect(await at(html, 393)).toEqual([])
    const narrow = await at(html, 320)
    expect(rules(narrow)).toEqual(['outside-frame'])
    expect(narrow[0]).toMatchObject({ viewport: { width: 320, height: 852 }, element: { doop_id: 'note' } })
  })

  it('rule 1: a field one px too wide for its card is cut only at 320 px', async () => {
    const html = page(`<div style="margin:0 16px;overflow:hidden">
        <div data-doop-id="field" style="width:361px;height:40px;border:1px solid #333"></div>
      </div>`)
    expect(await at(html, 393)).toEqual([])
    const narrow = await at(html, 320)
    expect(rules(narrow)).toEqual(['border-clipped'])
    expect(narrow[0]).toMatchObject({ element: { doop_id: 'field' } })
  })

  it('rule 4: a bar covers an icon-only button only at 320 px', async () => {
    const html = page(`<style>
        .bar{position:absolute;top:0;height:60px;left:0;width:200px;background:#ddd}
        @media (max-width:340px){.bar{width:320px}}
      </style>
      <button data-doop-id="close" aria-label="Close" style="position:absolute;left:250px;top:8px;width:44px;height:44px"><svg width="16" height="16" aria-hidden="true"><circle cx="8" cy="8" r="6"/></svg></button>
      <div class="bar"></div>`)
    expect(await at(html, 393)).toEqual([])
    const narrow = await at(html, 320)
    expect(rules(narrow)).toEqual(['control-occluded'])
    expect(narrow[0]).toMatchObject({ viewport: { width: 320, height: 852 }, element: { doop_id: 'close' } })
  })

  it('a clean frame gives 0 findings at both widths', async () => {
    const html = page(`
      <header style="height:80px;padding:16px">Account</header>
      <div style="margin:16px;border-radius:16px;background:#f5f5f5;padding:16px;overflow:hidden">
        <div style="border:1px solid #999;border-radius:8px;padding:8px;width:100%">Notifications</div>
        <button aria-label="Close" style="margin-top:12px;width:44px;height:44px"><svg width="16" height="16" aria-hidden="true"><circle cx="8" cy="8" r="6"/></svg></button>
        <input aria-label="Email" style="display:block;margin-top:12px;width:200px;height:36px">
      </div>`)
    expect(await at(html, 393)).toEqual([])
    expect(await at(html, 320)).toEqual([])
  })
})

describe.skipIf(!findBrowserPath())('focus-order on a real render', () => {
  const buttons = (a: string, b: string) =>
    page(`<button data-doop-id="a"${a} style="height:44px;width:120px">First</button>
      <button data-doop-id="b"${b} style="height:44px;width:120px">Second</button>
      <button data-doop-id="c" style="height:44px;width:120px">Third</button>`)

  it('flags tabindex="3" before tabindex="1"', async () => {
    const found = await at(buttons(' tabindex="3"', ' tabindex="1"'), 393)
    expect(rules(found)).toEqual(['focus-order', 'focus-order'])
    expect(found.map((f) => f.element?.doop_id)).toEqual(['a', 'b'])
    expect(found[0]?.message).toContain('tabindex="3"')
  })

  it('gives 0 findings for natural order, tabindex="0" and tabindex="-1"', async () => {
    expect(await at(buttons('', ''), 393)).toEqual([])
    expect(await at(buttons(' tabindex="0"', ' tabindex="-1"'), 393)).toEqual([])
  })

  it('ignores a positive tabindex on a control that is hidden, disabled or not rendered', async () => {
    const html = page(`<button tabindex="2" disabled style="height:44px">Off</button>
      <button tabindex="2" style="display:none">Gone</button>
      <button tabindex="2" style="visibility:hidden;height:44px">Hidden</button>
      <button style="height:44px">Fine</button>`)
    expect(await at(html, 393)).toEqual([])
  })

  it('finds a positive tabindex on a non-native control such as a div', async () => {
    const html = page(
      `<button style="height:44px">Native</button><div role="button" aria-label="Pick" tabindex="4" data-doop-id="pick" style="height:44px">Pick</div>`,
    )
    const found = await at(html, 393)
    expect(found.map((f) => f.element?.doop_id)).toEqual(['pick'])
  })
})
