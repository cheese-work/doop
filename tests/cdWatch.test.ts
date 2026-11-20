import { describe, expect, it } from 'vitest'
// @ts-expect-error plain .mjs without types
import * as watch from '../scripts/cd-watch.mjs'

/* CHE-5550 (train S7, plan CHE-5474 C-7): the two watchers' decisions as pure functions. The CLI and the
   workflows only feed them facts read from GitHub and from C00's /healthz. */
const { lastSlot, freshness, liveVerdict, lastDeployed } = watch as {
  lastSlot: (nowMs: number) => number
  freshness: (f: Record<string, unknown>) => { action: string; reason: string; rerunD1: boolean }
  liveVerdict: (f: Record<string, unknown>) => Promise<{ ok: boolean; reason: string }>
  lastDeployed: (
    runs: { id: number }[],
    read: (id: number) => Promise<{ outcome?: string; candidate_sha?: string } | null>,
  ) => Promise<string | null>
}

const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
const C = 'c'.repeat(40)
const MIN = 60_000
// 14:17 ICT on 20 Nov 2026 = 07:17 UTC
const SLOT = Date.UTC(2026, 10, 20, 7, 17)
const base = {
  trainOn: true,
  candidate: { sha: B },
  deployedSha: A,
  d2RunsSinceSlot: 0,
  head: { conclusion: 'success', attempt: 1 },
}

describe('lastSlot: the 06:17, 14:17 and 22:17 ICT slots (cron 17 23,7,15 * * *)', () => {
  it('is the newest slot at or before now', () => {
    expect(lastSlot(SLOT)).toBe(SLOT)
    expect(lastSlot(SLOT + 59 * MIN)).toBe(SLOT)
    expect(lastSlot(SLOT - 1)).toBe(Date.UTC(2026, 10, 19, 23, 17))
    expect(lastSlot(Date.UTC(2026, 10, 20, 15, 16))).toBe(SLOT)
    expect(lastSlot(Date.UTC(2026, 10, 20, 15, 17))).toBe(Date.UTC(2026, 10, 20, 15, 17))
  })
})

describe('freshness (C-7.1)', () => {
  it('does nothing before the slot is 45 min old', () => {
    expect(freshness({ ...base, nowMs: SLOT + 44 * MIN }).action).toBe('none')
  })

  it('sends one schedule_backup dispatch when 45 min old, a candidate is ahead and no D2 run exists since the slot', () => {
    const out = freshness({ ...base, nowMs: SLOT + 45 * MIN })
    expect(out.action).toBe('dispatch')
  })

  it('sends no second dispatch once a D2 run exists since the slot', () => {
    expect(freshness({ ...base, nowMs: SLOT + 60 * MIN, d2RunsSinceSlot: 1 }).action).toBe('none')
  })

  it('does nothing when the candidate is the last successful D2 SHA', () => {
    expect(freshness({ ...base, nowMs: SLOT + 60 * MIN, deployedSha: B }).action).toBe('none')
    expect(freshness({ ...base, nowMs: SLOT + 100 * MIN, deployedSha: B }).action).toBe('none')
  })

  it('treats "no successful D2 yet" as behind', () => {
    expect(freshness({ ...base, nowMs: SLOT + 50 * MIN, deployedSha: null }).action).toBe('dispatch')
  })

  it('does nothing without a qualified candidate', () => {
    expect(freshness({ ...base, nowMs: SLOT + 100 * MIN, candidate: null }).action).toBe('none')
  })

  it('alarms at 90 min while a candidate is still ahead, whether or not a D2 run exists (skipped, suspended, forward-only)', () => {
    expect(freshness({ ...base, nowMs: SLOT + 90 * MIN }).action).toBe('alarm')
    expect(freshness({ ...base, nowMs: SLOT + 90 * MIN, d2RunsSinceSlot: 2 }).action).toBe('alarm')
    expect(freshness({ ...base, nowMs: SLOT + 89 * MIN, d2RunsSinceSlot: 2 }).action).toBe('none')
  })

  it('names the candidate and the deployed SHA in the alarm reason', () => {
    const out = freshness({ ...base, nowMs: SLOT + 95 * MIN })
    expect(out.reason).toContain(B.slice(0, 7))
    expect(out.reason).toContain(A.slice(0, 7))
  })

  it('is a clean no-op while the switch is not on', () => {
    for (const trainOn of [false]) {
      const out = freshness({ ...base, trainOn, nowMs: SLOT + 100 * MIN })
      expect(out.action).toBe('none')
      expect(out.rerunD1).toBe(false)
      expect(out.reason).toMatch(/DOOP_DEPLOY_TRAIN/)
    }
  })

  it('reruns a failed D1 build once, and not a second time', () => {
    const failed = { conclusion: 'failure', attempt: 1 }
    expect(freshness({ ...base, nowMs: SLOT + 10 * MIN, head: failed }).rerunD1).toBe(true)
    expect(freshness({ ...base, nowMs: SLOT + 10 * MIN, head: { conclusion: 'failure', attempt: 2 } }).rerunD1).toBe(
      false,
    )
    expect(freshness({ ...base, nowMs: SLOT + 10 * MIN, head: { conclusion: 'success', attempt: 1 } }).rerunD1).toBe(
      false,
    )
    expect(freshness({ ...base, nowMs: SLOT + 10 * MIN, head: { conclusion: null, attempt: 1 } }).rerunD1).toBe(false)
  })
})

describe('liveVerdict (C-7.2)', () => {
  const ancestors = (pairs: [string, string][]) => async (a: string, b: string) =>
    pairs.some(([x, y]) => x === a && y === b)

  it('passes when the live revision is the last successful D2 SHA', async () => {
    expect(
      await liveVerdict({ body: { ok: true, revision: A }, deployed: A, isAncestor: ancestors([]) }),
    ).toMatchObject({
      ok: true,
    })
  })

  it('passes when live is ahead of the last successful D2 SHA (a deploy that has not written its evidence yet)', async () => {
    const out = await liveVerdict({ body: { ok: true, revision: B }, deployed: A, isAncestor: ancestors([[A, B]]) })
    expect(out.ok).toBe(true)
  })

  it('fails when the live revision is behind the last successful D2 SHA', async () => {
    const out = await liveVerdict({ body: { ok: true, revision: A }, deployed: B, isAncestor: ancestors([[A, B]]) })
    expect(out.ok).toBe(false)
    expect(out.reason).toContain(A.slice(0, 7))
    expect(out.reason).toContain(B.slice(0, 7))
  })

  it('fails closed on a diverged revision', async () => {
    const out = await liveVerdict({ body: { ok: true, revision: C }, deployed: B, isAncestor: ancestors([]) })
    expect(out.ok).toBe(false)
  })

  it('fails closed when /healthz gives no usable revision', async () => {
    for (const body of [
      null,
      {},
      { ok: true },
      { ok: true, revision: 'unknown' },
      { ok: true, revision: A.toUpperCase() },
    ]) {
      const out = await liveVerdict({ body, deployed: A, isAncestor: ancestors([]) })
      expect(out.ok, JSON.stringify(body)).toBe(false)
    }
  })

  it('fails when /healthz says not ok', async () => {
    expect((await liveVerdict({ body: { ok: false, revision: A }, deployed: A, isAncestor: ancestors([]) })).ok).toBe(
      false,
    )
  })

  it('has nothing to compare with before any successful D2', async () => {
    const out = await liveVerdict({ body: { ok: true, revision: A }, deployed: null, isAncestor: ancestors([]) })
    expect(out).toMatchObject({ ok: true })
    expect(out.reason).toMatch(/no successful D2/)
  })
})

describe('lastDeployed', () => {
  const evidence: Record<number, { outcome: string; candidate_sha: string } | null> = {
    3: { outcome: 'not_deployed', candidate_sha: C },
    2: null,
    1: { outcome: 'confirmed', candidate_sha: A },
  }
  const read = async (id: number) => evidence[id] ?? null

  it('is the candidate of the newest D2 run whose evidence says confirmed', async () => {
    expect(await lastDeployed([{ id: 3 }, { id: 2 }, { id: 1 }], read)).toBe(A)
  })

  it('skips runs with no evidence, a failure, or a malformed SHA', async () => {
    const odd = async (id: number) => (id === 5 ? { outcome: 'confirmed', candidate_sha: 'nope' } : read(id))
    expect(await lastDeployed([{ id: 5 }, { id: 2 }, { id: 1 }], odd)).toBe(A)
  })

  it('is null when no run was confirmed', async () => {
    expect(await lastDeployed([{ id: 3 }, { id: 2 }], read)).toBeNull()
  })
})
