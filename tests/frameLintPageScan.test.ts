import { describe, expect, it } from 'vitest'
import { scanPage, type ScanFrame, type ScanOptions } from '../server/frameLintPageScan.ts'
import { PAGE_RULES, type PageFinding, type PageRule } from '../shared/frameLint.ts'
import { STATE_CONTROL_CAP } from '../shared/frameLintStates.ts'

/* CHE-9115 S3p: the whole-page scan. Whole page or nothing: a scan that did not finish gives no finding at all. */

const OPTS: ScanOptions = { budgetMs: 5_000, maxFrameChars: 1_500_000, maxPageChars: 10_000_000 }
const frame = (id: string, html: string): ScanFrame => ({ id, html })
const SELECT = '<select data-doop-id="country"><option>a</option></select>'

describe('scanPage with the real rules', () => {
  it('files each finding under its frame and counts every rule over the whole page', async () => {
    const scan = await scanPage([frame('a', '<p>x</p>'), frame('b', SELECT)], PAGE_RULES, OPTS)
    expect(scan).toMatchObject({ scope: 'all frames', reason: null, frames_scanned: 2, skipped: [] })
    expect(scan.chars_scanned).toBe('<p>x</p>'.length + SELECT.length)
    expect(scan.by_rule).toEqual({ 'state-error': 1 })
    expect([...scan.findings.keys()]).toEqual(['b'])
    expect(scan.findings.get('b')![0]).toMatchObject({ rule: 'state-error', level: 'warn' })
    expect('frame_id' in scan.findings.get('b')![0]!).toBe(false)
  })

  it('skips a frame over the size cap by size alone and says the pairing is incomplete', async () => {
    const scan = await scanPage([frame('a', SELECT), frame('big', 'z'.repeat(101))], PAGE_RULES, {
      ...OPTS,
      maxFrameChars: 100,
    })
    expect(scan.scope).toBe('all frames except skipped')
    expect(scan.skipped).toEqual([{ frame_id: 'big', reason: 'html over 100 chars' }])
    expect(scan.frames_scanned).toBe(1)
    expect(scan.findings.get('a')![0]!.message).toContain('pairing incomplete: 1 frames skipped')
  })

  it('skips a frame whose facts pass the per-frame cap', async () => {
    const many = `<form data-doop-id="f">${SELECT.repeat(STATE_CONTROL_CAP + 1)}</form>`
    const scan = await scanPage([frame('many', many), frame('ok', '<p>x</p>')], PAGE_RULES, OPTS)
    expect(scan.scope).toBe('all frames except skipped')
    expect(scan.skipped).toEqual([{ frame_id: 'many', reason: 'facts over cap' }])
    expect(scan.findings.size).toBe(0)
  })
})

describe('scanPage: size and time', () => {
  const spy = () => {
    const calls: string[] = []
    const rule: PageRule = {
      id: 'spy',
      collect: (html) => {
        calls.push(html)
        return { html }
      },
      evaluate: (frames) =>
        frames.map((f): PageFinding => ({ frame_id: f.frame_id, rule: 'spy', level: 'info', message: 'seen' })),
    }
    return { calls, rule }
  }

  it('is NOT-RUN page over cap before it parses anything, and still names the skipped frames', async () => {
    const { calls, rule } = spy()
    const scan = await scanPage(
      [frame('a', 'x'.repeat(60)), frame('b', 'x'.repeat(60)), frame('c', 'x'.repeat(200))],
      [rule],
      {
        ...OPTS,
        maxFrameChars: 100,
        maxPageChars: 100,
      },
    )
    expect(calls).toEqual([])
    expect(scan).toMatchObject({ scope: 'NOT-RUN', reason: 'page over 100 chars', frames_scanned: 0, by_rule: {} })
    expect(scan.skipped).toEqual([{ frame_id: 'c', reason: 'html over 100 chars' }])
    expect(scan.findings.size).toBe(0)
  })

  it('drops every collected fact when the budget runs out: NOT-RUN deadline and no finding', async () => {
    const { rule } = spy()
    const scan = await scanPage([frame('a', 'x'), frame('b', 'y'), frame('c', 'z')], [rule], { ...OPTS, budgetMs: 0 })
    expect(scan).toMatchObject({ scope: 'NOT-RUN', reason: 'deadline', frames_scanned: 0, by_rule: {} })
    expect(scan.findings.size).toBe(0)
  })

  it('drops the facts of a scan that ran out of time part-way', async () => {
    const slow: PageRule = {
      id: 'slow',
      collect: () => {
        const until = performance.now() + 15
        while (performance.now() < until);
        return {}
      },
      evaluate: (frames) => frames.map((f) => ({ frame_id: f.frame_id, rule: 'slow', level: 'info', message: 'm' })),
    }
    const scan = await scanPage([frame('a', 'x'), frame('b', 'y'), frame('c', 'z')], [slow], { ...OPTS, budgetMs: 20 })
    expect(scan).toMatchObject({ scope: 'NOT-RUN', reason: 'deadline' })
    expect(scan.findings.size).toBe(0)
    expect(scan.by_rule).toEqual({})
  })

  it('stops when the signal aborts', async () => {
    const { rule } = spy()
    const controller = new AbortController()
    controller.abort()
    const scan = await scanPage([frame('a', 'x')], [rule], { ...OPTS, signal: controller.signal })
    expect(scan).toMatchObject({ scope: 'NOT-RUN', reason: 'deadline' })
  })

  it('reads one frame per turn of the event loop and evaluates over all frames at once', async () => {
    /* a counter that moves once per turn of the event loop */
    let tick = 0
    let running = true
    const count = () => {
      tick++
      if (running) setImmediate(count)
    }
    setImmediate(count)
    const seen: number[] = []
    const evaluated: number[] = []
    const rule: PageRule = {
      id: 'turns',
      collect: () => {
        seen.push(tick)
        return {}
      },
      evaluate: (frames) => {
        evaluated.push(frames.length)
        return []
      },
    }
    try {
      await scanPage(
        Array.from({ length: 6 }, (_, i) => frame(`f${i}`, 'x')),
        [rule],
        OPTS,
      )
    } finally {
      running = false
    }
    expect(evaluated).toEqual([6])
    expect(new Set(seen).size).toBeGreaterThan(1)
  })

  it('a rule that throws makes its frame skipped, not the whole scan', async () => {
    const bad: PageRule = {
      id: 'bad',
      collect: (html) => {
        if (html === 'boom') throw new Error('boom')
        return {}
      },
      evaluate: () => [],
    }
    const scan = await scanPage([frame('a', 'boom'), frame('b', 'ok')], [bad], OPTS)
    expect(scan.scope).toBe('all frames except skipped')
    expect(scan.skipped).toEqual([{ frame_id: 'a', reason: 'rule failed' }])
  })
})
