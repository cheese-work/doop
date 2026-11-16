import { describe, expect, it } from 'vitest'
import {
  COMPLETENESS_RULESET,
  attestationRowsFor,
  checkPageCompleteness,
  currentAttestation,
  type CompletenessReport,
} from '../shared/designCompleteness.ts'
import type { Canvas, Frame } from '../shared/types.ts'

/* G3 (CHE-6078 r5, "Yêu cầu 5"): what makes a design direction complete, as a
   pure check over one page. The page below is the smallest complete one; each
   test removes exactly one thing and expects exactly that to be reported. */

const PAGE = 'c1:page1'

const RECON = {
  scanHash: 'scan-abc',
  candidates: [
    { id: 'kebab', file: 'comment-card.tsx', line: 823, decision: 'keep' },
    { id: 'sort-newest', file: 'display-parts.tsx', line: 29, decision: 'keep' },
    { id: 'sort-oldest', file: 'display-parts.tsx', line: 29, decision: 'keep' },
    { id: 'composer-newest', file: 'comment-composer.tsx', line: 10, decision: 'keep' },
    { id: 'composer-oldest', file: 'comment-composer.tsx', line: 10, decision: 'keep' },
    { id: 'legacy-badge', file: 'badge.tsx', line: 5, decision: 'remove', reason: 'replaced by the status chip' },
  ],
}

const MOTION = JSON.stringify({
  trigger: 'hover',
  property: 'opacity',
  duration: '200ms',
  easing: 'ease-out',
  reducedMotion: 'no animation',
})

const WIRE = `<div data-doop-stage="wireframe"><button data-doop-on="click" data-doop-action="navigate:hifi">Open</button></div>`
const HIFI = `<main>
  <button data-recon-ref="kebab">⋯</button>
  <button data-recon-ref="sort-newest">Newest first</button>
  <button data-recon-ref="sort-oldest">Oldest first</button>
  <div data-recon-ref="composer-newest"></div>
  <div data-recon-ref="composer-oldest"></div>
  <p data-doop-state="loading">…</p><p data-doop-state="empty">Nothing</p>
  <p data-doop-state="error">Failed</p><p data-doop-state="disconnected">Offline</p>
  <div data-doop-motion='${MOTION}'></div>
  <a data-doop-on="click" data-doop-action="navigate:wire">Back</a>
</main>`

function reconHtml(recon: unknown = RECON) {
  return `<script type="application/json" id="doop-recon">${JSON.stringify(recon)}</script>`
}

function frame(id: string, html: string, updatedAt = 100): Frame {
  return {
    id,
    canvasId: 'c1',
    name: id,
    x: 0,
    y: 0,
    width: 400,
    height: 300,
    html,
    createdAt: 1,
    updatedAt,
    updatedBy: 'a',
  }
}

function page(overrides: Record<string, string> = {}, startFrameId: string | null = 'wire'): Canvas {
  const html = { recon: reconHtml(), wire: WIRE, hifi: HIFI, ...overrides }
  return {
    id: 'c1',
    name: 'Proposal',
    pages: [{ id: PAGE, name: 'Direction A', ...(startFrameId ? { startFrameId } : {}) }],
    frames: [frame('recon', html.recon), frame('wire', html.wire), frame('hifi', html.hifi)],
  } as Canvas
}

const codes = (r: CompletenessReport) => r.missing.map((m) => m.code)
const details = (r: CompletenessReport, code: string) => r.missing.filter((m) => m.code === code).map((m) => m.detail)

describe('checkPageCompleteness', () => {
  it('passes a page that has every artefact', () => {
    const report = checkPageCompleteness(page(), PAGE)
    expect(report.missing).toEqual([])
    expect(report.complete).toBe(true)
    expect(report.ruleset).toBe(COMPLETENESS_RULESET)
    expect(report.scanHash).toBe('scan-abc')
  })

  it('reports a missing kebab menu (CHE-5452 case 1)', () => {
    const report = checkPageCompleteness(page({ hifi: HIFI.replace(' data-recon-ref="kebab"', '') }), PAGE)
    expect(report.complete).toBe(false)
    expect(codes(report)).toEqual(['recon_ref_missing'])
    expect(details(report, 'recon_ref_missing')[0]).toContain('kebab')
  })

  it('reports a missing sort direction, and only that one (CHE-5452 case 2)', () => {
    const report = checkPageCompleteness(page({ hifi: HIFI.replace(' data-recon-ref="sort-oldest"', '') }), PAGE)
    expect(codes(report)).toEqual(['recon_ref_missing'])
    expect(details(report, 'recon_ref_missing')[0]).toContain('sort-oldest')
    expect(details(report, 'recon_ref_missing')[0]).not.toContain('sort-newest')
  })

  it('reports a composer missing for one sort direction (CHE-5452 case 3)', () => {
    const report = checkPageCompleteness(page({ hifi: HIFI.replace(' data-recon-ref="composer-oldest"', '') }), PAGE)
    expect(codes(report)).toEqual(['recon_ref_missing'])
    expect(details(report, 'recon_ref_missing')[0]).toContain('composer-oldest')
  })

  it('says plainly that a composer drawn in the wrong place is the reviewer’s to catch', () => {
    /* the ref is there, only the position is wrong: the machine cannot see that */
    const wrong = HIFI.replace(
      '<div data-recon-ref="composer-oldest"></div>',
      '<footer data-recon-ref="composer-oldest"></footer>',
    )
    const report = checkPageCompleteness(page({ hifi: wrong }), PAGE)
    expect(report.complete).toBe(true)
    expect(report.reviewerNotes.join(' ')).toMatch(/reviewer/i)
    expect(report.reviewerNotes.join(' ')).toMatch(/data-recon-ref/)
  })

  it('does not count the recon frame’s own refs as design', () => {
    const recon = reconHtml() + '<i data-recon-ref="kebab"></i>'
    const report = checkPageCompleteness(page({ recon, hifi: HIFI.replace(' data-recon-ref="kebab"', '') }), PAGE)
    expect(codes(report)).toEqual(['recon_ref_missing'])
  })

  it('needs a recon inventory at all', () => {
    const canvas = page()
    canvas.frames = canvas.frames.filter((f) => f.id !== 'recon')
    expect(codes(checkPageCompleteness(canvas, PAGE))).toEqual(['recon_missing'])
  })

  it('rejects an inventory that is not valid JSON', () => {
    const bad = '<script type="application/json" id="doop-recon">{nope</script>'
    expect(codes(checkPageCompleteness(page({ recon: bad }), PAGE))).toEqual(['recon_invalid'])
  })

  it('treats a candidate with no decision as unhandled', () => {
    const recon = reconHtml({
      ...RECON,
      candidates: [...RECON.candidates, { id: 'extra-menu', file: 'x.tsx', line: 1 }],
    })
    const report = checkPageCompleteness(page({ recon }), PAGE)
    expect(codes(report)).toEqual(['recon_unresolved'])
    expect(details(report, 'recon_unresolved')[0]).toContain('extra-menu')
  })

  it('needs a reason for change, remove and n/a, not for keep', () => {
    const recon = reconHtml({
      ...RECON,
      candidates: [
        { id: 'kebab', decision: 'keep' },
        { id: 'a', decision: 'change' },
        { id: 'b', decision: 'remove', reason: ' ' },
        { id: 'c', decision: 'n/a' },
      ],
    })
    const html = '<i data-recon-ref="kebab"></i><i data-recon-ref="a"></i>'
    const report = checkPageCompleteness(page({ recon, hifi: HIFI + html }), PAGE)
    expect(details(report, 'recon_reason_missing').sort()).toEqual([
      expect.stringContaining('"a"'),
      expect.stringContaining('"b"'),
      expect.stringContaining('"c"'),
    ])
  })

  it('does not ask for a ref on remove or n/a', () => {
    /* legacy-badge is "remove" in RECON and has no ref in HIFI: the complete page above already shows it */
    expect(checkPageCompleteness(page(), PAGE).complete).toBe(true)
  })

  it('reports a page with no wireframe', () => {
    const report = checkPageCompleteness(page({ wire: WIRE.replace(' data-doop-stage="wireframe"', '') }), PAGE)
    expect(codes(report)).toEqual(['wireframe_missing'])
  })

  it('reports a page whose frames are all wireframes', () => {
    const report = checkPageCompleteness(page({ hifi: `<div data-doop-stage="wireframe">${HIFI}</div>` }), PAGE)
    expect(codes(report)).toEqual(['hifi_missing'])
  })

  it('reports a state the frames never draw', () => {
    const report = checkPageCompleteness(page({ hifi: HIFI.replace('data-doop-state="error"', '') }), PAGE)
    expect(codes(report)).toEqual(['state_missing'])
    expect(details(report, 'state_missing')[0]).toContain('error')
  })

  it('accepts a state marked not applicable with a reason, rejects one without', () => {
    const na = (v: string) => HIFI.replace('data-doop-state="disconnected"', `data-doop-state-na="${v}"`)
    expect(
      checkPageCompleteness(page({ hifi: na('disconnected: the screen is read-only, never offline') }), PAGE).complete,
    ).toBe(true)
    const report = checkPageCompleteness(page({ hifi: na('disconnected') }), PAGE)
    expect(codes(report)).toEqual(['state_missing'])
  })

  it('reports a page with no motion block', () => {
    const report = checkPageCompleteness(page({ hifi: HIFI.replace(/<div data-doop-motion=.*?><\/div>/, '') }), PAGE)
    expect(codes(report)).toEqual(['motion_missing'])
  })

  it('reports a motion block that lacks a field', () => {
    const partial = JSON.stringify({ trigger: 'hover', property: 'opacity', duration: '200ms', easing: 'ease-out' })
    const report = checkPageCompleteness(page({ hifi: HIFI.replace(MOTION, partial) }), PAGE)
    expect(codes(report)).toEqual(['motion_incomplete'])
    expect(details(report, 'motion_incomplete')[0]).toContain('reducedMotion')
  })

  it('reports a page with no prototype wiring', () => {
    const report = checkPageCompleteness(
      page({
        wire: WIRE.replace(/ data-doop-on="click" data-doop-action="navigate:hifi"/, ''),
        hifi: HIFI.replace(/<a data-doop-on.*?<\/a>/, ''),
      }),
      PAGE,
    )
    expect(codes(report)).toContain('prototype_missing')
  })

  it('reports a flow start that was never set', () => {
    expect(codes(checkPageCompleteness(page({}, null), PAGE))).toEqual(['prototype_start_unset'])
  })

  it('reports a navigation target that does not exist', () => {
    const report = checkPageCompleteness(page({ hifi: HIFI.replace('navigate:wire', 'navigate:ghost') }), PAGE)
    expect(codes(report)).toEqual(['prototype_target_broken'])
  })

  it('reports a design frame the flow cannot reach', () => {
    const canvas = page()
    canvas.frames.push(frame('island', '<p>alone</p>'))
    const report = checkPageCompleteness(canvas, PAGE)
    expect(codes(report)).toEqual(['flow_unreachable'])
    expect(details(report, 'flow_unreachable')[0]).toContain('island')
  })

  it('runs the requirement-ledger hook and counts what it reports', () => {
    const report = checkPageCompleteness(page(), PAGE, {
      extraChecks: [() => [{ code: 'ledger_open', detail: 'requirement R7 has no frame' }]],
    })
    expect(report.complete).toBe(false)
    expect(codes(report)).toEqual(['ledger_open'])
  })

  it('reports an empty page without throwing', () => {
    const canvas = page()
    canvas.frames = []
    expect(codes(checkPageCompleteness(canvas, PAGE))).toContain('no_design_frames')
  })
})

describe('attestation validity', () => {
  const stored = (canvas: Canvas, report = checkPageCompleteness(canvas, PAGE)) =>
    attestationRowsFor(canvas, report, 'run-1', 1000, 'Reviewer')

  it('writes one row per design frame, never for the recon frame', () => {
    const rows = stored(page())
    expect(rows.map((r) => r.frameId).sort()).toEqual(['hifi', 'wire'])
    expect(rows.every((r) => r.result === 'complete' && r.pageId === PAGE && r.runId === 'run-1')).toBe(true)
  })

  it('is current while no frame has changed', () => {
    const canvas = page()
    expect(currentAttestation(canvas, PAGE, stored(canvas))?.runId).toBe('run-1')
  })

  it('stops counting once any frame is edited', () => {
    const canvas = page()
    const rows = stored(canvas)
    canvas.frames.find((f) => f.id === 'hifi')!.updatedAt = 101
    expect(currentAttestation(canvas, PAGE, rows)).toBeNull()
  })

  it('stops counting when a frame is added or removed', () => {
    const canvas = page()
    const rows = stored(canvas)
    expect(currentAttestation({ ...canvas, frames: [...canvas.frames, frame('late', '<p/>')] }, PAGE, rows)).toBeNull()
    expect(
      currentAttestation({ ...canvas, frames: canvas.frames.filter((f) => f.id !== 'wire') }, PAGE, rows),
    ).toBeNull()
  })

  it('stops counting when the recon frame is edited (Terra P1, f60f6d6)', () => {
    const canvas = page()
    const rows = stored(canvas)
    const recon = canvas.frames.find((f) => f.id === 'recon')!
    recon.html = reconHtml({ ...RECON, candidates: [...RECON.candidates, { id: 'menu', decision: 'keep' }] })
    recon.updatedAt = 101
    expect(checkPageCompleteness(canvas, PAGE).complete).toBe(false)
    expect(currentAttestation(canvas, PAGE, rows)).toBeNull()
  })

  it('stops counting when the recon frame is deleted', () => {
    const canvas = page()
    const rows = stored(canvas)
    canvas.frames = canvas.frames.filter((f) => f.id !== 'recon')
    expect(codes(checkPageCompleteness(canvas, PAGE))).toContain('recon_missing')
    expect(currentAttestation(canvas, PAGE, rows)).toBeNull()
  })

  it('stops counting when the recon frame is hidden or replaced by another recon frame', () => {
    const canvas = page()
    const rows = stored(canvas)
    canvas.frames.push(frame('recon2', reconHtml({ candidates: [] })))
    expect(currentAttestation(canvas, PAGE, rows)).toBeNull()
  })

  it('stops counting when the flow start moves to another frame', () => {
    const canvas = page()
    const rows = stored(canvas)
    canvas.pages![0]!.startFrameId = 'hifi'
    expect(currentAttestation(canvas, PAGE, rows)).toBeNull()
  })

  it('stops counting when the flow start is cleared', () => {
    const canvas = page()
    const rows = stored(canvas)
    delete canvas.pages![0]!.startFrameId
    expect(codes(checkPageCompleteness(canvas, PAGE))).toContain('prototype_start_unset')
    expect(currentAttestation(canvas, PAGE, rows)).toBeNull()
  })

  it('never counts an incomplete run', () => {
    const canvas = page({ hifi: HIFI.replace(' data-recon-ref="kebab"', '') })
    expect(currentAttestation(canvas, PAGE, stored(canvas))).toBeNull()
  })

  it('stops counting when the ruleset has moved on', () => {
    const canvas = page()
    const rows = stored(canvas).map((r) => ({ ...r, ruleset: 'old-ruleset' }))
    expect(currentAttestation(canvas, PAGE, rows)).toBeNull()
  })

  it('uses the newest run when there are several', () => {
    const canvas = page()
    const old = attestationRowsFor(canvas, checkPageCompleteness(canvas, PAGE), 'run-0', 500, 'R')
    const fresh = stored(canvas)
    expect(currentAttestation(canvas, PAGE, [...old, ...fresh])?.runId).toBe('run-1')
  })
})
