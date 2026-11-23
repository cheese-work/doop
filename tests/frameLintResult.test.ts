import { describe, expect, it } from 'vitest'
import {
  DEFAULT_LIMITS,
  FrameLintInputError,
  FRAME_LINT_MAX_RESPONSE_BYTES,
  ROW_BASE_MAX_BYTES,
  ROW_MAX_BYTES,
  assembleLintResult,
  buildRow,
  cutString,
  jsonBytes,
  parseAfter,
  resolveWindow,
  walkOrder,
  windowAfter,
  windowByIds,
  type FrameKey,
  type LintFinding,
  type LintResult,
  type LintRowInput,
  type PageScanInput,
} from '../shared/frameLintResult.ts'

/* S3a of the CHE-9115 plan (fl-r1): the bounded result envelope and the keyset walk. Pure code: no
   browser, no MCP. Every size below is measured on the serialized text, escapes included. */

const NASTY = '\u0001"\\\ud800😀'
const MAX = FRAME_LINT_MAX_RESPONSE_BYTES

const key = (frame: { id: string; createdAt: number | null }) => `${frame.createdAt}:${frame.id}`
const bytes = (text: string) => Buffer.byteLength(text)
const wellFormed = (text: string) =>
  !/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(text)

function frames(count: number): FrameKey[] {
  return Array.from({ length: count }, (_, i) => ({ id: `f${i}`, createdAt: 1000 + i }))
}

function finding(rule: string, text = 'm', over: Partial<LintFinding> = {}): LintFinding {
  return {
    rule,
    level: 'warn',
    viewport: { width: 320, height: 852 },
    element: { doop_id: text, selector: text },
    message: text,
    ...over,
  }
}

function row(i: number, over: Partial<LintRowInput> = {}): LintRowInput {
  return {
    frame_id: `f${i}`,
    frame_name: `Frame ${i}`,
    created_at: 1000 + i,
    updated_at: 2000 + i,
    status: 'ok',
    viewports: [
      { width: 393, height: 852, status: 'ok', ms: 10 },
      { width: 320, height: 852, status: 'ok', ms: 11 },
    ],
    findings: [],
    page_findings: [],
    ...over,
  }
}

function scan(over: Partial<PageScanInput> = {}): PageScanInput {
  return {
    scope: 'all frames',
    reason: null,
    frames_scanned: 0,
    chars_scanned: 0,
    ms: 1,
    skipped: [],
    by_rule: {},
    ...over,
  }
}

/** Fat row: more than ROW_MAX_BYTES / 40 of findings, so a few rows fill the 108,000-byte row budget. */
function fatRow(i: number): LintRowInput {
  const text = 'x'.repeat(1000)
  return row(i, { findings: Array.from({ length: 100 }, (_, n) => finding(`r${n % 5}`, text)) })
}

function nastyFindings(): LintFinding[] {
  const out: LintFinding[] = []
  for (let rule = 0; rule < 15; rule++) {
    for (let n = 0; n < 100; n++) {
      out.push(finding(`r${rule}${NASTY}`, NASTY.repeat(100)))
    }
  }
  return out
}

const NASTY_FINDINGS = nastyFindings()

function nastyRow(i: number): LintRowInput {
  return row(i, {
    frame_name: NASTY.repeat(200),
    reason: NASTY.repeat(50),
    findings: NASTY_FINDINGS,
    page_findings: NASTY_FINDINGS,
  })
}

function nastyScan(): PageScanInput {
  return scan({
    scope: 'all frames except skipped',
    reason: NASTY.repeat(50),
    skipped: Array.from({ length: 12 }, (_, i) => ({ frame_id: `s${i}`, reason: NASTY.repeat(50) })),
    by_rule: Object.fromEntries(Array.from({ length: 15 }, (_, i) => [`p${i}${NASTY}`, 1_000_000])),
  })
}

const NASTY_META = { canvas_id: NASTY.repeat(50), page_id: NASTY.repeat(50), deadline_ms: 45_000, elapsed_ms: 44_999 }

function nextAfter(result: LintResult): string | null {
  return result.next && 'after' in result.next ? result.next.after : null
}

describe('assembleLintResult: the reply is bounded whatever the page holds', () => {
  it('(1) a 5,000-frame page with 20,000-char names and 24 rows of 100 findings stays within 120,000 bytes', () => {
    const name = '€'.repeat(20_000)
    const page = Array.from({ length: 5000 }, (_, i) => ({ id: `f${i}`, createdAt: 1000 + i, name }))
    const win = windowAfter(walkOrder(page), null)
    const rows = win.frames.map((f) => {
      const i = Number(f.id.slice(1))
      const text = 'y'.repeat(1000)
      return row(i, { frame_name: name, findings: Array.from({ length: 100 }, (_, n) => finding(`r${n % 5}`, text)) })
    })
    const { result, text } = assembleLintResult(win, rows, scan())
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(MAX)
    expect(text).toBe(JSON.stringify(result))
    expect(result.window.frames_on_page).toBe(5000)
    expect(result.frames.length).toBeGreaterThanOrEqual(1)
    expect(result.frames.length).toBeLessThanOrEqual(24)
    for (const r of result.frames) expect(jsonBytes(r.frame_name) - 2).toBeLessThanOrEqual(120)
  })

  it('(2) every envelope cap filled with maximum-length strings is at most 12,000 bytes', () => {
    const win = windowAfter(walkOrder(frames(100)), parseAfter(`1000:${'a'.repeat(64)}`))
    const rows = Array.from({ length: 24 }, (_, i) => {
      const id = `${i}`.padStart(2, '0').repeat(32)
      return row(i, {
        frame_id: id,
        status: 'NOT-RUN',
        reason: NASTY.repeat(50),
        findings: Array.from({ length: 15 }, (_, rule) => finding(`r${rule}${NASTY}`, 'm')),
      })
    })
    const fullWindow = { ...win, frames: rows.map((r) => ({ id: r.frame_id, createdAt: 1000 })) }
    const { parts, bytes: total } = assembleLintResult(fullWindow, rows, nastyScan(), DEFAULT_LIMITS, NASTY_META)
    expect(parts.rows.length).toBe(24)
    expect(parts.envelopeBytes).toBeLessThanOrEqual(12_000)
    const rowBytes = parts.rows.reduce((sum, r) => sum + bytes(r), 0)
    expect(parts.envelopeBytes).toBe(total - rowBytes - (parts.rows.length - 1))
  })

  it('(3) a row fed 1,000 findings stops at 32,000 measured bytes', () => {
    const many = Array.from({ length: 1000 }, (_, i) => finding(`r${i % 15}`, 'm'.repeat(200)))
    const loose = { ...DEFAULT_LIMITS, max_findings_per_row: 1000, max_findings_per_rule_per_row: 1000 }
    const built = buildRow(row(0, { findings: many }), 'ok', loose)
    expect(built.bytes).toBeLessThanOrEqual(ROW_MAX_BYTES)
    expect(built.bytes).toBeGreaterThan(ROW_MAX_BYTES - 1000)
    expect(bytes(built.text)).toBe(built.bytes)
    expect(built.row.findings.length).toBeLessThan(1000)
    expect(built.findings_dropped).toBe(1000 - built.row.findings.length)
    expect(Object.values(built.row.truncated).reduce((a, b) => a + b, 0)).toBe(built.findings_dropped)
  })

  it('(3) the measured row size never passes 32,000 for any finding size, and the cut is tight', () => {
    const loose = { ...DEFAULT_LIMITS, max_findings_per_row: 1000, max_findings_per_rule_per_row: 1000 }
    for (let len = 1; len <= 200; len += 7) {
      for (const rules of [1, 15]) {
        const many = Array.from({ length: 800 }, (_, i) => finding(`r${i % rules}`, 'm'.repeat(len)))
        const built = buildRow(row(0, { findings: many }), 'ok', loose)
        expect(built.bytes, `len ${len} rules ${rules}`).toBeLessThanOrEqual(ROW_MAX_BYTES)
        expect(bytes(built.text)).toBe(built.bytes)
      }
    }
  })

  it('(3) the default limits keep 20 findings per rule and 40 per row, the rest counted in truncated', () => {
    const many = Array.from({ length: 1000 }, (_, i) => finding(`r${i % 15}`))
    const built = buildRow(row(0, { findings: many }), 'ok')
    expect(built.row.findings.length).toBe(40)
    expect(built.findings_dropped).toBe(960)
    for (let rule = 0; rule < 15; rule++) {
      expect(built.row.findings.filter((f) => f.rule === `r${rule}`).length).toBeLessThanOrEqual(20)
    }
  })

  it('(3) a row with no findings, filled with worst-case escapes, is at most 4,000 bytes', () => {
    const base = row(0, {
      frame_id: 'a'.repeat(64),
      frame_name: NASTY.repeat(200),
      reason: NASTY.repeat(50),
      status: 'NOT-RUN',
    })
    expect(buildRow(base, 'NOT-RUN').bytes).toBeLessThanOrEqual(ROW_BASE_MAX_BYTES)
    // one truncated key per registered rule: every finding cut, 15 worst-case rule names
    const cutAll = { ...base, status: 'ok' as const, findings: NASTY_FINDINGS }
    const built = buildRow(cutAll, 'NOT-RUN', { ...DEFAULT_LIMITS, max_findings_per_row: 0 })
    expect(Object.keys(built.row.truncated).length).toBe(15)
    expect(built.bytes).toBeLessThanOrEqual(ROW_BASE_MAX_BYTES)
  })

  it('(4) the returned rows are a prefix of the window and next.after is the key of the last one', () => {
    const win = windowAfter(walkOrder(frames(60)), null)
    const rows = win.frames.map((f) => fatRow(Number(f.id.slice(1))))
    const { result } = assembleLintResult(win, rows, scan())
    const k = result.frames.length
    expect(k).toBeGreaterThanOrEqual(1)
    expect(k).toBeLessThan(24)
    expect(result.frames.map((r) => r.frame_id)).toEqual(win.frames.slice(0, k).map((f) => f.id))
    expect(nextAfter(result)).toBe(key(win.frames[k - 1]!))
    expect(result.omitted.rows_byte_cap).toBe(24 - k)
    expect(result.omitted.not_reached).toBe(0)
    expect(
      result.window.frames_before +
        result.window.rows +
        result.omitted.not_reached +
        result.omitted.rows_byte_cap +
        result.window.frames_after,
    ).toBe(60)
  })

  it('the last returned row is the last frame on the page: next is null', () => {
    const win = windowAfter(walkOrder(frames(5)), null)
    const { result } = assembleLintResult(
      win,
      win.frames.map((f) => row(Number(f.id.slice(1)))),
      scan(),
    )
    expect(result.next).toBeNull()
    expect(result.frames.length).toBe(5)
  })

  it('frames the renderer never reached are counted in not_reached; the walk resumes after the last row', () => {
    const win = windowAfter(walkOrder(frames(60)), null)
    const rows = [row(0), row(1, { status: 'NOT-RUN', reason: 'deadline' })]
    const { result } = assembleLintResult(win, rows, scan())
    expect(result.frames.map((r) => r.frame_id)).toEqual(['f0', 'f1'])
    expect(result.omitted.not_reached).toBe(22)
    expect(result.window.frames_after).toBe(36)
    expect(nextAfter(result)).toBe('1001:f1')
    expect(result.retry_frame_ids).toEqual(['f1'])
    expect(result.page_complete).toBe(false)
  })

  it('a window that has a frame always returns a row, even when the harness gave none', () => {
    const win = windowAfter(walkOrder(frames(3)), null)
    const { result } = assembleLintResult(win, [], scan())
    expect(result.frames.length).toBe(1)
    expect(result.frames[0]).toMatchObject({ frame_id: 'f0', status: 'NOT-RUN', reason: 'deadline' })
    expect(nextAfter(result)).toBe('1000:f0')
  })

  it('page_complete only for one whole-page call with every row ok or partial and page rules on all frames', () => {
    const order = walkOrder(frames(3))
    const win = windowAfter(order, null)
    const rows = win.frames.map((f) => row(Number(f.id.slice(1))))
    expect(assembleLintResult(win, rows, scan()).result.page_complete).toBe(true)
    expect(assembleLintResult(win, rows, scan({ scope: 'all frames except skipped' })).result.page_complete).toBe(false)
    expect(assembleLintResult(win, rows, scan({ scope: 'NOT-RUN', reason: 'deadline' })).result.page_complete).toBe(
      false,
    )
    const partial = [row(0), row(1, { status: 'partial', reason: 'load timeout 8000ms' }), row(2)]
    expect(assembleLintResult(win, partial, scan()).result.page_complete).toBe(true)
    const notRun = [row(0), row(1, { status: 'NOT-RUN', reason: 'deadline' }), row(2)]
    expect(assembleLintResult(win, notRun, scan()).result.page_complete).toBe(false)
    const later = windowAfter(order, parseAfter('1000:f0'))
    const laterRows = later.frames.map((f) => row(Number(f.id.slice(1))))
    expect(assembleLintResult(later, laterRows, scan()).result.page_complete).toBe(false)
  })

  it('page rules NOT-RUN: no row has page_findings, every row says NOT-RUN and is retried, no page-rule key', () => {
    const win = windowAfter(walkOrder(frames(3)), null)
    const rows = win.frames.map((f) =>
      row(Number(f.id.slice(1)), { page_findings: [finding('state-error')], findings: [finding('text-clipped')] }),
    )
    const { result } = assembleLintResult(
      win,
      rows,
      scan({ scope: 'NOT-RUN', reason: 'deadline', by_rule: { 'state-error': 9 } }),
    )
    for (const r of result.frames) {
      expect(r.page_rules).toBe('NOT-RUN')
      expect(r.page_findings).toEqual([])
    }
    expect(result.retry_frame_ids).toEqual(['f0', 'f1', 'f2'])
    expect(result.summary.by_rule).toEqual({ 'text-clipped': 3 })
    expect(result.summary.coverage).toMatchObject({ page_rules_not_run: 3, page_rules_ok: 0, render_ok: 3 })
  })

  it('a skipped frame says page_rules skipped; skipped frames are listed 10 at a time with the full count', () => {
    const win = windowAfter(walkOrder(frames(2)), null)
    const skipped = Array.from({ length: 12 }, (_, i) => ({
      frame_id: i === 0 ? 'f1' : `s${i}`,
      reason: 'html over 1500000 chars',
    }))
    const { result } = assembleLintResult(
      win,
      win.frames.map((f) => row(Number(f.id.slice(1)))),
      scan({ scope: 'all frames except skipped', skipped }),
    )
    expect(result.frames.map((r) => r.page_rules)).toEqual(['ok', 'skipped'])
    expect(result.page_rules.skipped.length).toBe(10)
    expect(result.page_rules.skipped_count).toBe(12)
    expect(result.summary.coverage).toMatchObject({ page_rules_ok: 1, page_rules_skipped: 1, page_rules_not_run: 0 })
    expect(result.retry_frame_ids).toEqual([])
  })

  it('summary.by_rule keeps the full counts, also for findings cut from a row and for rows cut by the byte cap', () => {
    const win = windowAfter(walkOrder(frames(24)), null)
    const text = 'z'.repeat(1000)
    const rows = win.frames.map((f) =>
      row(Number(f.id.slice(1)), { findings: Array.from({ length: 100 }, () => finding('stub', text)) }),
    )
    const { result } = assembleLintResult(win, rows, scan({ by_rule: { 'repeated-markup': 4 } }))
    expect(result.summary.by_rule).toEqual({ stub: 2400, 'repeated-markup': 4 })
    expect(result.omitted.rows_byte_cap).toBeGreaterThanOrEqual(1)
    for (const r of result.frames) expect(r.findings.length).toBe(20)
    expect(result.omitted.findings).toBe(result.frames.length * 80)
  })

  it('(6) a filtered call returns the not-returned ids in next.frame_ids, in walk order', () => {
    const order = walkOrder(frames(60))
    const ids = Array.from({ length: 24 }, (_, i) => `f${23 - i}`)
    const win = windowByIds(order, ids)
    expect(win.frames.map((f) => f.id)).toEqual(Array.from({ length: 24 }, (_, i) => `f${i}`))
    const { result } = assembleLintResult(
      win,
      win.frames.map((f) => fatRow(Number(f.id.slice(1)))),
      scan(),
    )
    const k = result.frames.length
    expect(k).toBeLessThan(24)
    expect(result.next).toEqual({ frame_ids: win.frames.slice(k).map((f) => f.id) })
    const whole = windowByIds(order, ['f2', 'f1'])
    expect(assembleLintResult(whole, [row(1), row(2)], scan()).result.next).toBeNull()
  })

  it('a filtered id that is not on the page is a NOT-RUN row "not on page", and is not worth a retry', () => {
    const order = walkOrder(frames(5))
    const win = windowByIds(order, ['f3', 'gone', 'f1'])
    expect(win.frames.map((f) => f.id)).toEqual(['f1', 'f3', 'gone'])
    expect(win.not_on_page).toBe(1)
    const rows = [
      row(1),
      row(3),
      row(0, { frame_id: 'gone', created_at: null, updated_at: null, status: 'NOT-RUN', reason: 'not on page' }),
    ]
    const { result } = assembleLintResult(win, rows, scan())
    expect(result.frames.map((r) => r.status)).toEqual(['ok', 'ok', 'NOT-RUN'])
    expect(result.retry_frame_ids).toEqual([])
    expect(result.window.mode).toBe('ids')
    expect(result.window.not_on_page).toBe(1)
  })

  it('(8) every cut string is valid UTF-8, never splits a surrogate pair, and is counted in strings_cut', () => {
    const win = windowAfter(walkOrder(frames(1)), null)
    const { result, text } = assembleLintResult(
      win,
      [
        row(0, {
          frame_name: 'n'.repeat(500),
          findings: [
            finding('r', 'ok', { message: '😀'.repeat(500), element: { doop_id: 'd', selector: 's'.repeat(900) } }),
          ],
        }),
      ],
      scan(),
    )
    expect(result.omitted.strings_cut).toBe(3)
    const r = result.frames[0]!
    expect(r.frame_name.endsWith('…')).toBe(true)
    expect(jsonBytes(r.frame_name) - 2).toBeLessThanOrEqual(120)
    const f = r.findings[0]!
    expect(f.message.endsWith('…')).toBe(true)
    expect(wellFormed(f.message)).toBe(true)
    expect(jsonBytes(f.message) - 2).toBeLessThanOrEqual(200)
    expect(jsonBytes(f.element!.selector) - 2).toBeLessThanOrEqual(200)
    expect(wellFormed(text)).toBe(true)
  })

  it('(9) worst-case escaping: 24 rows of 15 rules x 100 findings, every string field hostile', () => {
    const order = walkOrder(frames(60))
    const seen: string[] = []
    let after: string | null = null
    let calls = 0
    for (; calls < 60; calls++) {
      const win = windowAfter(order, after ? parseAfter(after) : null)
      const rows = win.frames.map((f) => nastyRow(Number(f.id.slice(1))))
      const {
        result,
        text,
        bytes: total,
        parts,
      } = assembleLintResult(win, rows, nastyScan(), DEFAULT_LIMITS, NASTY_META)
      expect(bytes(text)).toBeLessThanOrEqual(MAX)
      expect(total).toBe(bytes(text))
      expect(parts.head + parts.rows.join(',') + parts.tail).toBe(text)
      const measured =
        bytes(parts.head) +
        parts.rows.reduce((sum, r) => sum + bytes(r), 0) +
        (parts.rows.length - 1) +
        bytes(parts.tail)
      expect(measured).toBe(total)
      expect(wellFormed(text)).toBe(true)
      expect(JSON.parse(text)).toEqual(JSON.parse(JSON.stringify(result)))
      expect(result.frames.length).toBeGreaterThanOrEqual(1)
      seen.push(...result.frames.map((r) => r.frame_id))
      const last = result.frames.at(-1)!.frame_id
      if (calls === 0) {
        expect(nextAfter(result)).toBe(key(win.frames[result.frames.length - 1]!))
        const second = windowAfter(order, parseAfter(nextAfter(result)!))
        expect(second.frames[0]!.id).toBe(`f${result.frames.length}`)
        expect(last).toBe(`f${result.frames.length - 1}`)
      }
      after = nextAfter(result)
      if (after === null) break
    }
    expect(seen).toEqual(order.map((f) => f.id))
    expect(calls + 1).toBeLessThanOrEqual(60)
  })
})

describe('keyset walk', () => {
  it('walkOrder sorts by (createdAt, id) and ignores paint order', () => {
    const order = walkOrder([
      { id: 'b', createdAt: 5 },
      { id: 'a', createdAt: 5 },
      { id: 'c', createdAt: 1 },
    ])
    expect(order.map((f) => f.id)).toEqual(['c', 'a', 'b'])
  })

  it('(5) a walk with one frame brought to front and one created mid-walk sees each original once and the new frame last', () => {
    type Placed = FrameKey & { z: number }
    const base: Placed[] = Array.from({ length: 60 }, (_, i) => ({ id: `f${i}`, createdAt: 1000 + i, z: i }))
    const pageAt = (call: number): Placed[] => {
      if (call === 0) return base
      // call 1: f40 (not yet seen) and f3 (seen) brought to front, a frame created after the walk began
      const moved = base.map((f) => (f.id === 'f40' || f.id === 'f3' ? { ...f, z: 1000 + f.z } : f))
      return [...moved.reverse(), { id: 'new1', createdAt: 9000, z: 2000 }]
    }
    const seen: string[] = []
    let after: string | null = null
    for (let call = 0; call < 10; call++) {
      const win = windowAfter(walkOrder(pageAt(call)), after ? parseAfter(after) : null)
      const { result } = assembleLintResult(
        win,
        win.frames.map((f) => row(Number(f.id.replace(/\D/g, '')), { frame_id: f.id })),
        scan(),
      )
      seen.push(...result.frames.map((r) => r.frame_id))
      after = nextAfter(result)
      if (after === null) break
    }
    expect(seen.filter((id) => id !== 'new1').sort()).toEqual(base.map((f) => f.id).sort())
    expect(new Set(seen).size).toBe(seen.length)
    expect(seen.at(-1)).toBe('new1')
    expect(seen.length).toBe(61)
  })

  it('a deleted frame named in after still orders the rest', () => {
    const order = walkOrder(frames(10).filter((f) => f.id !== 'f4'))
    const win = windowAfter(order, parseAfter('1004:f4'))
    expect(win.frames.map((f) => f.id)).toEqual(['f5', 'f6', 'f7', 'f8', 'f9'])
    expect(win.frames_before).toBe(4)
    expect(win.frames_after).toBe(0)
    expect(win.after).toBe('1004:f4')
  })

  it('windowAfter takes at most 24 frames and counts the rest', () => {
    const win = windowAfter(walkOrder(frames(60)), parseAfter('1009:f9'))
    expect(win.frames.length).toBe(24)
    expect(win.frames[0]!.id).toBe('f10')
    expect(win.frames_before).toBe(10)
    expect(win.frames_after).toBe(26)
  })

  it('(7) after together with frame_ids, a malformed after, and bad ids are input errors', () => {
    const order = walkOrder(frames(5))
    expect(() => resolveWindow(order, { after: '1000:f0', frame_ids: ['f1'] })).toThrow(FrameLintInputError)
    for (const bad of [
      '',
      'f0',
      '1000',
      '1000:',
      ':f0',
      '1000:f 0',
      '-1:f0',
      'a:f0',
      '12345678901234567:f0',
      `1000:${'a'.repeat(65)}`,
    ]) {
      expect(() => parseAfter(bad), bad).toThrow(FrameLintInputError)
      expect(() => resolveWindow(order, { after: bad }), bad).toThrow(FrameLintInputError)
    }
    expect(() => resolveWindow(order, { frame_ids: ['bad id'] })).toThrow(FrameLintInputError)
    expect(() => resolveWindow(order, { frame_ids: ['a'.repeat(65)] })).toThrow(FrameLintInputError)
    expect(() => resolveWindow(order, { frame_ids: Array.from({ length: 25 }, (_, i) => `f${i}`) })).toThrow(
      FrameLintInputError,
    )
    expect(parseAfter('1000:f0')).toEqual({ createdAt: 1000, id: 'f0' })
    expect(resolveWindow(order, { after: '1001:f1' }).frames.map((f) => f.id)).toEqual(['f2', 'f3', 'f4'])
    expect(resolveWindow(order, { frame_ids: ['f4', 'f4', 'f0'] }).frames.map((f) => f.id)).toEqual(['f0', 'f4'])
    expect(resolveWindow(order, {}).mode).toBe('page')
  })
})

describe('cutString', () => {
  it('cuts on a code point inside the escaped-byte cap and marks the cut', () => {
    expect(cutString('short', 20)).toEqual({ value: 'short', cut: false })
    for (let cap = 3; cap < 40; cap++) {
      for (const input of ['😀'.repeat(30), NASTY.repeat(10), '€'.repeat(30), 'a😀b'.repeat(10)]) {
        const out = cutString(input, cap)
        expect(out.cut).toBe(true)
        expect(out.value.endsWith('…')).toBe(true)
        expect(jsonBytes(out.value) - 2).toBeLessThanOrEqual(cap)
        // the cut keeps only whole code points of the input (a lone surrogate in the input stays one unit)
        const body = out.value.slice(0, -1)
        expect(input.startsWith(body)).toBe(true)
        if (wellFormed(input)) expect(wellFormed(body)).toBe(true)
      }
    }
  })

  it('counts escapes: a control character is 6 bytes, a quote 2, a lone surrogate 6', () => {
    expect(cutString('\u0001'.repeat(10), 30).value).toBe('\u0001'.repeat(4) + '…')
    expect(jsonBytes('\u0001') - 2).toBe(6)
    expect(cutString('"'.repeat(11), 20).value).toBe('"'.repeat(8) + '…')
    expect(cutString('\ud800'.repeat(10), 20).value).toBe('\ud800'.repeat(2) + '…')
  })
})
