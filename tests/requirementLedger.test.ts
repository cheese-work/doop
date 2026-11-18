import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { checkPageCompleteness, type CompletenessReport } from '../shared/designCompleteness.ts'
import {
  ledgerReport,
  requirementLedgerCheck,
  requirementLines,
  requirementsHash,
  requirementsStillHold,
  type SourceComment,
} from '../server/requirementLedger.ts'
import type { Canvas, Frame } from '../shared/types.ts'
import { ANIM_HTML, DOC_HTML, SPEC_HTML } from './motionFixtures.ts'

/* CHE-6629: the minimap L1 requirement ledger (CHE-6373 mechanism) as one row of
   the real G3 check. Replays the CHE-5452 omission: Cheese's own comment is the
   fixture, verbatim, and the page is otherwise complete, so every finding below
   comes from the ledger row alone. Ports the 13 tests of the A1r2 prototype
   (test_reqledger.py) one for one, then adds the rows the real G3 needs. */

const CHEESE: SourceComment = {
  id: '01a1e396-a5ea-7267-a4b2-4a888f3297e6',
  authorType: 'member',
  content:
    'Không thực thế. Chưa tham khảo design của multica hiện trạng hiện tại. Nếu comment xếp ngược từ trên xuống dưới là mới → cũ thì phải để composer ở trên, còn nếu xếp từ dưới lên là mới → cũ thì để composer bên dưới.\n\nthiếu kebab menu, \n\nChưa có minimap cho thread board như commit heat map. Chỉ khác là mention thì ô sẽ là màu vàng, comment là màu trắng, còn bình thường thì outline\n\nChưa có sort threads và comments',
}
const AGENT: SourceComment = {
  id: '01a1e3ab-972c-758e-85b0-574840d1ea55',
  authorType: 'agent',
  content: 'v3 is in doop.',
}
const COMMENTS = [AGENT, CHEESE]

/* the id scheme, computed here independently of the code under test */
const lineId = (commentId: string, n: number, text: string) =>
  `${commentId.slice(0, 8)}#${n}:${createHash('sha1').update(text).digest('hex').slice(0, 8)}`
const TEXTS = CHEESE.content
  .split('\n')
  .map((t) => t.trim())
  .filter(Boolean)
const ID = {
  order: lineId(CHEESE.id, 0, TEXTS[0]!),
  kebab: lineId(CHEESE.id, 1, TEXTS[1]!),
  minimap: lineId(CHEESE.id, 2, TEXTS[2]!),
  sort: lineId(CHEESE.id, 3, TEXTS[3]!),
}
type Key = keyof typeof ID

/* ---- a page that is complete as far as G3 goes, plus the ledger frame ---- */

const MOTION = JSON.stringify({
  trigger: 'hover',
  property: 'opacity',
  duration: '200ms',
  easing: 'ease-out',
  reducedMotion: 'no animation',
})
const WIRE = `<div data-doop-stage="wireframe"><button data-doop-on="click" data-doop-action="navigate:hifi">Open</button></div>`
const refs = (...keys: Key[]) => keys.map((k) => `<div data-req-ref="${ID[k]}"></div>`).join('')
const hifi = (body: string) => `<main>${body}
  <p data-doop-state="loading">…</p><p data-doop-state="empty">Nothing</p>
  <p data-doop-state="error">Failed</p><p data-doop-state="disconnected">Offline</p>
  <div data-doop-motion='${MOTION}'></div>
  <a data-doop-on="click" data-doop-action="navigate:wire">Back</a>
</main>`
const ALL = refs('order', 'kebab', 'minimap', 'sort')

type Entry = unknown
function ledger(over: Partial<Record<Key, Entry>> = {}): Record<string, Entry> {
  const base: Record<string, Entry> = Object.fromEntries((Object.keys(ID) as Key[]).map((k) => [ID[k], { d: 'map' }]))
  for (const [k, v] of Object.entries(over)) base[ID[k as Key]] = v
  return base
}
const reconWith = (l: unknown) =>
  `<script type="application/json" id="doop-recon">${JSON.stringify({ scanHash: 's', candidates: [] })}</script>` +
  (l === undefined ? '' : `<script type="application/json" id="doop-reqledger">${JSON.stringify(l)}</script>`)

function frame(id: string, html: string, name = id, pageId?: string): Frame {
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
    updatedAt: 100,
    updatedBy: 'a',
  } as Frame
}
const PAGE = 'c1:page1'
function canvasWith(l: unknown, hifiBody: string, recon?: string): Canvas {
  return {
    id: 'c1',
    name: 'Proposal',
    pages: [
      { id: PAGE, name: 'Direction A', startFrameId: 'wire' },
      { id: 'c1:motion', name: 'Motion' },
    ],
    frames: [
      frame('recon', recon ?? reconWith(l)),
      frame('wire', WIRE),
      frame('hifi', hifi(hifiBody)),
      frame('hifidoc', DOC_HTML, 'hifi · doc'),
      frame('spec', SPEC_HTML, 'CHE-9 · motion', 'c1:motion'),
      frame('fade', ANIM_HTML, 'Fade', 'c1:motion'),
    ],
  } as Canvas
}

const lines = requirementLines(null, COMMENTS)
const run = (l: unknown, hifiBody: string, recon?: string): CompletenessReport =>
  checkPageCompleteness(canvasWith(l, hifiBody, recon), PAGE, {
    issueKey: 'CHE-9',
    extraChecks: [requirementLedgerCheck(lines)],
  })
const codes = (r: CompletenessReport) => r.missing.map((m) => m.code)
const idsOf = (r: CompletenessReport, code: string) =>
  r.missing.filter((m) => m.code === code).map((m) => m.detail.match(/\[([^\]]+)\]/)?.[1])

describe('requirement lines', () => {
  it('00 takes the four non-empty Cheese lines and ignores the agent comment', () => {
    expect(lines.map((l) => l.id)).toEqual([ID.order, ID.kebab, ID.minimap, ID.sort])
    expect(lines.map((l) => l.text)).toEqual(TEXTS)
  })

  it('takes the issue description as a source, with its own id prefix', () => {
    const l = requirementLines('Add a minimap\n\n', [AGENT])
    expect(l).toHaveLength(1)
    expect(l[0]!.id).toMatch(/^desc#0:[0-9a-f]{8}$/)
  })

  it('numbers lines per comment and skips agent, system and blank text', () => {
    const l = requirementLines(null, [
      { id: 'abcdef01-0000', authorType: 'member', content: ' a \n\n b ' },
      AGENT,
      { id: 'zz', authorType: 'system', content: 'x' },
    ])
    expect(l.map((x) => x.id.split(':')[0])).toEqual(['abcdef01#0', 'abcdef01#1'])
  })

  it('hashes the source lines; any edit changes the hash', () => {
    const a = requirementsHash(lines)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(
      requirementsHash(requirementLines(null, [AGENT, { ...CHEESE, content: CHEESE.content + '\nvà thêm dark mode' }])),
    ).not.toBe(a)
    expect(requirementsHash(lines)).toBe(a)
  })
})

describe('G3 row: Cheese requirement ledger (replay of the CHE-5452 minimap omission)', () => {
  it('03 a full map with every ref drawn passes, and defers nothing', () => {
    const r = run(ledger(), ALL)
    expect(r.missing).toEqual([])
    expect(r.complete).toBe(true)
  })

  it('01 v2.1 drops the minimap line from the ledger: blocked, naming that line', () => {
    const l = ledger()
    delete l[ID.minimap]
    const r = run(l, refs('order', 'kebab', 'sort'))
    expect(r.complete).toBe(false)
    expect(codes(r)).toEqual(['req_missing'])
    expect(idsOf(r, 'req_missing')).toEqual([ID.minimap])
  })

  it('02 mapped but no element carries the ref: blocked', () => {
    const r = run(ledger(), refs('order', 'kebab', 'sort'))
    expect(r.complete).toBe(false)
    expect(codes(r)).toEqual(['req_no_element'])
    expect(idsOf(r, 'req_no_element')).toEqual([ID.minimap])
  })

  it('04 defer with a reason passes and the line is shown for the card', () => {
    const entry = { d: 'defer', reason: 'needs unread API' }
    const r = run(ledger({ minimap: entry }), refs('order', 'kebab', 'sort'))
    expect(r.complete).toBe(true)
    const report = ledgerReport(lines, {
      canvas: canvasWith(ledger({ minimap: entry }), refs('order', 'kebab', 'sort')),
      pageId: PAGE,
      designFrames: [frame('hifi', hifi(refs('order', 'kebab', 'sort')))],
    })
    expect(report.deferred).toEqual([{ id: ID.minimap, text: TEXTS[2], reason: 'needs unread API' }])
    expect(report.notes.join('\n')).toContain('needs unread API')
  })

  it('05 ctx or defer without a reason is blocked', () => {
    for (const d of ['ctx', 'defer']) {
      const r = run(ledger({ minimap: { d } }), refs('order', 'kebab', 'sort'))
      expect(codes(r)).toEqual(['req_bad_reason'])
      expect(idsOf(r, 'req_bad_reason')).toEqual([ID.minimap])
    }
    expect(codes(run(ledger({ minimap: { d: 'ctx', reason: '   ' } }), refs('order', 'kebab', 'sort')))).toEqual([
      'req_bad_reason',
    ])
  })

  it('05b ctx with a reason passes and is listed for the reviewer', () => {
    const l = ledger({ order: { d: 'ctx', reason: 'a complaint, not a requirement' } })
    const report = ledgerReport(lines, {
      canvas: canvasWith(l, refs('kebab', 'minimap', 'sort')),
      pageId: PAGE,
      designFrames: [frame('hifi', hifi(refs('kebab', 'minimap', 'sort')))],
    })
    expect(report.missing).toEqual([])
    expect(report.notes.join('\n')).toContain('a complaint, not a requirement')
  })

  it('06 an id in the ledger that is not a source line is blocked', () => {
    const l = ledger()
    l['01a1e396#9:deadbeef'] = { d: 'map' }
    const r = run(l, ALL)
    expect(codes(r)).toEqual(['req_unknown'])
    expect(idsOf(r, 'req_unknown')).toEqual(['01a1e396#9:deadbeef'])
  })

  it('07 Cheese adds a line after the ledger was written: blocked', () => {
    const edited = requirementLines(null, [AGENT, { ...CHEESE, content: CHEESE.content + '\nvà thêm dark mode' }])
    const r = checkPageCompleteness(canvasWith(ledger(), ALL), PAGE, {
      issueKey: 'CHE-9',
      extraChecks: [requirementLedgerCheck(edited)],
    })
    expect(r.complete).toBe(false)
    expect(codes(r)).toEqual(['req_missing'])
  })

  it('08 the id in the wrong attribute does not count', () => {
    const body = ALL.replace(ID.minimap, 'x') + `<p title="${ID.minimap}"></p>`
    const r = run(ledger(), body)
    expect(codes(r)).toEqual(['req_no_element'])
    expect(idsOf(r, 'req_no_element')).toEqual([ID.minimap])
  })

  it('does not count a ref that sits in the recon frame instead of a design frame', () => {
    const r = run(
      ledger(),
      refs('order', 'kebab', 'sort'),
      reconWith(ledger()) + `<i data-req-ref="${ID.minimap}"></i>`,
    )
    expect(codes(r)).toEqual(['req_no_element'])
  })

  const bad = (entry: Entry) => {
    const r = run(ledger({ minimap: entry }), refs('order', 'kebab', 'sort'))
    expect(r.complete).toBe(false)
    expect(codes(r)).toEqual(['req_bad_disposition'])
    expect(idsOf(r, 'req_bad_disposition')).toEqual([ID.minimap])
  }
  it('09 a typo disposition is blocked', () => bad({ d: 'typo' }))
  it('10 a missing disposition is blocked', () => bad({ reason: 'x' }))
  it('11 a wrong-case or non-string disposition is blocked', () => {
    bad({ d: 'MAP' })
    bad({ d: ['map'] })
    bad({ d: null })
  })
  it('12 an entry that is not an object is blocked, not a crash', () => {
    bad('map')
    bad(null)
    bad(['map'])
  })

  it('a page with source lines and no ledger script says so, and misses every line', () => {
    const r = run(undefined, ALL)
    expect(codes(r)).toEqual(['req_ledger_missing', 'req_missing', 'req_missing', 'req_missing', 'req_missing'])
  })

  it('an unparseable or non-object ledger is blocked as invalid', () => {
    const broken = `<script type="application/json" id="doop-recon">{"candidates":[]}</script><script type="application/json" id="doop-reqledger">{nope</script>`
    expect(codes(run(undefined, ALL, broken))).toEqual(['req_ledger_invalid'])
    expect(codes(run([ID.minimap], ALL))).toEqual(['req_ledger_invalid'])
    expect(codes(run(null, ALL))).toEqual(['req_ledger_invalid'])
  })

  it('two ledger scripts are ambiguous: blocked as invalid', () => {
    const two =
      reconWith(ledger()) + `<script type="application/json" id="doop-reqledger">${JSON.stringify(ledger())}</script>`
    expect(codes(run(undefined, ALL, two))).toEqual(['req_ledger_invalid'])
  })

  it('no source lines, no ledger needed', () => {
    const r = checkPageCompleteness(canvasWith(undefined, ''), PAGE, { extraChecks: [requirementLedgerCheck([])] })
    expect(codes(r)).not.toContain('req_ledger_missing')
  })
})

/* Terra P1 on 4585a23: a run that never read the requirement lines must not stay current. */
describe('requirementsStillHold: only a checked run for the same issue and the same lines counts', () => {
  const now = { issue: 'issue-a', hash: 'h1' }
  it('is true for a run that read this issue at this hash', () => {
    expect(requirementsStillHold({ requirements: 'h1', requirementsIssue: 'issue-a' }, now)).toBe(true)
  })
  it('is false for a legacy run with no requirement inputs', () => {
    expect(requirementsStillHold({}, now)).toBe(false)
  })
  it('is false for a run that recorded no lines (unchecked)', () => {
    expect(requirementsStillHold({ requirements: null, requirementsIssue: null }, now)).toBe(false)
  })
  it('is false for a hash without an issue identity', () => {
    expect(requirementsStillHold({ requirements: 'h1' }, now)).toBe(false)
  })
  it('is false when the page is rebound to another issue with identical lines', () => {
    expect(
      requirementsStillHold({ requirements: 'h1', requirementsIssue: 'issue-a' }, { issue: 'issue-b', hash: 'h1' }),
    ).toBe(false)
  })
  it('is false when the lines changed', () => {
    expect(
      requirementsStillHold({ requirements: 'h1', requirementsIssue: 'issue-a' }, { issue: 'issue-a', hash: 'h2' }),
    ).toBe(false)
  })
  it('is false when the source cannot be read now', () => {
    expect(requirementsStillHold({ requirements: 'h1', requirementsIssue: 'issue-a' }, null)).toBe(false)
  })
})
