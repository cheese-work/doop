import { describe, expect, it } from 'vitest'
import { lintConfiguredPage, lintFrame, type LintRenderInput } from '../server/frameLint.ts'
import { findBrowserPath, loadFrameInto, withRenderPage } from '../server/screenshot.ts'

/* S2 of the CHE-9115 plan (fl-r1): rule 3 `outside-frame` on a real render. Fixtures set DejaVu Sans with explicit
   sizes so the metrics match the live image (plan risk 1). */

const FRAME = { width: 393, height: 852 }
const signal = () => new AbortController().signal

function page(body: string): string {
  return `<!doctype html><html><head><style>
    html,body{margin:0;padding:0;font-family:'DejaVu Sans',sans-serif;font-size:16px}
  </style></head><body>${body}</body></html>`
}

function input(html: string): LintRenderInput {
  return { frame: { id: 'f1', html, ...FRAME }, viewport: { ...FRAME } }
}

const BOTTOM_BAR = page(`
  <div style="height:700px">content</div>
  <div data-doop-id="tab-bar" style="position:absolute;top:900px;left:0;width:393px;height:60px">Home</div>`)

/* gate 34's case: a child wider than the frame. The page scrolls sideways in Hallmark; nothing is cut at the bottom. */
const WIDE_CHILD = page(`<div data-doop-id="wide" style="width:420px;height:40px">wide</div>`)

const CLEAN = page(`
  <div style="height:80px">header</div>
  <div style="height:600px">content</div>
  <div data-doop-id="tab-bar" style="height:60px">Home</div>`)

describe.skipIf(!findBrowserPath())('outside-frame on a real render', () => {
  it('flags the bottom bar pushed to top:900px in a 393 x 852 frame', async () => {
    const result = await lintFrame(input(BOTTOM_BAR), { signal: signal() })
    expect(result.status).toBe('ok')
    expect(result.findings).toHaveLength(1)
    expect(result.findings[0]).toMatchObject({
      rule: 'outside-frame',
      level: 'error',
      viewport: { width: 393, height: 852 },
      element: { doop_id: 'tab-bar', selector: '[data-doop-id="tab-bar"]' },
    })
    expect(result.findings[0]?.message).toContain('108px past the bottom edge of the 852px frame')
  })

  it('gives 0 findings on the gate 34 boundary: a 420 px child in a 393 px frame', async () => {
    const result = await lintFrame(input(WIDE_CHILD), { signal: signal() })
    expect(result.status).toBe('ok')
    expect(result.findings).toEqual([])
  })

  it('gives 0 findings on a clean frame', async () => {
    const result = await lintFrame(input(CLEAN), { signal: signal() })
    expect(result.status).toBe('ok')
    expect(result.findings).toEqual([])
  })

  it('narrows to the rule ids asked for', async () => {
    const result = await lintFrame(input(BOTTOM_BAR), { rules: ['some-other-rule'], signal: signal() })
    expect(result.status).toBe('ok')
    expect(result.findings).toEqual([])
  })

  it('does not flag content an overflow:hidden ancestor clips', async () => {
    const clipped = page(`
      <div style="height:800px;overflow:hidden"><div style="height:2000px">tall</div></div>`)
    const result = await lintFrame(input(clipped), { signal: signal() })
    expect(result.findings).toEqual([])
  })

  it('lints a page the caller set up, with the same collector and rules', async () => {
    const result = await withRenderPage('lint test', 20_000, async (renderPage) => {
      await loadFrameInto(renderPage, { html: BOTTOM_BAR, ...FRAME })
      return lintConfiguredPage(renderPage, { frameId: 'f1', viewport: { ...FRAME } }, { signal: signal() })
    })
    expect(result.status).toBe('ok')
    expect(result.findings.map((f) => f.element?.doop_id)).toEqual(['tab-bar'])
  })
})

/* S5 of the CHE-9115 plan (fl-r1): rules 8 `interactive-name` and 7 `target-spacing` through axe-core 4.14.1,
   injected with `page.evaluate(axe.source)`. The gate 33 and gate 39b boundary fixtures stay silent. */
describe.skipIf(!findBrowserPath())('control names and target spacing with axe', () => {
  const byRule = <T extends { rule: string }>(findings: T[], rule: string) => findings.filter((f) => f.rule === rule)

  it('flags an icon-only <button> whose svg is aria-hidden (rule 8)', async () => {
    const html = page(
      `<button data-doop-id="icon-btn" style="width:44px;height:44px"><svg aria-hidden="true" width="16" height="16"><circle cx="8" cy="8" r="6"/></svg></button>`,
    )
    const result = await lintFrame(input(html), { signal: signal() })
    expect(result.status).toBe('ok')
    expect(result.findings).toHaveLength(1)
    expect(result.findings[0]).toMatchObject({
      rule: 'interactive-name',
      level: 'error',
      viewport: { width: 393, height: 852 },
      element: { doop_id: 'icon-btn', selector: '[data-doop-id="icon-btn"]' },
    })
  })

  it('gives 0 on the gate 33 boundary: a named button around an unlabelled svg', async () => {
    const html = page(
      `<button aria-label="Close" style="width:44px;height:44px"><svg width="16" height="16"><circle cx="8" cy="8" r="6"/></svg></button>`,
    )
    const result = await lintFrame(input(html), { signal: signal() })
    expect(result.findings).toEqual([])
  })

  it('flags an unnamed link, an unlabelled field and an unnamed submit input', async () => {
    const html = page(`
      <a href="#x" data-doop-id="bare-link" style="display:block;width:100px;height:44px"><svg aria-hidden="true" width="8" height="8"></svg></a>
      <input data-doop-id="bare-field" type="text" style="display:block;width:200px;height:44px">
      <input data-doop-id="bare-submit" type="submit" value="" style="display:block;width:200px;height:44px">`)
    const result = await lintFrame(input(html), { signal: signal() })
    /* axe reports by its own rule order, so compare as a set */
    expect(
      byRule(result.findings, 'interactive-name')
        .map((f) => f.element?.doop_id)
        .sort(),
    ).toEqual(['bare-field', 'bare-link', 'bare-submit'])
  })

  it('flags two 20 x 20 buttons 2 px apart once (rule 7)', async () => {
    const html = page(`
      <div style="display:flex;gap:2px;padding:20px">
        <button data-doop-id="a" aria-label="A" style="width:20px;height:20px;padding:0"></button>
        <button data-doop-id="b" aria-label="B" style="width:20px;height:20px;padding:0"></button>
      </div>`)
    const result = await lintFrame(input(html), { signal: signal() })
    expect(result.status).toBe('ok')
    expect(result.findings).toHaveLength(1)
    expect(result.findings[0]).toMatchObject({ rule: 'target-spacing', level: 'warn' })
  })

  it('gives 0 on the gate 39b boundary: one isolated 20 x 20 button, and 44 px controls side by side', async () => {
    const isolated = page(
      `<div style="padding:40px"><button aria-label="Solo" style="width:20px;height:20px;padding:0"></button></div>`,
    )
    expect((await lintFrame(input(isolated), { signal: signal() })).findings).toEqual([])
    const large = page(`
      <div style="display:flex;gap:2px;padding:20px">
        <button aria-label="A" style="width:44px;height:44px"></button>
        <button aria-label="B" style="width:44px;height:44px"></button>
      </div>`)
    expect((await lintFrame(input(large), { signal: signal() })).findings).toEqual([])
  })

  it('gives 0 findings on a clean frame with named, well-spaced controls', async () => {
    const html = page(`
      <button data-doop-id="pay" style="width:200px;height:48px">Pay now</button>
      <a href="#terms" style="display:inline-block;margin:24px;padding:12px">Terms</a>
      <label>Email <input type="email" style="width:200px;height:44px"></label>`)
    const result = await lintFrame(input(html), { signal: signal() })
    expect(result.status).toBe('ok')
    expect(result.findings).toEqual([])
  })

  it('does not run axe when only other rules are asked for', async () => {
    const html = page(
      `<button data-doop-id="icon-btn" style="width:44px;height:44px"><svg aria-hidden="true"></svg></button>`,
    )
    const result = await lintFrame(input(html), { rules: ['outside-frame'], signal: signal() })
    expect(result.status).toBe('ok')
    expect(result.findings).toEqual([])
  })

  it('still runs axe under a strict frame CSP (default-src none)', async () => {
    const html = `<!doctype html><html><head>
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
      <style>html,body{margin:0}</style></head><body>
      <button data-doop-id="icon-btn" style="width:44px;height:44px"><svg aria-hidden="true"></svg></button></body></html>`
    const result = await lintFrame(input(html), { signal: signal() })
    expect(result.status).toBe('ok')
    expect(result.findings.map((f) => f.rule)).toEqual(['interactive-name'])
  })

  it('reports partial, never clean, when the page blocks the axe run', async () => {
    const html =
      page(`<script>Object.defineProperty(window,'axe',{get(){throw new Error('no')},configurable:false})</script>
      <button data-doop-id="icon-btn" style="width:44px;height:44px"><svg aria-hidden="true"></svg></button>`)
    const result = await lintFrame(input(html), { signal: signal() })
    expect(result.status).toBe('partial')
    expect(result.reason).toBe('axe did not run')
  })
})
