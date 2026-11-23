import { describe, expect, it } from 'vitest'
import { lintFrame, type LintRenderInput } from '../server/frameLint.ts'
import { findBrowserPath } from '../server/screenshot.ts'

/* S2 variant contract (CHE-9115 plan, "Resolved-variant input boundary"): one `LintRenderInput` per variant cell.
   Uses only S2's own rule, `outside-frame`, in a 393 x 852 frame. The layout is a 450 px fixed block, an optional
   200 px error block, 10 rem of content and a 4 rem bottom bar:
     A  default HTML            bar 610-674 px      -> 0 findings
     B  error HTML (+200 px)    bar 810-874 px      -> 1 finding
     C  A at fontScale 2        bar 770-898 px      -> 1 finding */

const FRAME = { width: 393, height: 852 }
const signal = () => new AbortController().signal

function html(error: boolean): string {
  return `<!doctype html><html><head><style>
    html,body{margin:0;padding:0;font-family:'DejaVu Sans',sans-serif}
  </style></head><body>
    <div style="height:450px">hero</div>
    ${error ? '<div data-doop-id="error" style="height:200px">Something went wrong</div>' : ''}
    <div style="height:10rem">content</div>
    <div data-doop-id="bar" style="height:4rem">Home</div>
  </body></html>`
}

function cell(error: boolean, over: Partial<LintRenderInput> = {}): LintRenderInput {
  return { frame: { id: 'f1', html: html(error), ...FRAME }, viewport: { ...FRAME }, ...over }
}

describe.skipIf(!findBrowserPath())('the variant input contract', () => {
  it('cell A, the default HTML, gives 0 findings and reports the default inputs as applied', async () => {
    const result = await lintFrame(cell(false), { signal: signal() })
    expect(result.status).toBe('ok')
    expect(result.findings).toEqual([])
    expect(result.applied).toEqual({ colorScheme: 'light', lang: '', dir: 'ltr', fontScale: 1 })
  })

  it('cell B, the error-state HTML, pushes the bottom bar past the frame and gives 1 finding', async () => {
    const result = await lintFrame(cell(true), { signal: signal() })
    expect(result.status).toBe('ok')
    expect(result.findings.map((f) => f.element?.doop_id)).toEqual(['bar'])
  })

  it('cell C, cell A at fontScale 2, pushes the bottom bar past the frame and gives 1 finding', async () => {
    const result = await lintFrame(cell(false, { fontScale: 2 }), { signal: signal() })
    expect(result.status).toBe('ok')
    expect(result.findings.map((f) => f.element?.doop_id)).toEqual(['bar'])
    expect(result.applied?.fontScale).toBe(2)
  })

  it('reports the applied colorScheme, lang, dir and fontScale equal to the input', async () => {
    const input = cell(false, {
      media: { colorScheme: 'dark' },
      locale: { lang: 'ar', dir: 'rtl' },
      fontScale: 1.5,
    })
    const result = await lintFrame(input, { signal: signal() })
    expect(result.status).toBe('ok')
    expect(result.applied).toEqual({ colorScheme: 'dark', lang: 'ar', dir: 'rtl', fontScale: 1.5 })
  })
})
