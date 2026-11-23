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
