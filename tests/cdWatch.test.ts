import { describe, expect, it } from 'vitest'
// @ts-expect-error plain .mjs without types
import * as watch from '../scripts/cd-watch.mjs'

/* CHE-5550 (train S7, plan CHE-5474 C-7): the two watchers' decisions as pure functions. The CLI and the
   workflows only feed them facts read from GitHub and from C00's /healthz. */
const {
  lastSlot,
  freshness,
  liveVerdict,
  lastDeployed,
  deployJobsAllSkipped,
  deploymentRecord,
  ghPostArgs,
  recordDeployment,
  c00Host,
} = watch as {
  c00Host: (env: Record<string, string | undefined>) => string
  lastSlot: (nowMs: number) => number
  deployJobsAllSkipped: (jobs: { name: string; conclusion: string | null }[] | undefined) => boolean
  freshness: (f: Record<string, unknown>) => { action: string; reason: string; rerunD1: boolean }
  liveVerdict: (f: Record<string, unknown>) => Promise<{ ok: boolean; reason: string }>
  lastDeployed: (h: {
    recorded: { sha: string; runId: number | null; confirmedAt: number } | null
    listRuns: (page: number) => Promise<Record<string, unknown>[]>
    read: (id: number) => Promise<Record<string, unknown> | null>
    deploySkipped?: (id: number) => Promise<boolean>
    maxScan?: number
    nowMs?: number
  }) => Promise<{ state: string; sha?: string; reason?: string }>
  deploymentRecord: (
    evidence: Record<string, unknown>,
  ) => { ref: string; environment: string; confirmedAt: string | null } | null
  ghPostArgs: (repo: string, route: string, fields: Record<string, string | boolean>) => string[]
  recordDeployment: (h: {
    repo: string
    evidence: Record<string, unknown>
    runId: string
    gh: (args: string[], input?: string) => string
    recordedSha: () => { sha: string; runId: number | null; confirmedAt?: number } | null
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

  it('alarms at 90 min while a candidate is still ahead and a D2 run exists since the slot (skipped, suspended, forward-only)', () => {
    expect(freshness({ ...base, nowMs: SLOT + 90 * MIN, d2RunsSinceSlot: 2 })).toMatchObject({ action: 'alarm' })
    expect(freshness({ ...base, nowMs: SLOT + 155 * MIN, d2RunsSinceSlot: 1 })).toMatchObject({ action: 'alarm' })
    expect(freshness({ ...base, nowMs: SLOT + 89 * MIN, d2RunsSinceSlot: 2 }).action).toBe('none')
  })

  // CHE-10498: the 27 Nov 2026 slot was missed and the watch only started 155 min later: it alarmed every 15 min and never
  // dispatched, so C00 waited 8 h for the next slot.
  it('at 90 min or later with a candidate ahead and no D2 run since the slot: dispatches once AND alarms', () => {
    const out = freshness({ ...base, nowMs: SLOT + 155 * MIN, d2RunsSinceSlot: 0 })
    expect(out.action).toBe('dispatch')
    expect(out.alarm).toBe(true)
    expect(out.reason).toContain('155 min after the slot')
    expect(out.reason).toContain(B.slice(0, 7))
    expect(out.reason).toContain(A.slice(0, 7))
    expect(freshness({ ...base, nowMs: SLOT + 90 * MIN, d2RunsSinceSlot: 0 })).toMatchObject({
      action: 'dispatch',
      alarm: true,
    })
  })

  it('at 155 min with a D2 run since the slot: alarm only, no second dispatch', () => {
    const out = freshness({ ...base, nowMs: SLOT + 155 * MIN, d2RunsSinceSlot: 1 })
    expect(out.action).toBe('alarm')
    expect(out.alarm).toBeUndefined()
  })

  it('an on-time dispatch (45 to 89 min) does not alarm', () => {
    expect(freshness({ ...base, nowMs: SLOT + 60 * MIN }).alarm).toBeFalsy()
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

describe('lastDeployed: the last successful D2 SHA, ordered by confirmation time, from a durable record first', () => {
  type Ev = { outcome: string; candidate_sha: string; times?: { confirmed: { utc: string } } } | null
  type Run = { id: number; conclusion: string; status: string; created_at: string; updated_at: string }
  // The record A was confirmed at RT by run 50. A run's id orders its creation here: run N is created (N - 50) h after RT.
  const RT = Date.UTC(2026, 10, 20, 7, 30)
  const H = 60 * MIN
  const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')
  const run = (id: number, o: Partial<Run> & { updatedAfterRT?: number } = {}): Run => {
    const created = RT + (id - 50) * H
    return {
      id,
      conclusion: 'success',
      status: 'completed',
      created_at: iso(created),
      updated_at: iso(o.updatedAfterRT === undefined ? created + 20 * MIN : RT + o.updatedAfterRT),
      ...o,
    }
  }
  const skip = (id: number) => run(id)
  const failed = (id: number) => run(id, { conclusion: 'failure' })
  const pages =
    (all: Run[], size = 100) =>
    async (page: number) =>
      all.slice((page - 1) * size, page * size)
  const reader = (evidence: Record<number, Ev>) => async (id: number) => evidence[id] ?? null
  const confirmed = (sha: string, atMs: number): Ev => ({
    outcome: 'confirmed',
    candidate_sha: sha,
    times: { confirmed: { utc: iso(atMs) } },
  })
  // run N confirmed 10 min after its creation
  const conf = (id: number, sha: string) => confirmed(sha, RT + (id - 50) * H + 10 * MIN)
  const rec = (sha: string, runId: number | null = 50, confirmedAt: number = RT) => ({ sha, runId, confirmedAt })

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

  it('is the record when the runs after it deployed nothing, and reads neither the record run nor a run that ended before it', async () => {
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
      read: reader({ 52: conf(52, B) }),
    })
    expect(out.state).toBe('unknown')
    expect(out.reason).toContain('52')
    expect(out.reason).toContain('bbbbbbb')
    expect(out.reason).toContain('no deployment record')
  })

  // CHE-8873, review of 8933e0df: run ID does not order deployments. Run 40 was created before run 52, queued behind
  // it, and confirmed B after run 52 recorded A; its evidence upload failed, so there is no record and no evidence.
  it('is unknown when an OLDER run, by ID, was still active after the record and left no evidence (confirm B after record A, upload failed)', async () => {
    const out = await lastDeployed({
      recorded: rec(A, 52, RT),
      listRuns: pages([run(52), run(40, { conclusion: 'failure', updatedAfterRT: 30 * MIN })]),
      read: reader({ 52: conf(52, A) }),
    })
    expect(out.state).toBe('unknown')
    expect(out.reason).toContain('40')
    expect(out.reason).toContain('no evidence')
  })

  it('fails the live watcher on that sequence: the older run confirmed B, no record or evidence of B, live is A', async () => {
    const deployed = await lastDeployed({
      recorded: rec(A, 52, RT),
      listRuns: pages([run(52), run(40, { conclusion: 'failure', updatedAfterRT: 30 * MIN })]),
      read: reader({}),
    })
    const out = await liveVerdict({ body: { ok: true, revision: A }, deployed, isAncestor: async () => false })
    expect(out.ok).toBe(false)
    expect(out.reason).toContain('unknown')
  })

  it('is unknown when an older run, by ID, has evidence confirming a different SHA after the record', async () => {
    const out = await lastDeployed({
      recorded: rec(A, 52, RT),
      listRuns: pages([run(52), run(40, { updatedAfterRT: 30 * MIN })]),
      read: reader({ 40: confirmed(B, RT + 20 * MIN) }),
    })
    expect(out.state).toBe('unknown')
    expect(out.reason).toContain('40')
  })

  it('keeps the record when an older run, rerun after it, confirmed a different SHA BEFORE it', async () => {
    const out = await lastDeployed({
      recorded: rec(A, 52, RT),
      listRuns: pages([run(52), run(40, { updatedAfterRT: 30 * MIN })]),
      read: reader({ 40: confirmed(B, RT - 3 * H) }),
    })
    expect(out).toMatchObject({ state: 'known', sha: A })
  })

  it('does not read a run that ended before the record was confirmed, whatever its ID', async () => {
    const out = await lastDeployed({
      recorded: rec(A, 52, RT),
      listRuns: pages([run(52), run(40)]),
      read: async () => {
        throw new Error('must not read evidence')
      },
    })
    expect(out).toMatchObject({ state: 'known', sha: A })
  })

  it('is unknown when a newer green run has expired or unreadable evidence: it could have been that deploy', async () => {
    const out = await lastDeployed({ recorded: rec(A), listRuns: pages([skip(51), skip(50)]), read: reader({}) })
    expect(out.state).toBe('unknown')
    expect(out.reason).toContain('51')
  })

  it('is unknown when a newer confirmed run has no usable SHA or no confirmation time', async () => {
    const bad = (e: Ev) => lastDeployed({ recorded: rec(A), listRuns: pages([skip(51)]), read: reader({ 51: e }) })
    expect((await bad({ outcome: 'confirmed', candidate_sha: 'nope', times: conf(51, B)?.times })).state).toBe(
      'unknown',
    )
    expect((await bad({ outcome: 'confirmed', candidate_sha: B })).state).toBe('unknown')
  })

  it('is unknown when a newer failed run left no evidence: it could have confirmed a deploy before its evidence upload failed', async () => {
    const out = await lastDeployed({ recorded: rec(A), listRuns: pages([failed(51), skip(50)]), read: reader({}) })
    expect(out.state).toBe('unknown')
    expect(out.reason).toContain('51')
    expect(out.reason).toContain('no evidence')
  })

  it('is unknown when a newer cancelled run left no evidence', async () => {
    const out = await lastDeployed({
      recorded: rec(A),
      listRuns: pages([run(51, { conclusion: 'cancelled' }), skip(50)]),
      read: reader({}),
    })
    expect(out.state).toBe('unknown')
  })

  // CHE-9479: a run whose `deploy` job was skipped never touched C00, so it cannot have confirmed anything. It writes no
  // evidence when the run predates the evidence job, or the job did not run. That is a skip, not an unreadable history.
  describe('a clean skip that left no evidence (CHE-9479)', () => {
    const skipped = (ids: number[]) => async (id: number) => ids.includes(id)

    it('is read as skipped: the record stays the answer', async () => {
      const out = await lastDeployed({
        recorded: rec(A),
        listRuns: pages([skip(51), skip(50)]),
        read: reader({}),
        deploySkipped: skipped([51]),
      })
      expect(out).toMatchObject({ state: 'known', sha: A })
    })

    it('is read as skipped with no record: none, not unknown, so a candidate is dispatched', async () => {
      const out = await lastDeployed({
        recorded: null,
        listRuns: pages([skip(2), skip(1)]),
        read: reader({}),
        deploySkipped: skipped([1, 2]),
      })
      expect(out).toEqual({ state: 'none' })
      const f = freshness({ ...base, deployed: out, nowMs: SLOT + 50 * MIN })
      expect(f.action).toBe('dispatch')
    })

    it('still finds a deploy confirmed behind skipped runs that left no evidence', async () => {
      const out = await lastDeployed({
        recorded: null,
        listRuns: pages([skip(3), skip(2), skip(1)]),
        read: reader({ 1: conf(1, A) }),
        deploySkipped: skipped([3, 2]),
      })
      expect(out).toMatchObject({ state: 'known', sha: A })
    })

    it('is still unknown when the deploy job ran (a deploy could have confirmed before the upload failed)', async () => {
      const out = await lastDeployed({
        recorded: rec(A),
        listRuns: pages([failed(51), skip(50)]),
        read: reader({}),
        deploySkipped: skipped([]),
      })
      expect(out.state).toBe('unknown')
      expect(out.reason).toContain('51')
    })

    // Review P1: a deploy may confirm in attempt 1, lose its evidence and record, then a full rerun skips `deploy`.
    it('reads the deploy jobs of every attempt, not only the newest', () => {
      const job = (conclusion: string | null) => ({ name: 'deploy', conclusion })
      expect(deployJobsAllSkipped([job('skipped')])).toBe(true)
      expect(deployJobsAllSkipped([job('skipped'), job('skipped')])).toBe(true)
      // deployed first attempt, skipped later attempt
      expect(deployJobsAllSkipped([job('success'), job('skipped')])).toBe(false)
      expect(deployJobsAllSkipped([job('failure'), job('skipped')])).toBe(false)
      expect(deployJobsAllSkipped([job('cancelled'), job('skipped')])).toBe(false)
      expect(deployJobsAllSkipped([job(null), job('skipped')])).toBe(false)
      // no deploy job at all is no proof
      expect(deployJobsAllSkipped([])).toBe(false)
      expect(deployJobsAllSkipped([{ name: 'resolve', conclusion: 'success' }])).toBe(false)
      expect(deployJobsAllSkipped(undefined)).toBe(false)
    })

    it('stays unknown when a deployed first attempt is followed by a skipped rerun with no evidence', async () => {
      const out = await lastDeployed({
        recorded: rec(A),
        listRuns: pages([skip(51), skip(50)]),
        read: reader({}),
        deploySkipped: async () =>
          deployJobsAllSkipped([
            { name: 'deploy', conclusion: 'success' },
            { name: 'deploy', conclusion: 'skipped' },
          ]),
      })
      expect(out.state).toBe('unknown')
      expect(out.reason).toContain('51')
    })

    it('is still unknown without a way to read the jobs', async () => {
      const out = await lastDeployed({ recorded: rec(A), listRuns: pages([skip(51)]), read: reader({}) })
      expect(out.state).toBe('unknown')
    })

    it('does not trust the job check when the run left evidence: evidence wins', async () => {
      const out = await lastDeployed({
        recorded: rec(A),
        listRuns: pages([skip(51)]),
        read: reader({ 51: conf(51, B) }),
        deploySkipped: skipped([51]),
      })
      expect(out.state).toBe('unknown')
      expect(out.reason).toContain('record')
    })
  })

  it('fails the live watcher on confirm B, evidence upload failed, record A, live A', async () => {
    const deployed = await lastDeployed({ recorded: rec(A), listRuns: pages([failed(52), skip(50)]), read: reader({}) })
    const out = await liveVerdict({ body: { ok: true, revision: A }, deployed, isAncestor: async () => false })
    expect(out.ok).toBe(false)
    expect(out.reason).toContain('unknown')
  })

  it('is pending while a young D2 run is unfinished, and unknown once it is stuck', async () => {
    const live = run(52, { status: 'in_progress', conclusion: null as unknown as string })
    const young = Date.parse(live.created_at) + H
    const out = await lastDeployed({ recorded: rec(A), listRuns: pages([live]), read: reader({}), nowMs: young })
    expect(out).toMatchObject({ state: 'pending' })
    const stuck = await lastDeployed({
      recorded: rec(A),
      listRuns: pages([live]),
      read: reader({}),
      nowMs: Date.parse(live.created_at) + 4 * H,
    })
    expect(stuck.state).toBe('unknown')
    expect(stuck.reason).toContain('52')
  })

  it('stops at a run created more than 30 days before the record: it cannot be active after it', async () => {
    const old = { ...run(2), created_at: iso(RT - 31 * 24 * H), updated_at: iso(RT + 5 * MIN) }
    const out = await lastDeployed({ recorded: rec(A), listRuns: pages([skip(50), old]), read: reader({}) })
    expect(out).toMatchObject({ state: 'known', sha: A })
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
      read: reader({ 52: conf(52, B) }),
    })
    const out = await liveVerdict({ body: { ok: true, revision: A }, deployed, isAncestor: async () => false })
    expect(out.ok).toBe(false)
    expect(out.reason).toContain('unknown')
  })

  it('finds a confirmed deployment behind 30+ skipped runs, which a 30-run window missed', async () => {
    const runs = Array.from({ length: 45 }, (_, i) => skip(100 - i)) // 100..56 newest first
    const evidence: Record<number, Ev> = {}
    for (const r of runs) evidence[r.id] = { outcome: 'not_deployed', candidate_sha: C }
    evidence[56] = conf(56, A)
    const out = await lastDeployed({ recorded: null, listRuns: pages(runs, 10), read: reader(evidence) })
    expect(out).toMatchObject({ state: 'known', sha: A })
  })

  it('with no record, takes the latest CONFIRMATION, not the newest-created run', async () => {
    // run 3 was created later but confirmed B before run 2 confirmed A
    const runs = [skip(3), run(2, { updatedAfterRT: -47 * H + 60 * MIN }), skip(1)]
    const evidence: Record<number, Ev> = {
      3: confirmed(B, RT - 47 * H + 10 * MIN),
      2: confirmed(A, RT - 47 * H + 40 * MIN),
      1: conf(1, C),
    }
    expect(await lastDeployed({ recorded: null, listRuns: pages(runs), read: reader(evidence) })).toMatchObject({
      state: 'known',
      sha: A,
    })
  })

  it('skips a failure and a not_deployed run, and takes the newest confirmed one', async () => {
    const runs = [skip(4), failed(3), skip(2), skip(1)]
    const evidence: Record<number, Ev> = {
      4: { outcome: 'not_deployed', candidate_sha: C },
      3: { outcome: 'failed', candidate_sha: B },
      2: conf(2, B),
      1: conf(1, A),
    }
    expect(await lastDeployed({ recorded: null, listRuns: pages(runs), read: reader(evidence) })).toMatchObject({
      sha: B,
    })
  })

  it('is none, a proven first deployment, only when every run is readable and none was confirmed', async () => {
    const runs = [skip(2), failed(1)]
    const evidence: Record<number, Ev> = {
      2: { outcome: 'not_deployed', candidate_sha: C },
      1: { outcome: 'failed', candidate_sha: B },
    }
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

  it('ignores a malformed deployment record (no SHA or no confirmation time) and falls back to the artifacts', async () => {
    const evidence = { 1: conf(1, A) }
    for (const recorded of [rec('not-a-sha'), { sha: B, runId: 9, confirmedAt: Number.NaN }]) {
      const out = await lastDeployed({ recorded, listRuns: pages([skip(1)]), read: reader(evidence) })
      expect(out).toMatchObject({ state: 'known', sha: A })
    }
  })
})

describe('a pending D2 run (a young unfinished run that may confirm a deploy)', () => {
  const pending = { state: 'pending', reason: 'D2 run 9 is in_progress: it may confirm a deploy' }
  it('freshness idles before 90 min and still alarms at 90 min while a D2 run is queued or unfinished', () => {
    expect(freshness({ ...base, nowMs: SLOT + 60 * MIN, deployed: pending })).toMatchObject({ action: 'none' })
    const late = freshness({ ...base, nowMs: SLOT + 100 * MIN, deployed: pending })
    expect(late.action).toBe('alarm')
    expect(late.reason).toContain('D2 run 9')
  })

  it('live defers only the SHA comparison: a healthy /healthz passes', async () => {
    const out = await liveVerdict({ body: { ok: true, revision: A }, deployed: pending, isAncestor: async () => false })
    expect(out.ok).toBe(true)
    expect(out.reason).toContain('D2 run 9')
  })

  it('live fails an unreachable, unhealthy or malformed /healthz while a D2 run is pending', async () => {
    for (const body of [null, { ok: false, revision: A }, { ok: true }, { ok: true, revision: 'nope' }]) {
      const out = await liveVerdict({ body, deployed: pending, isAncestor: async () => false })
      expect(out.ok, JSON.stringify(body)).toBe(false)
    }
  })
})

const CONFIRMED = '2026-11-20T07:30:00Z'

describe('deploymentRecord: what D2 writes durably after a confirmed deploy', () => {
  it('is a c00-doop deployment of the candidate SHA when the outcome is confirmed', () => {
    expect(
      deploymentRecord({ outcome: 'confirmed', candidate_sha: A, times: { confirmed: { utc: CONFIRMED } } }),
    ).toMatchObject({
      ref: A,
      environment: 'c00-doop',
      confirmedAt: CONFIRMED,
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

  const evidence = { outcome: 'confirmed', candidate_sha: A, times: { confirmed: { utc: CONFIRMED } } }
  const fake = (recorded: { sha: string; runId: number | null } | null) => {
    const calls: string[][] = []
    const inputs: (string | undefined)[] = []
    const gh = (args: string[], input?: string) => (calls.push(args), inputs.push(input), JSON.stringify({ id: 7 }))
    return { calls, inputs, gh, recordedSha: () => recorded }
  }

  it('posts the deployment as a JSON body with typed booleans and an empty required_contexts, then the success status, then reads it back', () => {
    const f = fake({ sha: A, runId: 123 })
    const out = recordDeployment({ repo: 'o/r', evidence, runId: '123', gh: f.gh, recordedSha: f.recordedSha })
    expect(out).toContain('recorded')
    expect(f.calls).toHaveLength(2)
    const [deployment, status] = f.calls as [string[], string[]]
    expect(deployment).toEqual(['api', '-X', 'POST', 'repos/o/r/deployments', '--input', '-'])
    const body = JSON.parse(f.inputs[0] ?? '')
    // CHE-10262: without required_contexts GitHub answers 409 when any check-run of the commit failed.
    expect(body.required_contexts).toEqual([])
    expect(body).toMatchObject({ ref: A, environment: 'c00-doop', auto_merge: false, production_environment: true })
    expect(body.description).toContain(`D2 run 123, confirmed ${CONFIRMED}`)
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

  it('fails, and posts nothing, when confirmed evidence has no confirmation time: the watchers could not order it', () => {
    const f = fake(null)
    expect(() =>
      recordDeployment({
        repo: 'o/r',
        evidence: { outcome: 'confirmed', candidate_sha: A },
        runId: '123',
        gh: f.gh,
        recordedSha: f.recordedSha,
      }),
    ).toThrow(/confirmation time/)
    expect(f.calls).toHaveLength(0)
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

describe('c00Host: where the live watcher reads the host (CHE-9479)', () => {
  it('is the repo variable when set', () => {
    expect(c00Host({ DOOP_C00_HOST: 'doop.example.ts.net' })).toBe('doop.example.ts.net')
  })

  it('falls back to the documented default when the variable is unset or blank, never to an empty host', () => {
    expect(c00Host({})).toBe('congvc-c00.taila6fa8a.ts.net:34443')
    expect(c00Host({ DOOP_C00_HOST: '  ' })).toBe('congvc-c00.taila6fa8a.ts.net:34443')
  })

  it('has no scheme and no path', () => {
    expect(c00Host({})).not.toMatch(/[/]/)
  })
})
