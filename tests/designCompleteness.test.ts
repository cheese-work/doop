import { describe, expect, it } from 'vitest'
import {
  COMPLETENESS_RULESET,
  SLOPLINT_SHA,
  attestationRowsFor,
  checkPageCompleteness,
  type CheckOptions,
  currentAttestation,
  designFrames,
  type CompletenessReport,
  type SloplintEntry,
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
<tr><td>push</td><td>anim</td></tr>
<tr><td>Button · hover</td><td>anim</td></tr>
<tr><td>Button · focus</td><td>anim</td></tr></table>`

/* g3-r7 (CHE-6854): the Components page, its tokens frame and one component, Button, with every state drawn or n/a */
const COMPONENTS_PAGE = 'c1:components'
const TOKENS = `<style>:root{--color-ink:#111;--type-body:14px;--space-2:8px;--radius-md:6px}</style><div data-doop-tokens></div>`
const BUTTON = `<div data-doop-component="Button">
  <button data-doop-variant="primary" data-doop-state="default">Go</button>
  <button data-doop-variant="primary" data-doop-state="hover" data-doop-motion='${MOTION}'>Go</button>
  <button data-doop-variant="primary" data-doop-state="focus" data-doop-motion='${MOTION}'>Go</button>
  <i data-doop-state-na="disabled: always enabled"></i><i data-doop-state-na="loading: no async work"></i>
  <i data-doop-state-na="error: cannot fail"></i>
</div>`
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
  const html = {
    recon: reconHtml(),
    wire: WIRE,
    hifi: HIFI,
    doc: docHtml(),
    spec: SPEC,
    anim: ANIM,
    tokens: TOKENS,
    button: BUTTON,
    ...overrides,
  }
  return {
    id: 'c1',
    name: 'Proposal',
    pages: [
      { id: PAGE, name: 'Direction A', ...(startFrameId ? { startFrameId } : {}) },
      { id: MOTION_PAGE, name: 'Motion' },
      { id: COMPONENTS_PAGE, name: 'Components' },
    ],
    frames: [
      frame('recon', html.recon),
      frame('wire', html.wire),
      frame('hifi', html.hifi),
      frame('hifidoc', html.doc, 100, 'hifi · doc'),
      frame('spec', html.spec, 100, `${KEY} · motion`, MOTION_PAGE),
      frame('anim', html.anim, 100, 'push', MOTION_PAGE),
      frame('tokens', html.tokens, 100, 'Tokens', COMPONENTS_PAGE),
      frame('button', html.button, 100, 'Button', COMPONENTS_PAGE),
    ],
  } as Canvas
}

/** A sloplint result for each design frame at its current version, as the reviewer would send them. */
const slop = (canvas: Canvas, pageId: string): SloplintEntry[] =>
  designFrames(canvas, pageId).map((f) => ({
    frameId: f.id,
    updatedAt: f.updatedAt,
    toolSha: SLOPLINT_SHA,
    sha256: 'a'.repeat(64),
    status: 'ok',
  }))

/* every check in this file knows the page's issue key and has a sloplint result per frame, as the server does */
const check = (canvas: Canvas, pageId: string, opts: CheckOptions = {}) =>
  checkPageCompleteness(canvas, pageId, { issueKey: KEY, sloplint: slop(canvas, pageId), ...opts })

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

  it('names the ruleset g3-r7', () => {
    expect(COMPLETENESS_RULESET).toBe('g3-r7')
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
    const canvas = page()
    const report = checkPageCompleteness(canvas, PAGE, { sloplint: slop(canvas, PAGE) })
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
    /* every spec row of the fixture names this frame, so each reports it */
    expect(new Set(codes(check(page({ anim: '<div>still</div>' }), PAGE)))).toEqual(new Set(['motion_frame_missing']))
  })

  it('does not count a zero duration, but accepts @keyframes, animation or transition', () => {
    const zero = '<style>.b{transition:opacity 0ms;animation:none}</style>'
    expect(new Set(codes(check(page({ anim: zero }), PAGE)))).toEqual(new Set(['motion_frame_missing']))
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
    expect(codes(check(page({ spec: '<table><tr><th>Name</th></tr></table>' }), PAGE))).toContain(
      'motion_frame_missing',
    )
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

/* CHE-6854, ruleset g3-r7: sloplint per frame version and references to the Components page (CHE-6849 gate map, items 1 and 4) */
const frameOf = (canvas: Canvas, id: string) => canvas.frames.find((f) => f.id === id)!
const withHifi = (extra: string) => page({ hifi: HIFI.replace('</main>', `${extra}</main>`) })
const slopCheck = (canvas: Canvas, sloplint: SloplintEntry[]) => check(canvas, PAGE, { sloplint })

describe('g3-r7 sloplint_missing', () => {
  it('passes when every design frame has a result at its current version', () => {
    expect(check(page(), PAGE).missing).toEqual([])
  })

  it('reports each design frame with no result', () => {
    const canvas = page()
    const report = slopCheck(canvas, [])
    expect(codes(report)).toEqual(['sloplint_missing', 'sloplint_missing', 'sloplint_missing'])
    expect(report.missing.map((m) => m.frameId).sort()).toEqual(['hifi', 'hifidoc', 'wire'])
  })

  it('reports a frame whose result is NOT-RUN, and only that frame', () => {
    const canvas = page()
    const entries = slop(canvas, PAGE).map((e) => (e.frameId === 'hifi' ? { ...e, status: 'NOT-RUN' as const } : e))
    const report = slopCheck(canvas, entries)
    expect(report.missing).toEqual([expect.objectContaining({ code: 'sloplint_missing', frameId: 'hifi' })])
    expect(report.missing[0]!.detail).toContain('NOT-RUN')
  })

  it('reports a result for an older version of the frame', () => {
    const canvas = page()
    const entries = slop(canvas, PAGE).map((e) => (e.frameId === 'wire' ? { ...e, updatedAt: 99 } : e))
    expect(slopCheck(canvas, entries).missing).toEqual([
      expect.objectContaining({ code: 'sloplint_missing', frameId: 'wire' }),
    ])
  })

  it('reports a result from another sloplint version, naming the pinned one', () => {
    const canvas = page()
    const entries = slop(canvas, PAGE).map((e) => ({ ...e, toolSha: 'b'.repeat(40) }))
    const report = slopCheck(canvas, entries)
    expect(codes(report)).toEqual(['sloplint_missing', 'sloplint_missing', 'sloplint_missing'])
    expect(report.missing[0]!.detail).toContain(SLOPLINT_SHA)
  })

  it('reports a result with no sha256', () => {
    const canvas = page()
    const entries = slop(canvas, PAGE).map((e) => (e.frameId === 'hifi' ? { ...e, sha256: '' } : e))
    expect(slopCheck(canvas, entries).missing).toEqual([expect.objectContaining({ frameId: 'hifi' })])
  })

  it('does not ask for the recon frame, a hidden frame or a frame of another page', () => {
    const canvas = page()
    canvas.frames.push({ ...frame('ghost', '<p>draft</p>'), hidden: true })
    expect(check(canvas, PAGE).missing).toEqual([])
  })

  it('stores the results with the attestation, so they name the frames they covered', () => {
    const canvas = page()
    const report = check(canvas, PAGE)
    expect(report.inputs.sloplint?.map((e) => e.frameId).sort()).toEqual(['hifi', 'hifidoc', 'wire'])
    expect(attestationRowsFor(canvas, report, 'run-1', 1000, 'R')[0]!.inputs.sloplint).toHaveLength(3)
  })
})

describe('g3-r7 components_page_missing', () => {
  const noComponents = (edit: (c: Canvas) => void) => {
    const canvas = page()
    edit(canvas)
    return codes(check(canvas, PAGE))
  }

  it('reports a canvas with no Components page, and nothing else for the component names it cannot resolve', () => {
    const canvas = withHifi('<b data-doop-component="Button"></b>')
    canvas.pages = canvas.pages!.filter((p) => p.name !== 'Components')
    canvas.frames = canvas.frames.filter((f) => f.pageId !== COMPONENTS_PAGE)
    expect(codes(check(canvas, PAGE))).toEqual(['components_page_missing'])
  })

  it('reports a Components page with no tokens frame, or a hidden one', () => {
    expect(noComponents((c) => (frameOf(c, 'tokens').html = '<style>:root{--color-ink:#111}</style>'))).toEqual([
      'components_page_missing',
    ])
    expect(noComponents((c) => (frameOf(c, 'tokens').hidden = true))).toEqual(['components_page_missing'])
  })

  it('names the token group that has no CSS variable', () => {
    for (const [group, drop] of [
      ['color', '--color-ink:#111;'],
      ['type', '--type-body:14px;'],
      ['spacing', '--space-2:8px;'],
      ['radius', '--radius-md:6px'],
    ] as const) {
      const canvas = page({ tokens: TOKENS.replace(drop, '') })
      const report = check(canvas, PAGE)
      expect(codes(report), group).toEqual(['components_page_missing'])
      expect(details(report, 'components_page_missing')[0], group).toContain(group)
    }
  })

  it('accepts the other spellings of the type and spacing groups', () => {
    const tokens = TOKENS.replace('--type-body', '--font-body').replace('--space-2', '--spacing-2')
    expect(check(page({ tokens }), PAGE).missing).toEqual([])
  })

  it('reports a Components page with no component, and ignores a component that is hidden', () => {
    expect(noComponents((c) => (c.frames = c.frames.filter((f) => f.id !== 'button')))).toEqual([
      'components_page_missing',
    ])
    expect(noComponents((c) => (frameOf(c, 'button').hidden = true))).toEqual(['components_page_missing'])
  })

  it('does not count a component drawn on another page', () => {
    expect(noComponents((c) => (frameOf(c, 'button').pageId = PAGE))).toContain('components_page_missing')
  })
})

describe('g3-r7 component_unknown', () => {
  it('accepts a component that the Components page defines', () => {
    expect(check(withHifi('<b data-doop-component="Button"></b>'), PAGE).missing).toEqual([])
  })

  it('reports a component the Components page does not define, once per frame', () => {
    const report = check(withHifi('<b data-doop-component="Card"></b><i data-doop-component="Card"></i>'), PAGE)
    expect(codes(report)).toEqual(['component_unknown'])
    expect(report.missing[0]).toMatchObject({ frameId: 'hifi' })
    expect(report.missing[0]!.detail).toContain('Card')
  })

  it('matches the name exactly', () => {
    expect(codes(check(withHifi('<b data-doop-component="button"></b>'), PAGE))).toEqual(['component_unknown'])
  })

  it('looks at wireframes and doc frames too', () => {
    const wire = WIRE.replace('<button', '<button data-doop-component="Ghost"')
    expect(check(page({ wire }), PAGE).missing).toEqual([
      expect.objectContaining({ code: 'component_unknown', frameId: 'wire' }),
    ])
  })
})

describe('g3-r7 component_states_missing', () => {
  const stateFindings = (canvas: Canvas) => details(check(canvas, PAGE), 'component_states_missing')

  it('reports a state that is neither drawn nor n/a, naming the component and the state', () => {
    const button = BUTTON.replace(/<button[^>]*data-doop-state="hover"[^>]*>Go<\/button>/, '')
    const found = stateFindings(page({ button }))
    expect(found).toHaveLength(1)
    expect(found[0]).toContain('Button')
    expect(found[0]).toContain('hover')
    expect(found[0]).not.toContain('focus')
  })

  it('reports every state a component lacks in one finding', () => {
    const button = '<div data-doop-component="Button"><b data-doop-variant="a" data-doop-state="default"></b></div>'
    const found = stateFindings(page({ button }))
    expect(found).toHaveLength(1)
    for (const s of ['hover', 'focus', 'disabled', 'loading', 'error']) expect(found[0]).toContain(s)
  })

  it('needs a reason on an n/a state', () => {
    const button = BUTTON.replace('disabled: always enabled', 'disabled:  ')
    expect(stateFindings(page({ button }))[0]).toContain('disabled')
  })

  it('reports a component that shows no variant', () => {
    const button = BUTTON.replaceAll(' data-doop-variant="primary"', '')
    expect(stateFindings(page({ button }))[0]).toContain('variant')
  })

  it('counts the states of every instance of the same component', () => {
    const button = `<div data-doop-component="Button"><b data-doop-variant="a" data-doop-state="default"></b></div>
      <div data-doop-component="Button">
        <b data-doop-state="hover" data-doop-motion='${MOTION}'></b><b data-doop-state="focus" data-doop-motion='${MOTION}'></b>
        <i data-doop-state-na="disabled: x"></i><i data-doop-state-na="loading: x"></i><i data-doop-state-na="error: x"></i>
      </div>`
    expect(stateFindings(page({ button }))).toEqual([])
  })

  it('does not count a state drawn outside the component markup, or on another component', () => {
    const outside =
      BUTTON.replace('<i data-doop-state-na="error: cannot fail"></i>\n</div>', '</div>') +
      '<i data-doop-state-na="error: cannot fail"></i>'
    expect(stateFindings(page({ button: outside }))[0]).toContain('error')
    const card = '<div data-doop-component="Card"><b data-doop-variant="a" data-doop-state="default"></b></div>'
    const found = stateFindings(page({ button: BUTTON + card }))
    expect(found).toHaveLength(1)
    expect(found[0]).toContain('Card')
  })

  it('reads a component whose markup is a void element', () => {
    const input = '<input data-doop-component="Field" data-doop-variant="a" data-doop-state="default">'
    expect(stateFindings(page({ button: BUTTON + input }))[0]).toContain('Field')
  })

  it('does not ask a component used in a design frame to show its states', () => {
    expect(stateFindings(withHifi('<b data-doop-component="Button"></b>'))).toEqual([])
  })
})

describe('g3-r7 motion_per_micro_interaction', () => {
  const found = (canvas: Canvas) => details(check(canvas, PAGE), 'motion_per_micro_interaction')
  const noBlock = (state: string) =>
    BUTTON.replace(new RegExp(`(data-doop-state="${state}") data-doop-motion='[^']*'`), '$1')

  it('reports a non-default component state with no motion block, naming it', () => {
    const f = found(page({ button: noBlock('hover') }))
    expect(f).toHaveLength(1)
    expect(f[0]).toContain('Button · hover')
  })

  it('does not ask the default state for motion', () => {
    expect(found(page())).toEqual([])
  })

  it('reports a block with an empty field', () => {
    const empty = JSON.stringify({
      trigger: 'hover',
      property: 'x',
      duration: '',
      easing: 'ease',
      reducedMotion: 'none',
    })
    const button = BUTTON.replace(`data-doop-motion='${MOTION}'`, `data-doop-motion='${empty}'`)
    expect(found(page({ button }))).toEqual([expect.stringContaining('duration')])
  })

  it('accepts data-doop-motion-na with a reason, not without one', () => {
    const na = (reason: string) =>
      BUTTON.replace(
        `data-doop-state="focus" data-doop-motion='${MOTION}'`,
        `data-doop-state="focus" data-doop-motion-na="${reason}"`,
      )
    expect(found(page({ button: na('instant ring') }))).toEqual([])
    expect(found(page({ button: na(' ') }))).toHaveLength(1)
  })

  it('reports a micro-interaction whose name has no row in the motion spec', () => {
    const spec = SPEC.replace('<tr><td>Button · focus</td><td>anim</td></tr>', '')
    const f = found(page({ spec }))
    expect(f).toHaveLength(1)
    expect(f[0]).toContain('Button · focus')
  })

  it('matches the row name ignoring extra spaces', () => {
    expect(found(page({ spec: SPEC.replace('Button · hover', ' Button  ·  hover ') }))).toEqual([])
  })

  it('covers each element marked data-doop-interaction in a design frame', () => {
    const marked = `<div data-doop-interaction="toggle" data-doop-motion='${MOTION}'></div>`
    const row = SPEC.replace('</table>', '<tr><td>toggle</td><td>anim</td></tr></table>')
    expect(found(page({ hifi: HIFI.replace('</main>', `${marked}</main>`), spec: row }))).toEqual([])
    const bare = '<div data-doop-interaction="toggle"></div>'
    const noBlock = found(page({ hifi: HIFI.replace('</main>', `${bare}</main>`), spec: row }))
    expect(noBlock).toHaveLength(1)
    expect(noBlock[0]).toContain('toggle')
    const noRow = found(page({ hifi: HIFI.replace('</main>', `${marked}</main>`) }))
    expect(noRow).toHaveLength(1)
    expect(noRow[0]).toContain('row')
  })

  it('stays quiet about spec rows when the Motion page itself is missing', () => {
    const canvas = page()
    canvas.pages = canvas.pages!.filter((p) => p.name !== 'Motion')
    canvas.frames = canvas.frames.filter((f) => f.pageId !== MOTION_PAGE)
    expect(codes(check(canvas, PAGE))).toEqual(['motion_page_missing'])
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

  describe('stops counting when the Motion page changes (Terra P1, 9ebc904)', () => {
    const edits: [string, (c: Canvas) => void][] = [
      [
        'the spec frame is edited',
        (c) =>
          Object.assign(
            c.frames.find((f) => f.id === 'spec')!,
            { html: '<p/>', updatedAt: 101 },
          ),
      ],
      [
        'the animated frame is edited',
        (c) =>
          Object.assign(
            c.frames.find((f) => f.id === 'anim')!,
            { html: '<p/>', updatedAt: 101 },
          ),
      ],
      ['the animated frame is hidden', (c) => (c.frames.find((f) => f.id === 'anim')!.hidden = true)],
      ['the spec frame is hidden', (c) => (c.frames.find((f) => f.id === 'spec')!.hidden = true)],
      ['the animated frame is deleted', (c) => void (c.frames = c.frames.filter((f) => f.id !== 'anim'))],
      ['the spec frame is renamed', (c) => (c.frames.find((f) => f.id === 'spec')!.name = 'CHE-2 · motion')],
      ['the animated frame is renamed', (c) => (c.frames.find((f) => f.id === 'anim')!.name = 'pull')],
      ['the Motion page is renamed', (c) => (c.pages!.find((p) => p.id === MOTION_PAGE)!.name = 'Moves')],
      [
        'the Motion page is deleted',
        (c) => {
          c.pages = c.pages!.filter((p) => p.id !== MOTION_PAGE)
          c.frames = c.frames.filter((f) => f.pageId !== MOTION_PAGE)
        },
      ],
    ]
    it.each(edits)('when %s', (_name, edit) => {
      const canvas = page()
      const rows = stored(canvas)
      expect(currentAttestation(canvas, PAGE, rows)?.runId).toBe('run-1')
      edit(canvas)
      expect(currentAttestation(canvas, PAGE, rows)).toBeNull()
    })
  })

  describe('stops counting when the Components page changes (g3-r7)', () => {
    const edits: [string, (c: Canvas) => void][] = [
      [
        'the tokens frame is edited',
        (c) => Object.assign(frameOf(c, 'tokens'), { html: TOKENS + ' ', updatedAt: 101 }),
      ],
      [
        'a component frame is edited',
        (c) => Object.assign(frameOf(c, 'button'), { html: BUTTON + ' ', updatedAt: 101 }),
      ],
      ['a component frame is hidden', (c) => (frameOf(c, 'button').hidden = true)],
      ['the Components page is renamed', (c) => (c.pages!.find((p) => p.id === COMPONENTS_PAGE)!.name = 'Parts')],
      [
        'the Components page is deleted',
        (c) => {
          c.pages = c.pages!.filter((p) => p.id !== COMPONENTS_PAGE)
          c.frames = c.frames.filter((f) => f.pageId !== COMPONENTS_PAGE)
        },
      ],
    ]
    it.each(edits)('when %s', (_name, edit) => {
      const canvas = page()
      const rows = stored(canvas)
      expect(currentAttestation(canvas, PAGE, rows)?.runId).toBe('run-1')
      edit(canvas)
      expect(currentAttestation(canvas, PAGE, rows)).toBeNull()
    })
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
