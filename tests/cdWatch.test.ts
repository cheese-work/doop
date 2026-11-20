import { describe, expect, it } from 'vitest'
// @ts-expect-error plain .mjs without types
import * as watch from '../scripts/cd-watch.mjs'

/* CHE-5550 (train S7, plan CHE-5474 C-7): the two watchers' decisions as pure functions. The CLI and the
   workflows only feed them facts read from GitHub and from C00's /healthz. */
const { lastSlot, freshness, liveVerdict, lastDeployed, deploymentRecord, ghPostArgs, recordDeployment } = watch as {
  lastSlot: (nowMs: number) => number
  freshness: (f: Record<string, unknown>) => { action: string; reason: string; rerunD1: boolean }
  liveVerdict: (f: Record<string, unknown>) => Promise<{ ok: boolean; reason: string }>
  lastDeployed: (h: {
    recorded: { sha: string; runId: number | null } | null
    listRuns: (page: number) => Promise<{ id: number; conclusion: string }[]>
    read: (id: number) => Promise<{ outcome?: string; candidate_sha?: string } | null>
    maxScan?: number
  }) => Promise<{ state: string; sha?: string; reason?: string }>
  deploymentRecord: (evidence: Record<string, unknown>) => { ref: string; environment: string } | null
  ghPostArgs: (repo: string, route: string, fields: Record<string, string | boolean>) => string[]
  recordDeployment: (h: {
    repo: string
    evidence: Record<string, unknown>
    runId: string
    gh: (args: string[]) => string
    recordedSha: () => { sha: string; runId: number | null } | null
  }) => string
}

const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
const C = 'c'.repeat(40)
const known = (sha: string) => ({ state: 'known', sha })
const NONE = { state: 'none' }
const UNKNOWN = { state: 'unknown', reason: 'the history is unreadable' }
const MIN = 60_000
// 14:17 ICT on 20 Nov 2026 = 07:17 UTC
const SLOT = Date.UTC(2026, 10, 20, 7, 17)
const base = {
  trainOn: true,
  candidate: { sha: B },
  deployed: known(A),
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
    expect(freshness({ ...base, nowMs: SLOT + 60 * MIN, deployed: known(B) }).action).toBe('none')
    expect(freshness({ ...base, nowMs: SLOT + 100 * MIN, deployed: known(B) }).action).toBe('none')
  })

  it('treats "no successful D2 yet" as behind', () => {
    expect(freshness({ ...base, nowMs: SLOT + 50 * MIN, deployed: NONE }).action).toBe('dispatch')
  })

  it('alarms at once, not after 45 min, when a candidate exists and the last successful D2 is unknown', () => {
    const out = freshness({ ...base, nowMs: SLOT + 5 * MIN, deployed: UNKNOWN })
    expect(out.action).toBe('alarm')
    expect(out.reason).toMatch(/unknown/)
    expect(out.reason).toContain('the history is unreadable')
  })

  it('does not alarm on an unknown history while no candidate is due', () => {
    expect(freshness({ ...base, nowMs: SLOT + 5 * MIN, deployed: UNKNOWN, candidate: null }).action).toBe('none')
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
      await liveVerdict({ body: { ok: true, revision: A }, deployed: known(A), isAncestor: ancestors([]) }),
    ).toMatchObject({
      ok: true,
    })
  })

  it('passes when live is ahead of the last successful D2 SHA (a deploy that has not written its evidence yet)', async () => {
    const out = await liveVerdict({
      body: { ok: true, revision: B },
      deployed: known(A),
      isAncestor: ancestors([[A, B]]),
    })
    expect(out.ok).toBe(true)
  })

  it('fails when the live revision is behind the last successful D2 SHA', async () => {
    const out = await liveVerdict({
      body: { ok: true, revision: A },
      deployed: known(B),
      isAncestor: ancestors([[A, B]]),
    })
    expect(out.ok).toBe(false)
    expect(out.reason).toContain(A.slice(0, 7))
    expect(out.reason).toContain(B.slice(0, 7))
  })

  it('fails closed on a diverged revision', async () => {
    const out = await liveVerdict({ body: { ok: true, revision: C }, deployed: known(B), isAncestor: ancestors([]) })
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
      const out = await liveVerdict({ body, deployed: known(A), isAncestor: ancestors([]) })
      expect(out.ok, JSON.stringify(body)).toBe(false)
    }
  })

  it('fails when /healthz says not ok', async () => {
    expect(
      (await liveVerdict({ body: { ok: false, revision: A }, deployed: known(A), isAncestor: ancestors([]) })).ok,
    ).toBe(false)
  })

  it('has nothing to compare with before any proven successful D2, but still needs a healthy answer', async () => {
    const out = await liveVerdict({ body: { ok: true, revision: A }, deployed: NONE, isAncestor: ancestors([]) })
    expect(out).toMatchObject({ ok: true })
    expect(out.reason).toMatch(/no successful D2/)
    for (const body of [null, { ok: false, revision: A }, { ok: true, revision: 'unknown' }, { ok: true }]) {
      expect((await liveVerdict({ body, deployed: NONE, isAncestor: ancestors([]) })).ok, JSON.stringify(body)).toBe(
        false,
      )
    }
  })

  it('fails visibly when the last successful D2 is unknown, even if /healthz is fine', async () => {
    const out = await liveVerdict({ body: { ok: true, revision: A }, deployed: UNKNOWN, isAncestor: ancestors([]) })
    expect(out.ok).toBe(false)
    expect(out.reason).toMatch(/unknown/)
  })
})

describe('lastDeployed: the last successful D2 SHA, from a durable record first and the evidence artifacts second', () => {
  type Ev = { outcome: string; candidate_sha: string } | null
  const pages =
    (all: { id: number; conclusion: string }[], size = 100) =>
    async (page: number) =>
      all.slice((page - 1) * size, page * size)
  const reader = (evidence: Record<number, Ev>) => async (id: number) => evidence[id] ?? null
  const skip = (id: number) => ({ id, conclusion: 'success' })

  const rec = (sha: string, runId: number | null = 50) => ({ sha, runId })
  const failed = (id: number) => ({ id, conclusion: 'failure' })

  it('is the deployment record when no run is newer than it, without reading a single artifact', async () => {
    const out = await lastDeployed({
      recorded: rec(A),
      listRuns: pages([skip(50), skip(49)]),
      read: async () => {
        throw new Error('must not read evidence')
      },
    })
    expect(out).toEqual({ state: 'known', sha: A, source: 'deployment record' })
  })

  it('is the record when the runs newer than it deployed nothing, and does not read the record run or older', async () => {
    const read = reader({
      52: { outcome: 'not_deployed', candidate_sha: C },
      51: { outcome: 'failed', candidate_sha: B },
    })
    const seen: number[] = []
    const out = await lastDeployed({
      recorded: rec(A),
      listRuns: pages([skip(52), failed(51), skip(50), skip(49)]),
      read: async (id) => (seen.push(id), read(id)),
    })
    expect(out).toMatchObject({ state: 'known', sha: A })
    expect(seen).toEqual([52, 51])
  })

  it('is unknown, not the older record, when a newer run confirmed a deploy that has no record (record A, confirmed B, record of B failed)', async () => {
    const out = await lastDeployed({
      recorded: rec(A),
      listRuns: pages([failed(52), skip(50)]),
      read: reader({ 52: { outcome: 'confirmed', candidate_sha: B } }),
    })
    expect(out.state).toBe('unknown')
    expect(out.reason).toContain('52')
    expect(out.reason).toContain('bbbbbbb')
    expect(out.reason).toContain('no deployment record')
  })

  it('is unknown when a newer green run has expired or unreadable evidence: it could have been that deploy', async () => {
    const out = await lastDeployed({ recorded: rec(A), listRuns: pages([skip(51), skip(50)]), read: reader({}) })
    expect(out.state).toBe('unknown')
    expect(out.reason).toContain('51')
  })

  it('is unknown when a newer confirmed run has no usable SHA', async () => {
    const out = await lastDeployed({
      recorded: rec(A),
      listRuns: pages([skip(51)]),
      read: reader({ 51: { outcome: 'confirmed', candidate_sha: 'nope' } }),
    })
    expect(out.state).toBe('unknown')
  })

  it('skips a newer failed run that left no evidence: it failed before it could confirm', async () => {
    const out = await lastDeployed({ recorded: rec(A), listRuns: pages([failed(51), skip(50)]), read: reader({}) })
    expect(out).toMatchObject({ state: 'known', sha: A })
  })

  it('without the record run id, takes the record only if the newest confirmed evidence agrees with it', async () => {
    const ok = await lastDeployed({
      recorded: rec(A, null),
      listRuns: pages([skip(2)]),
      read: reader({ 2: { outcome: 'confirmed', candidate_sha: A } }),
    })
    expect(ok).toMatchObject({ state: 'known', sha: A })
    const newer = await lastDeployed({
      recorded: rec(A, null),
      listRuns: pages([skip(2)]),
      read: reader({ 2: { outcome: 'confirmed', candidate_sha: B } }),
    })
    expect(newer.state).toBe('unknown')
    expect(await lastDeployed({ recorded: rec(A, null), listRuns: pages([]), read: reader({}) })).toMatchObject({
      state: 'known',
      sha: A,
    })
  })

  it('is unknown when the scan limit is hit before the record run is reached', async () => {
    const runs = Array.from({ length: 12 }, (_, i) => skip(100 - i))
    const evidence: Record<number, Ev> = {}
    for (const r of runs) evidence[r.id] = { outcome: 'not_deployed', candidate_sha: C }
    const out = await lastDeployed({
      recorded: rec(A, 10),
      listRuns: pages(runs, 5),
      read: reader(evidence),
      maxScan: 10,
    })
    expect(out.state).toBe('unknown')
  })

  it('fails the live watcher when the record is older than a confirmed deploy and live is still the record', async () => {
    const deployed = await lastDeployed({
      recorded: rec(A),
      listRuns: pages([failed(52), skip(50)]),
      read: reader({ 52: { outcome: 'confirmed', candidate_sha: B } }),
    })
    const out = await liveVerdict({ body: { ok: true, revision: A }, deployed, isAncestor: async () => false })
    expect(out.ok).toBe(false)
    expect(out.reason).toContain('unknown')
  })

  it('finds a confirmed deployment behind 30+ skipped runs, which a 30-run window missed', async () => {
    const runs = Array.from({ length: 45 }, (_, i) => skip(100 - i)) // 100..56 newest first
    const evidence: Record<number, Ev> = {}
    for (const r of runs) evidence[r.id] = { outcome: 'not_deployed', candidate_sha: C }
    evidence[56] = { outcome: 'confirmed', candidate_sha: A }
    const out = await lastDeployed({ recorded: null, listRuns: pages(runs, 10), read: reader(evidence) })
    expect(out).toMatchObject({ state: 'known', sha: A })
  })

  it('skips a failure and a not_deployed run, and takes the newest confirmed one', async () => {
    const runs = [skip(4), { id: 3, conclusion: 'failure' }, skip(2), skip(1)]
    const evidence: Record<number, Ev> = {
      4: { outcome: 'not_deployed', candidate_sha: C },
      3: { outcome: 'failed', candidate_sha: B },
      2: { outcome: 'confirmed', candidate_sha: B },
      1: { outcome: 'confirmed', candidate_sha: A },
    }
    expect(await lastDeployed({ recorded: null, listRuns: pages(runs), read: reader(evidence) })).toMatchObject({
      sha: B,
    })
  })

  it('is none, a proven first deployment, only when every run is readable and none was confirmed', async () => {
    const runs = [skip(2), { id: 1, conclusion: 'failure' }]
    const evidence: Record<number, Ev> = { 2: { outcome: 'not_deployed', candidate_sha: C } }
    // run 1 failed and left no evidence: a failed run cannot have confirmed, so it does not make the history unknown
    expect(await lastDeployed({ recorded: null, listRuns: pages(runs), read: reader(evidence) })).toEqual({
      state: 'none',
    })
    expect(await lastDeployed({ recorded: null, listRuns: pages([]), read: reader({}) })).toEqual({ state: 'none' })
  })

  it('is unknown, not none, when a green run has expired or unreadable evidence', async () => {
    const runs = [skip(3), skip(2), skip(1)]
    const evidence: Record<number, Ev> = { 3: { outcome: 'not_deployed', candidate_sha: C } }
    const out = await lastDeployed({ recorded: null, listRuns: pages(runs), read: reader(evidence) })
    expect(out.state).toBe('unknown')
    expect(out.reason).toContain('2')
  })

  it('is unknown when confirmed evidence carries no usable SHA', async () => {
    const out = await lastDeployed({
      recorded: null,
      listRuns: pages([skip(1)]),
      read: reader({ 1: { outcome: 'confirmed', candidate_sha: 'nope' } }),
    })
    expect(out.state).toBe('unknown')
  })

  it('is unknown, not none, when the scan limit is hit before the history ends', async () => {
    const runs = Array.from({ length: 12 }, (_, i) => skip(12 - i))
    const evidence: Record<number, Ev> = {}
    for (const r of runs) evidence[r.id] = { outcome: 'not_deployed', candidate_sha: C }
    const out = await lastDeployed({ recorded: null, listRuns: pages(runs, 5), read: reader(evidence), maxScan: 10 })
    expect(out.state).toBe('unknown')
  })

  it('ignores a malformed deployment record and falls back to the artifacts', async () => {
    const out = await lastDeployed({
      recorded: rec('not-a-sha'),
      listRuns: pages([skip(1)]),
      read: reader({ 1: { outcome: 'confirmed', candidate_sha: A } }),
    })
    expect(out).toMatchObject({ state: 'known', sha: A })
  })
})

describe('deploymentRecord: what D2 writes durably after a confirmed deploy', () => {
  it('is a c00-doop deployment of the candidate SHA when the outcome is confirmed', () => {
    expect(deploymentRecord({ outcome: 'confirmed', candidate_sha: A })).toMatchObject({
      ref: A,
      environment: 'c00-doop',
    })
  })

  it('is nothing for any other outcome or a malformed SHA', () => {
    for (const outcome of ['not_deployed', 'failed', 'rolled_back', 'superseded'])
      expect(deploymentRecord({ outcome, candidate_sha: A }), outcome).toBeNull()
    expect(deploymentRecord({ outcome: 'confirmed', candidate_sha: 'nope' })).toBeNull()
    expect(deploymentRecord({ outcome: 'confirmed' })).toBeNull()
  })
})

describe('the deployment record request (typed fields, read back)', () => {
  it('sends strings with -f and booleans with -F, so auto_merge and production_environment are JSON booleans', () => {
    expect(
      ghPostArgs('o/r', 'deployments', {
        ref: A,
        environment: 'c00-doop',
        auto_merge: false,
        production_environment: true,
      }),
    ).toEqual([
      'api',
      '-X',
      'POST',
      'repos/o/r/deployments',
      '-f',
      `ref=${A}`,
      '-f',
      'environment=c00-doop',
      '-F',
      'auto_merge=false',
      '-F',
      'production_environment=true',
    ])
  })

  const evidence = { outcome: 'confirmed', candidate_sha: A }
  const fake = (recorded: { sha: string; runId: number | null } | null) => {
    const calls: string[][] = []
    const gh = (args: string[]) => (calls.push(args), JSON.stringify({ id: 7 }))
    return { calls, gh, recordedSha: () => recorded }
  }

  it('posts the deployment with typed booleans, then the success status, then reads it back', () => {
    const f = fake({ sha: A, runId: 123 })
    const out = recordDeployment({ repo: 'o/r', evidence, runId: '123', gh: f.gh, recordedSha: f.recordedSha })
    expect(out).toContain('recorded')
    expect(f.calls).toHaveLength(2)
    const [deployment, status] = f.calls as [string[], string[]]
    expect(deployment).toContain('repos/o/r/deployments')
    expect(deployment.join(' ')).toContain('-F auto_merge=false')
    expect(deployment.join(' ')).toContain('-F production_environment=true')
    expect(deployment.join(' ')).not.toMatch(/-f (auto_merge|production_environment)=/)
    expect(deployment.join(' ')).toContain('D2 run 123')
    expect(status).toContain('repos/o/r/deployments/7/statuses')
    expect(status.join(' ')).toContain('state=success')
  })

  it('fails when the record does not read back, so the D2 run goes red instead of losing the deploy', () => {
    const f = fake({ sha: B, runId: 99 })
    expect(() =>
      recordDeployment({ repo: 'o/r', evidence, runId: '123', gh: f.gh, recordedSha: f.recordedSha }),
    ).toThrow(/did not read back/)
    const none = fake(null)
    expect(() =>
      recordDeployment({ repo: 'o/r', evidence, runId: '123', gh: none.gh, recordedSha: none.recordedSha }),
    ).toThrow(/did not read back/)
  })

  it('fails when the write itself is refused, and posts no status for a deployment that was not created', () => {
    const calls: string[][] = []
    const gh = (args: string[]) => {
      calls.push(args)
      throw new Error('HTTP 403')
    }
    expect(() => recordDeployment({ repo: 'o/r', evidence, runId: '123', gh, recordedSha: () => null })).toThrow(/403/)
    expect(calls).toHaveLength(1)
  })

  it('records nothing for a run that did not confirm a deploy', () => {
    const f = fake(null)
    const out = recordDeployment({
      repo: 'o/r',
      evidence: { outcome: 'not_deployed', candidate_sha: A },
      runId: '123',
      gh: f.gh,
      recordedSha: f.recordedSha,
    })
    expect(out).toContain('nothing to record')
    expect(f.calls).toHaveLength(0)
  })
})
