import { describe, expect, it } from 'vitest'
// @ts-expect-error plain .mjs script, no type declarations
import { measure } from '../scripts/upstream-watch/measure.mjs'

/* Day 0 = 1 Dec 2026 00:00 ICT. t(day) is an ISO instant `day` days after it. */
const DAY0 = Date.parse('2026-12-01T00:00:00+07:00')
const t = (day: number) => new Date(DAY0 + day * 864e5).toISOString()
const H = (h: number) => h / 24
const SHA_A = 'a'.repeat(40)
const SHA_B = 'b'.repeat(40)

const rel = (tag: string, commit: string, day: number) => ({ tag, commit, published_at: t(day) })
const pr = (n: number, created: number, merged: number | null, contains: string[], closed: number | null = null) => ({
  number: n,
  createdAt: t(created),
  mergedAt: merged === null ? null : t(merged),
  closedAt: closed === null ? null : t(closed),
  contains,
})

type Input = Record<string, unknown>
const base = (over: Input): Input => ({
  now: t(1),
  deadline: t(21),
  releases: [],
  prs: [],
  ledger_children: [],
  seen_tags: {},
  read_errors: [],
  ...over,
})
type Dur = { minutes: number; text: string }
type TagOut = {
  tag: string
  outcome: string
  reason?: string
  m1: Dur | null
  m1_prime: Dur | null
  m2_at_publication: Dur
  m2_at_72h: unknown
}
const only = (out: { tags: TagOut[] }, tag: string) => out.tags.find((x) => x.tag === tag) as TagOut

describe('measure: per-tag outcome table', () => {
  it('early merge (12 h after publication): PENDING with the +72 h checkpoint', () => {
    const out = measure(
      base({
        now: t(H(30)),
        releases: [rel('v1.0.0', SHA_A, 0)],
        prs: [pr(1, H(2), H(12), [SHA_A])],
      }),
    )
    expect(out.outcome).toBe('PENDING')
    expect(out.next_check).toBe(t(3))
    expect(only(out, 'v1.0.0').outcome).toBe('PENDING')
    expect(only(out, 'v1.0.0').m2_at_72h).toEqual({ pending_until: t(3) })
  })

  it('merged and now >= published + 72 h: RECORDED', () => {
    const out = measure(base({ now: t(4), releases: [rel('v1.0.0', SHA_A, 0)], prs: [pr(1, H(2), H(12), [SHA_A])] }))
    expect(out.outcome).toBe('RECORDED')
    expect(only(out, 'v1.0.0').m1?.minutes).toBe(120)
  })

  it('an older tag covered by the newer tag PR: covered, not MISS', () => {
    const out = measure(
      base({
        now: t(22),
        releases: [rel('v1.0.0', SHA_A, 0), rel('v1.1.0', SHA_B, 2)],
        prs: [pr(7, 3, 4, [SHA_A, SHA_B])],
      }),
    )
    expect(out.outcome).toBe('RECORDED')
    expect(only(out, 'v1.0.0').outcome).toBe('RECORDED')
    // M1 of the covered tag is measured by that newer PR: 3 days after v1.0.0 published
    expect(only(out, 'v1.0.0').m1?.minutes).toBe(3 * 1440)
  })

  it('open PR: PENDING before the deadline, MISS "open sync" at it', () => {
    const input = { releases: [rel('v1.0.0', SHA_A, 0)], prs: [pr(1, 1, null, [SHA_A])] }
    expect(measure(base({ ...input, now: t(5) })).outcome).toBe('PENDING')
    const out = measure(base({ ...input, now: t(21) }))
    expect(out.outcome).toBe('MISS')
    expect(only(out, 'v1.0.0').reason).toBe('open sync')
  })

  it('a closed unmerged PR does not cover the tag', () => {
    const out = measure(base({ now: t(21), releases: [rel('v1.0.0', SHA_A, 0)], prs: [pr(1, 1, null, [SHA_A], 2)] }))
    expect(only(out, 'v1.0.0').reason).toBe('lost admission')
  })

  it('admitted tag with no PR: PENDING before the deadline, MISS "no sync PR" at it', () => {
    const input = { releases: [rel('v1.0.0', SHA_A, 0)], ledger_children: [{ tag: 'v1.0.0' }] }
    expect(measure(base({ ...input, now: t(20) })).outcome).toBe('PENDING')
    const out = measure(base({ ...input, now: t(21) }))
    expect(out.outcome).toBe('MISS')
    expect(only(out, 'v1.0.0').reason).toBe('no sync PR')
    expect(only(out, 'v1.0.0').m1?.text).toBe('no PR, open 504 h')
  })

  it('same tag with no ledger child, at the deadline: MISS "lost admission"', () => {
    const out = measure(base({ now: t(21), releases: [rel('v1.0.0', SHA_A, 0)] }))
    expect(out.outcome).toBe('MISS')
    expect(only(out, 'v1.0.0').reason).toBe('lost admission')
  })

  it('a tag seen but with no release starts its clock at seen_at', () => {
    const out = measure(
      base({
        now: t(5),
        seen_tags: { 'v1.0.0': { commit: SHA_A, published_at: null, seen_at: t(1) } },
        prs: [pr(1, 2, 2.5, [SHA_A])],
      }),
    )
    expect(only(out, 'v1.0.0').m1?.minutes).toBe(1440)
  })
})

describe('measure: S9 outcome order', () => {
  it('a lookup error at the deadline: ERROR, not NOT-RUN', () => {
    const out = measure(base({ now: t(21), read_errors: ['releases API 502'] }))
    expect(out.outcome).toBe('ERROR')
    expect(out.reason).toContain('releases API 502')
  })

  it('ERROR overrides every other outcome', () => {
    const out = measure(base({ now: t(21), releases: [rel('v1.0.0', SHA_A, 0)], read_errors: ['compare 500'] }))
    expect(out.outcome).toBe('ERROR')
  })

  it('K2: merged tag whose checkpoint falls after expiry: PENDING at published + 72 h, not the elapsed deadline', () => {
    const out = measure(
      base({
        now: t(21),
        releases: [rel('v1.0.0', SHA_A, 20)],
        prs: [pr(1, 20.2, 20.5, [SHA_A])],
      }),
    )
    expect(out.outcome).toBe('PENDING')
    expect(out.next_check).toBe(t(23))
    expect(only(out, 'v1.0.0').m2_at_72h).toEqual({ pending_until: t(23) })
  })

  it('PENDING wins over MISS; next_check is the earliest future candidate', () => {
    const out = measure(
      base({
        now: t(21),
        releases: [rel('v1.0.0', SHA_A, 0), rel('v1.1.0', SHA_B, 20)],
        prs: [pr(1, 20.2, 20.5, [SHA_B])],
        ledger_children: [],
      }),
    )
    // v1.0.0 is not covered (MISS), v1.1.0 pends to day 23, and PENDING wins
    expect(out.outcome).toBe('PENDING')
    expect(out.next_check).toBe(t(23))
  })

  it('MISS wins over RECORDED', () => {
    const out = measure(
      base({
        now: t(30),
        releases: [rel('v1.0.0', SHA_A, 0), rel('v1.1.0', SHA_B, 1)],
        prs: [pr(1, 0.5, 1, [SHA_A])],
      }),
    )
    expect(out.outcome).toBe('MISS')
    expect(only(out, 'v1.0.0').outcome).toBe('RECORDED')
    expect(only(out, 'v1.1.0').outcome).toBe('MISS')
  })

  it('PENDING with no future candidate is ERROR "no future wake"', () => {
    const out = measure(base({ now: t(5), deadline: null, releases: [rel('v1.0.0', SHA_A, 0)] }))
    expect(out.outcome).toBe('ERROR')
    expect(out.reason).toBe('no future wake')
  })

  it('no release: PENDING before the deadline, NOT-RUN at or after it', () => {
    const before = measure(base({ now: t(5) }))
    expect(before.outcome).toBe('PENDING')
    expect(before.next_check).toBe(t(21))
    expect(measure(base({ now: t(21) })).outcome).toBe('NOT-RUN')
    expect(measure(base({ now: t(22) })).outcome).toBe('NOT-RUN')
  })
})

describe('measure: M1, M1 prime, M2', () => {
  it('v0.15.0 history: M2 = 46 h 26 min', () => {
    const ict = (s: string) => new Date(s).toISOString()
    const out = measure(
      base({
        now: '2026-11-19T00:00:00+07:00',
        deadline: '2026-12-07T00:00:00+07:00',
        releases: [
          { tag: 'v0.14.0', commit: SHA_A, published_at: ict('2026-11-10T00:00:00+07:00') },
          { tag: 'v0.15.0', commit: SHA_B, published_at: ict('2026-11-16T15:29:00+07:00') },
        ],
        prs: [
          {
            number: 40,
            createdAt: ict('2026-11-12T00:00:00+07:00'),
            mergedAt: ict('2026-11-18T13:55:00+07:00'),
            contains: [SHA_A],
          },
        ],
      }),
    )
    const v15 = only(out, 'v0.15.0')
    expect(v15.m2_at_publication.minutes).toBe(46 * 60 + 26)
    expect(v15.m2_at_publication.text).toBe('46 h 26 min')
  })

  it('M2 at +72 h stays at the checkpoint state when the predecessor merges later, even on a delayed read', () => {
    const out = measure(
      base({
        now: t(10 + H(120)),
        releases: [rel('v1.0.0', SHA_A, 9), rel('v1.1.0', SHA_B, 10)],
        prs: [pr(1, 9.5, 10 + H(100), [SHA_A])],
      }),
    )
    const v = only(out, 'v1.1.0')
    expect(v.m2_at_publication).toMatchObject({ minutes: 100 * 60 })
    expect(v.m2_at_72h).toMatchObject({ minutes: 72 * 60, ongoing: true })
  })

  it('M2 at +72 h while the predecessor is still unmerged: 72 h, ongoing', () => {
    const out = measure(
      base({ now: t(10 + H(80)), releases: [rel('v1.0.0', SHA_A, 9), rel('v1.1.0', SHA_B, 10)], prs: [] }),
    )
    expect(only(out, 'v1.1.0').m2_at_72h).toMatchObject({ minutes: 72 * 60, ongoing: true })
  })

  it('M2 at +72 h is the merge delay when the predecessor merged before the checkpoint', () => {
    const out = measure(
      base({
        now: t(10 + H(120)),
        releases: [rel('v1.0.0', SHA_A, 9), rel('v1.1.0', SHA_B, 10)],
        prs: [pr(1, 9.5, 10 + H(30), [SHA_A])],
      }),
    )
    const m2 = only(out, 'v1.1.0').m2_at_72h as { minutes: number; ongoing?: boolean }
    expect(m2.minutes).toBe(30 * 60)
    expect(m2.ongoing).toBeUndefined()
  })

  it('a tag with no predecessor has M2 = 0 at the checkpoint, not ongoing', () => {
    const out = measure(base({ now: t(10), releases: [rel('v1.0.0', SHA_A, 0)], prs: [] }))
    const v = only(out, 'v1.0.0')
    expect(v.m2_at_72h).toEqual({ minutes: 0, text: '0 h 0 min' })
    expect(v.m2_at_publication).toEqual({ minutes: 0, text: '0 h 0 min' })
  })

  it('M2 is 0 when the predecessor merged before publication', () => {
    const out = measure(
      base({
        now: t(10),
        releases: [rel('v1.0.0', SHA_A, 0), rel('v1.1.0', SHA_B, 5)],
        prs: [pr(1, 1, 2, [SHA_A])],
      }),
    )
    expect(only(out, 'v1.1.0').m2_at_publication.minutes).toBe(0)
  })

  it('M1 prime: burst PR createdAt minus the predecessor end', () => {
    const out = measure(
      base({
        now: t(30),
        releases: [rel('v1.0.0', SHA_A, 0), rel('v1.1.0', SHA_B, 1)],
        prs: [pr(1, 0.5, 4, [SHA_A]), pr(2, 5, 6, [SHA_B])],
      }),
    )
    expect(only(out, 'v1.1.0').m1_prime?.minutes).toBe(1440)
    expect(only(out, 'v1.0.0').m1_prime).toBeNull()
  })
})

describe('measure: every PENDING output has next_check > now', () => {
  const fixtures: Input[] = [
    { now: t(1), releases: [rel('v1.0.0', SHA_A, 0)] },
    { now: t(1) },
    { now: t(21), releases: [rel('v1.0.0', SHA_A, 20)], prs: [pr(1, 20.2, 20.5, [SHA_A])] },
    { now: t(2), releases: [rel('v1.0.0', SHA_A, 0)], prs: [pr(1, 1, null, [SHA_A])] },
    { now: t(20.99), releases: [rel('v1.0.0', SHA_A, 0)], ledger_children: [{ tag: 'v1.0.0' }] },
    { now: t(2.99), releases: [rel('v1.0.0', SHA_A, 0)], prs: [pr(1, 1, 2, [SHA_A])] },
  ]
  it.each(fixtures.map((f, i) => [i, f] as const))('fixture %i', (_i, f) => {
    const out = measure(base(f))
    expect(out.outcome).toBe('PENDING')
    expect(Date.parse(out.next_check)).toBeGreaterThan(Date.parse(f.now as string))
  })
})
