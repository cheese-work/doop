import { describe, expect, it } from 'vitest'
import {
  COMPLETENESS_RULESET,
  attestationRowsFor,
  checkPageCompleteness,
  type CheckOptions,
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

const KEY = 'CHE-1'
const MOTION_PAGE = 'c1:motion'
const SECTIONS = ['Purpose', 'UX reasoning', 'UI reasoning', 'Ergonomics', 'States', 'Motion', 'Accessibility']
const docHtml = (skip: string[] = [], body: Record<string, string> = {}) =>
  SECTIONS.filter((h) => !skip.includes(h))
    .map((h) => `<h3>${h}</h3><p>${body[h] ?? `${h} is written here.`}</p>`)
    .join('')
const SPEC = `<table><tr><th>Name</th><th>Animated frame</th></tr>
<tr><td>push</td><td>anim</td></tr></table>`
const ANIM = `<style>@keyframes slide{from{opacity:0}to{opacity:1}} .b{animation:slide 240ms ease-out}</style><div class="b"></div>`

function frame(id: string, html: string, updatedAt = 100, name = id, pageId?: string): Frame {
  return {
    id,
    canvasId: 'c1',
    name,
    ...(pageId ? { pageId } : {}),
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
  const html = { recon: reconHtml(), wire: WIRE, hifi: HIFI, doc: docHtml(), spec: SPEC, anim: ANIM, ...overrides }
  return {
    id: 'c1',
    name: 'Proposal',
    pages: [
      { id: PAGE, name: 'Direction A', ...(startFrameId ? { startFrameId } : {}) },
      { id: MOTION_PAGE, name: 'Motion' },
    ],
    frames: [
      frame('recon', html.recon),
      frame('wire', html.wire),
      frame('hifi', html.hifi),
      frame('hifidoc', html.doc, 100, 'hifi · doc'),
      frame('spec', html.spec, 100, `${KEY} · motion`, MOTION_PAGE),
      frame('anim', html.anim, 100, 'push', MOTION_PAGE),
    ],
  } as Canvas
}

/* every check in this file knows the page's issue key, as the server does */
const check = (canvas: Canvas, pageId: string, opts: CheckOptions = {}) =>
  checkPageCompleteness(canvas, pageId, { issueKey: KEY, ...opts })

const codes = (r: CompletenessReport) => r.missing.map((m) => m.code)
const details = (r: CompletenessReport, code: string) => r.missing.filter((m) => m.code === code).map((m) => m.detail)

describe('checkPageCompleteness', () => {
  it('passes a page that has every artefact', () => {
    const report = check(page(), PAGE)
    expect(report.missing).toEqual([])
    expect(report.complete).toBe(true)
    expect(report.ruleset).toBe(COMPLETENESS_RULESET)
    expect(report.scanHash).toBe('scan-abc')
  })

  it('reports a missing kebab menu (CHE-5452 case 1)', () => {
    const report = check(page({ hifi: HIFI.replace(' data-recon-ref="kebab"', '') }), PAGE)
    expect(report.complete).toBe(false)
    expect(codes(report)).toEqual(['recon_ref_missing'])
    expect(details(report, 'recon_ref_missing')[0]).toContain('kebab')
  })

  it('reports a missing sort direction, and only that one (CHE-5452 case 2)', () => {
    const report = check(page({ hifi: HIFI.replace(' data-recon-ref="sort-oldest"', '') }), PAGE)
    expect(codes(report)).toEqual(['recon_ref_missing'])
    expect(details(report, 'recon_ref_missing')[0]).toContain('sort-oldest')
    expect(details(report, 'recon_ref_missing')[0]).not.toContain('sort-newest')
  })

  it('reports a composer missing for one sort direction (CHE-5452 case 3)', () => {
    const report = check(page({ hifi: HIFI.replace(' data-recon-ref="composer-oldest"', '') }), PAGE)
    expect(codes(report)).toEqual(['recon_ref_missing'])
    expect(details(report, 'recon_ref_missing')[0]).toContain('composer-oldest')
  })

  it('says plainly that a composer drawn in the wrong place is the reviewer’s to catch', () => {
    /* the ref is there, only the position is wrong: the machine cannot see that */
    const wrong = HIFI.replace(
      '<div data-recon-ref="composer-oldest"></div>',
      '<footer data-recon-ref="composer-oldest"></footer>',
    )
    const report = check(page({ hifi: wrong }), PAGE)
    expect(report.complete).toBe(true)
    expect(report.reviewerNotes.join(' ')).toMatch(/reviewer/i)
    expect(report.reviewerNotes.join(' ')).toMatch(/data-recon-ref/)
  })

  it('does not count the recon frame’s own refs as design', () => {
    const recon = reconHtml() + '<i data-recon-ref="kebab"></i>'
    const report = check(page({ recon, hifi: HIFI.replace(' data-recon-ref="kebab"', '') }), PAGE)
    expect(codes(report)).toEqual(['recon_ref_missing'])
  })

  it('needs a recon inventory at all', () => {
    const canvas = page()
    canvas.frames = canvas.frames.filter((f) => f.id !== 'recon')
    expect(codes(check(canvas, PAGE))).toEqual(['recon_missing'])
  })

  it('rejects an inventory that is not valid JSON', () => {
    const bad = '<script type="application/json" id="doop-recon">{nope</script>'
    expect(codes(check(page({ recon: bad }), PAGE))).toEqual(['recon_invalid'])
  })

  it('treats a candidate with no decision as unhandled', () => {
    const recon = reconHtml({
      ...RECON,
      candidates: [...RECON.candidates, { id: 'extra-menu', file: 'x.tsx', line: 1 }],
    })
    const report = check(page({ recon }), PAGE)
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
    const report = check(page({ recon, hifi: HIFI + html }), PAGE)
    expect(details(report, 'recon_reason_missing').sort()).toEqual([
      expect.stringContaining('"a"'),
      expect.stringContaining('"b"'),
      expect.stringContaining('"c"'),
    ])
  })

  it('does not ask for a ref on remove or n/a', () => {
    /* legacy-badge is "remove" in RECON and has no ref in HIFI: the complete page above already shows it */
    expect(check(page(), PAGE).complete).toBe(true)
  })

  it('reports a page with no wireframe', () => {
    const report = check(page({ wire: WIRE.replace(' data-doop-stage="wireframe"', '') }), PAGE)
    /* with no wireframe the old wire frame counts as a hi-fi screen, and has no doc */
    expect(codes(report)).toEqual(['wireframe_missing', 'screen_doc_missing'])
  })

  it('reports a page whose frames are all wireframes', () => {
    const report = check(page({ hifi: `<div data-doop-stage="wireframe">${HIFI}</div>` }), PAGE)
    expect(codes(report)).toEqual(['hifi_missing'])
  })

  it('reports a state the frames never draw', () => {
    const report = check(page({ hifi: HIFI.replace('data-doop-state="error"', '') }), PAGE)
    expect(codes(report)).toEqual(['state_missing'])
    expect(details(report, 'state_missing')[0]).toContain('error')
  })

  it('accepts a state marked not applicable with a reason, rejects one without', () => {
    const na = (v: string) => HIFI.replace('data-doop-state="disconnected"', `data-doop-state-na="${v}"`)
    expect(check(page({ hifi: na('disconnected: the screen is read-only, never offline') }), PAGE).complete).toBe(true)
    const report = check(page({ hifi: na('disconnected') }), PAGE)
    expect(codes(report)).toEqual(['state_missing'])
  })

  it('reports a page with no motion block', () => {
    const report = check(page({ hifi: HIFI.replace(/<div data-doop-motion=.*?><\/div>/, '') }), PAGE)
    expect(codes(report)).toEqual(['motion_missing'])
  })

  it('reports a motion block that lacks a field', () => {
    const partial = JSON.stringify({ trigger: 'hover', property: 'opacity', duration: '200ms', easing: 'ease-out' })
    const report = check(page({ hifi: HIFI.replace(MOTION, partial) }), PAGE)
    expect(codes(report)).toEqual(['motion_incomplete'])
    expect(details(report, 'motion_incomplete')[0]).toContain('reducedMotion')
  })

  it('reports a page with no prototype wiring', () => {
    const report = check(
      page({
        wire: WIRE.replace(/ data-doop-on="click" data-doop-action="navigate:hifi"/, ''),
        hifi: HIFI.replace(/<a data-doop-on.*?<\/a>/, ''),
      }),
      PAGE,
    )
    expect(codes(report)).toContain('prototype_missing')
  })

  it('reports a flow start that was never set', () => {
    expect(codes(check(page({}, null), PAGE))).toEqual(['prototype_start_unset'])
  })

  it('reports a navigation target that does not exist', () => {
    const report = check(page({ hifi: HIFI.replace('navigate:wire', 'navigate:ghost') }), PAGE)
    expect(codes(report)).toEqual(['prototype_target_broken'])
  })

  it('reports a design frame the flow cannot reach', () => {
    const canvas = page()
    canvas.frames.push(frame('island', '<div data-doop-stage="wireframe">alone</div>'))
    const report = check(canvas, PAGE)
    expect(codes(report)).toEqual(['flow_unreachable'])
    expect(details(report, 'flow_unreachable')[0]).toContain('island')
  })

  it('runs the requirement-ledger hook and counts what it reports', () => {
    const report = check(page(), PAGE, {
      extraChecks: [() => [{ code: 'ledger_open', detail: 'requirement R7 has no frame' }]],
    })
    expect(report.complete).toBe(false)
    expect(codes(report)).toEqual(['ledger_open'])
  })

  it('reports an empty page without throwing', () => {
    const canvas = page()
    canvas.frames = []
    expect(codes(check(canvas, PAGE))).toContain('no_design_frames')
  })

  it('does not count a doc frame as a screen that must be reached or documented', () => {
    /* the complete page has a doc frame the prototype never links to; the doc needs no doc of its own */
    expect(check(page(), PAGE).missing).toEqual([])
  })
})

/* CHE-6853, ruleset g3-r6: motion and per-screen documents (CHE-6849 gate map, rows 3a to 3c and 5a) */
describe('g3-r6 motion per transition', () => {
  const PUSH = '<a data-doop-on="click" data-doop-action="navigate:wire" data-doop-transition="push-left">Back</a>'
  const withPush = (hifi: string) => page({ hifi: HIFI.replace(/<a data-doop-on.*?<\/a>/, hifi) })

  it('names the ruleset g3-r6', () => {
    expect(COMPLETENESS_RULESET).toBe('g3-r6')
  })

  it('reports a transition that has no motion block on its element or its frame', () => {
    const noBlock = HIFI.replace(/<div data-doop-motion=.*?><\/div>/, '').replace(/<a data-doop-on.*?<\/a>/, PUSH)
    const report = check(page({ hifi: noBlock }), PAGE)
    expect(codes(report)).toEqual(['motion_missing', 'motion_per_transition'])
    expect(report.missing.find((m) => m.code === 'motion_per_transition')?.frameId).toBe('hifi')
  })

  it('accepts a motion block on the frame, and on the element itself', () => {
    expect(check(withPush(PUSH), PAGE).missing).toEqual([])
    const own = PUSH.replace('<a ', `<a data-doop-motion='${MOTION}' `)
    const noFrameBlock = HIFI.replace(/<div data-doop-motion=.*?><\/div>/, '').replace(/<a data-doop-on.*?<\/a>/, own)
    expect(check(page({ hifi: noFrameBlock }), PAGE).missing).toEqual([])
  })

  it('does not count a block with an empty field', () => {
    const empty = JSON.stringify({ trigger: 'tap', property: 'x', duration: '', easing: 'ease', reducedMotion: 'none' })
    const own = PUSH.replace('<a ', `<a data-doop-motion='${empty}' `)
    const noFrameBlock = HIFI.replace(/<div data-doop-motion=.*?><\/div>/, '').replace(/<a data-doop-on.*?<\/a>/, own)
    expect(codes(check(page({ hifi: noFrameBlock }), PAGE))).toContain('motion_per_transition')
  })

  it('needs one block per transition in every frame, wireframes included', () => {
    const wire = WIRE.replace('navigate:hifi"', 'navigate:hifi" data-doop-transition="dissolve"')
    const report = check(page({ wire }), PAGE)
    expect(report.missing.filter((m) => m.code === 'motion_per_transition').map((m) => m.frameId)).toEqual(['wire'])
  })

  it('ignores an instant interaction', () => {
    expect(check(page({ hifi: HIFI.replace(/<div data-doop-motion=.*?><\/div>/, '') }), PAGE).missing).toEqual([
      expect.objectContaining({ code: 'motion_missing' }),
    ])
  })
})

describe('g3-r6 Motion page', () => {
  it('reports a canvas with no Motion page', () => {
    const canvas = page()
    canvas.pages = canvas.pages!.filter((p) => p.name !== 'Motion')
    expect(codes(check(canvas, PAGE))).toEqual(['motion_page_missing'])
  })

  it('reports a Motion page without the frame for this issue key', () => {
    const canvas = page()
    canvas.frames.find((f) => f.id === 'spec')!.name = 'CHE-2 · motion'
    const report = check(canvas, PAGE)
    expect(codes(report)).toEqual(['motion_page_missing'])
    expect(details(report, 'motion_page_missing')[0]).toContain('CHE-1 · motion')
  })

  it('reports a spec frame that is hidden, or sits on another page', () => {
    const hidden = page()
    hidden.frames.find((f) => f.id === 'spec')!.hidden = true
    expect(codes(check(hidden, PAGE))).toEqual(['motion_page_missing'])
    const elsewhere = page()
    elsewhere.frames.find((f) => f.id === 'spec')!.pageId = PAGE
    expect(codes(check(elsewhere, PAGE))).toContain('motion_page_missing')
  })

  it('fails closed when the issue key is not known', () => {
    const report = checkPageCompleteness(page(), PAGE)
    expect(codes(report)).toEqual(['motion_page_missing'])
    expect(details(report, 'motion_page_missing')[0]).toMatch(/issue key/)
  })
})

describe('g3-r6 motion frame per spec row', () => {
  it('reports a row whose frame does not exist on the Motion page', () => {
    const report = check(page({ spec: SPEC.replace('<td>anim</td>', '<td>ghost</td>') }), PAGE)
    expect(codes(report)).toEqual(['motion_frame_missing'])
    expect(details(report, 'motion_frame_missing')[0]).toContain('ghost')
  })

  it('reports a row whose frame is on another page', () => {
    const canvas = page({ spec: SPEC.replace('<td>anim</td>', '<td>hifi</td>') })
    expect(codes(check(canvas, PAGE))).toEqual(['motion_frame_missing'])
  })

  it('reports a frame that holds no animation', () => {
    expect(codes(check(page({ anim: '<div>still</div>' }), PAGE))).toEqual(['motion_frame_missing'])
  })

  it('does not count a zero duration, but accepts @keyframes, animation or transition', () => {
    const zero = '<style>.b{transition:opacity 0ms;animation:none}</style>'
    expect(codes(check(page({ anim: zero }), PAGE))).toEqual(['motion_frame_missing'])
    const inline = '<div style="transition: opacity .3s ease"></div>'
    expect(check(page({ anim: inline }), PAGE).missing).toEqual([])
    const css = '<style>.b{animation-duration:1.2s}</style>'
    expect(check(page({ anim: css }), PAGE).missing).toEqual([])
  })

  it('reports each bad row, and a spec with no rows', () => {
    const two = SPEC.replace('</table>', '<tr><td>pop</td><td>missing</td></tr></table>')
    expect(details(check(page({ spec: two }), PAGE), 'motion_frame_missing')).toEqual([
      expect.stringContaining('missing'),
    ])
    expect(codes(check(page({ spec: '<table><tr><th>Name</th></tr></table>' }), PAGE))).toEqual([
      'motion_frame_missing',
    ])
  })

  it('finds the frame by name as well as by id', () => {
    expect(check(page({ spec: SPEC.replace('<td>anim</td>', '<td>push</td>') }), PAGE).missing).toEqual([])
  })
})

describe('g3-r6 screen doc', () => {
  it('reports a hi-fi frame with no doc frame', () => {
    const canvas = page()
    canvas.frames = canvas.frames.filter((f) => f.id !== 'hifidoc')
    const report = check(canvas, PAGE)
    expect(codes(report)).toEqual(['screen_doc_missing'])
    expect(details(report, 'screen_doc_missing')[0]).toContain('hifi · doc')
  })

  it('does not ask a wireframe, a hidden frame or the recon frame for a doc', () => {
    const canvas = page()
    canvas.frames.push({ ...frame('ghost', '<p>draft</p>'), hidden: true })
    expect(check(canvas, PAGE).missing).toEqual([])
  })

  it('reports each of the 7 headings that is absent', () => {
    for (const h of SECTIONS) {
      const report = check(page({ doc: docHtml([h]) }), PAGE)
      expect(codes(report)).toEqual(['screen_doc_missing'])
      expect(details(report, 'screen_doc_missing')[0]).toContain(h)
    }
  })

  it('reports a heading with no text, or only a placeholder', () => {
    for (const text of ['', ' &nbsp; ', 'TBD', 'todo', '…', '-', '<b>TODO.</b>']) {
      const report = check(page({ doc: docHtml([], { Ergonomics: text }) }), PAGE)
      expect(codes(report), JSON.stringify(text)).toEqual(['screen_doc_missing'])
      expect(details(report, 'screen_doc_missing')[0]).toContain('Ergonomics')
    }
  })

  it('accepts a real answer that starts like a placeholder, and n/a with a reason', () => {
    const doc = docHtml([], { Motion: 'n/a: this screen has no motion', States: 'TODO items list is drawn in frame 4' })
    expect(check(page({ doc }), PAGE).missing).toEqual([])
  })

  it('reads headings of any level, in any case, and the last section to the end', () => {
    const doc = SECTIONS.map((h) => `<H2 class="x">${h.toUpperCase()}</H2><div>${h} text</div>`).join('')
    expect(check(page({ doc }), PAGE).missing).toEqual([])
    expect(codes(check(page({ doc: doc.replace('Accessibility text', '') }), PAGE))).toEqual(['screen_doc_missing'])
  })

  it('does not read a heading out of a script or style', () => {
    const doc =
      docHtml(['Purpose']) + '<style>/* <h3>Purpose</h3> */</style><script>"<h3>Purpose</h3><p>x</p>"</script>'
    expect(codes(check(page({ doc }), PAGE))).toEqual(['screen_doc_missing'])
  })
})

describe('attestation validity', () => {
  const stored = (canvas: Canvas, report = check(canvas, PAGE)) =>
    attestationRowsFor(canvas, report, 'run-1', 1000, 'Reviewer')

  it('writes one row per design frame, never for the recon frame', () => {
    const rows = stored(page())
    expect(rows.map((r) => r.frameId).sort()).toEqual(['hifi', 'hifidoc', 'wire'])
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
    expect(check(canvas, PAGE).complete).toBe(false)
    expect(currentAttestation(canvas, PAGE, rows)).toBeNull()
  })

  it('stops counting when the recon frame is deleted', () => {
    const canvas = page()
    const rows = stored(canvas)
    canvas.frames = canvas.frames.filter((f) => f.id !== 'recon')
    expect(codes(check(canvas, PAGE))).toContain('recon_missing')
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
    expect(codes(check(canvas, PAGE))).toContain('prototype_start_unset')
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
    const old = attestationRowsFor(canvas, check(canvas, PAGE), 'run-0', 500, 'R')
    const fresh = stored(canvas)
    expect(currentAttestation(canvas, PAGE, [...old, ...fresh])?.runId).toBe('run-1')
  })
})
