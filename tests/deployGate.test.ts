import { describe, expect, it } from 'vitest'
// @ts-expect-error plain .mjs script, no type declarations
import { decide, recheck as recheckAt } from '../scripts/deploy-gate.mjs'

type Api = (path: string) => Promise<unknown>
const SHA = 'c'.repeat(40)
const REPO = 'cheese-work/doop'

/* Fake GitHub: answers by path, records every read so a test can prove a path
   was never taken. An unknown path is an error, like a failed `gh api`. */
function fakeApi(routes: Record<string, unknown>) {
  const calls: string[] = []
  const api: Api = async (path) => {
    calls.push(path)
    if (path in routes) {
      const v = routes[path]
      return typeof v === 'function' ? v(path) : v
    }
    for (const [prefix, value] of Object.entries(routes)) {
      if (path.startsWith(prefix)) return typeof value === 'function' ? value(path) : value
    }
    throw new Error(`unexpected read ${path}`)
  }
  return { api, calls }
}

/* `recheck` first reads its own run to enforce the maximum run age. Tests that are not about age get a run
   created a day before NOW; `created: null` is a run with no creation time. NOW is 9 Nov 2026 08:00 ICT. */
const NOW = Date.parse('2026-11-09T01:00:00Z')
const DAY = 24 * 3600 * 1000
type RecheckArgs = Record<string, unknown> & { ghApi: Api; created?: string | null }
const recheck = ({ created, ...args }: RecheckArgs) => {
  const own = `repos/${REPO}/actions/runs/${args.runId}`
  const ghApi: Api = (path) =>
    path === own
      ? Promise.resolve(created === null ? {} : { created_at: created ?? new Date(NOW - DAY).toISOString() })
      : args.ghApi(path)
  return recheckAt({ now: NOW, ...args, ghApi })
}

const mergedPull = (login: string | null, over: Record<string, unknown> = {}) => ({
  number: 7,
  merged_at: '2026-11-09T00:00:00Z',
  merge_commit_sha: SHA,
  base: { ref: 'cheese/main' },
  merged_by: login ? { login } : null,
  ...over,
})
const pullRoutes = (login: string | null, over: Record<string, unknown> = {}) => ({
  [`repos/${REPO}/commits/${SHA}/pulls`]: [{ number: 7, merge_commit_sha: SHA }],
  [`repos/${REPO}/pulls/7`]: mergedPull(login, over),
})

const push = { event: 'push', ref: 'refs/heads/cheese/main', sha: SHA, repo: REPO, runId: '99', extra: '', paused: '' }
const noRuns = { [`repos/${REPO}/actions/workflows/image.yml/runs`]: { workflow_runs: [] } }

/* Deploy jobs finish in an order of their own, not in run-creation order. Unless a test says otherwise,
   run N's deploy completes N seconds after midnight, so a higher id finishes later. */
const done = (id: number, ms = 500) => new Date(Date.UTC(2026, 10, 9, 0, 0, id, ms)).toISOString()
const deployJob = (id: number, c: string, completed_at?: string | null) =>
  c === 'in_progress'
    ? { name: 'deploy', status: 'in_progress', conclusion: null, completed_at: null }
    : { name: 'deploy', conclusion: c, completed_at: completed_at === undefined ? done(id) : completed_at }

/* history: newest created first, each [runId, deploy job conclusion | null for "no deploy job ran" |
   'in_progress', extra run fields; `completed_at` in extra goes on the deploy job instead] */
function history(entries: [number, string | null, Record<string, unknown>?][]) {
  return {
    [`repos/${REPO}/actions/workflows/image.yml/runs`]: {
      workflow_runs: entries.map(([id, , extra]) => {
        const { completed_at: _skip, ...run } = extra ?? {}
        return { id, ...run }
      }),
    },
    ...Object.fromEntries(
      entries.map(([id, c, extra]) => [
        `repos/${REPO}/actions/runs/${id}/jobs`,
        {
          jobs: [
            { name: 'image', conclusion: 'success' },
            ...(c ? [deployJob(id, c, extra?.completed_at as string | null | undefined)] : []),
          ],
        },
      ]),
    ),
  }
}

describe('deploy gate: merge-actor allowlist (push to cheese/main)', () => {
  it('authorizes a merge by the owner', async () => {
    const { api } = fakeApi({ ...pullRoutes('congvc-dev'), ...noRuns })
    expect(await decide({ ...push, ghApi: api })).toMatchObject({ authorized: true })
  })

  it('authorizes a merge by a login in the extra allowlist, ignoring blanks and case', async () => {
    const { api } = fakeApi({ ...pullRoutes('Agent-Merger'), ...noRuns })
    expect(await decide({ ...push, extra: ' , agent-merger ,', ghApi: api })).toMatchObject({ authorized: true })
  })

  it('builds and stops for any other merger, before reading any run history', async () => {
    const { api, calls } = fakeApi({ ...pullRoutes('some-contributor'), ...noRuns })
    const out = await decide({ ...push, extra: 'agent-merger', ghApi: api })
    expect(out.authorized).toBe(false)
    expect(out.reason).toContain('some-contributor')
    expect(calls.some((c) => c.includes('/runs'))).toBe(false)
  })

  it('never lets an empty or hostile variable lock out or widen past the allowlist', async () => {
    const { api } = fakeApi({ ...pullRoutes('congvc-dev'), ...noRuns })
    expect(await decide({ ...push, extra: '', ghApi: api })).toMatchObject({ authorized: true })
    const other = fakeApi({ ...pullRoutes('mallory'), ...noRuns })
    expect(await decide({ ...push, extra: '*,,congvc-dev-evil', ghApi: other.api })).toMatchObject({
      authorized: false,
    })
  })

  it('does not authorize when no pull request owns the commit (direct push)', async () => {
    const { api } = fakeApi({ [`repos/${REPO}/commits/${SHA}/pulls`]: [], ...noRuns })
    const out = await decide({ ...push, ghApi: api })
    expect(out.authorized).toBe(false)
    expect(out.reason).toContain('nobody found')
  })

  it.each([
    ['another merge commit', { merge_commit_sha: 'd'.repeat(40) }],
    ['a base other than cheese/main', { base: { ref: 'main' } }],
    ['an unmerged pull request', { merged_at: null }],
  ])('does not trust a pull request with %s', async (_name, over) => {
    const { api } = fakeApi({ ...pullRoutes('congvc-dev', over), ...noRuns })
    expect(await decide({ ...push, ghApi: api })).toMatchObject({ authorized: false })
  })

  it('reads merged_by from the pull request itself, not from the commit list', async () => {
    const { api, calls } = fakeApi({
      [`repos/${REPO}/commits/${SHA}/pulls`]: [
        { number: 7, merge_commit_sha: SHA, merged_by: { login: 'congvc-dev' } },
      ],
      [`repos/${REPO}/pulls/7`]: mergedPull('mallory'),
      ...noRuns,
    })
    expect(await decide({ ...push, ghApi: api })).toMatchObject({ authorized: false })
    expect(calls).toContain(`repos/${REPO}/pulls/7`)
  })

  it('fails closed: a GitHub API error is an error, never "not authorized"', async () => {
    const { api } = fakeApi({})
    await expect(decide({ ...push, ghApi: api })).rejects.toThrow()
  })

  it('refuses a push to any branch but cheese/main', async () => {
    const { api } = fakeApi({ ...pullRoutes('congvc-dev'), ...noRuns })
    await expect(decide({ ...push, ref: 'refs/heads/feature', ghApi: api })).rejects.toThrow(/cheese\/main/)
  })
})

describe('deploy gate: MAIN_RED_PAUSED', () => {
  it('skips the deploy while the variable is set, and runs once it is cleared', async () => {
    const routes = { ...pullRoutes('congvc-dev'), ...noRuns }
    const set = await decide({ ...push, paused: 'main red since 10:00', ghApi: fakeApi(routes).api })
    expect(set.authorized).toBe(false)
    expect(set.reason).toContain('MAIN_RED_PAUSED')
    expect(await decide({ ...push, paused: '', ghApi: fakeApi(routes).api })).toMatchObject({ authorized: true })
  })
})

describe('deploy gate: suspension after a failed deploy (CHE-2365)', () => {
  const auth = pullRoutes('congvc-dev')

  it('suspends when the newest deploy failed, however many stopped runs came since', async () => {
    const { api } = fakeApi({
      ...auth,
      ...history([
        [5, null],
        [4, null],
        [3, 'failure'],
        [2, 'success'],
      ]),
    })
    const out = await decide({ ...push, ghApi: api })
    expect(out.authorized).toBe(false)
    expect(out.reason).toContain('run 3 failed')
  })

  it('a later successful deploy lifts the suspension', async () => {
    const { api } = fakeApi({
      ...auth,
      ...history([
        [4, 'success'],
        [3, 'failure'],
      ]),
    })
    expect(await decide({ ...push, ghApi: api })).toMatchObject({ authorized: true })
  })

  it('skipped and cancelled deploy jobs say nothing', async () => {
    const { api } = fakeApi({
      ...auth,
      ...history([
        [4, 'skipped'],
        [3, 'cancelled'],
        [2, 'success'],
      ]),
    })
    expect(await decide({ ...push, ghApi: api })).toMatchObject({ authorized: true })
  })

  it('a history that ends without any deploy is not suspended', async () => {
    const { api } = fakeApi({
      ...auth,
      ...history([
        [4, null],
        [3, null],
      ]),
    })
    expect(await decide({ ...push, ghApi: api })).toMatchObject({ authorized: true })
  })

  it('does not read its own run', async () => {
    const { api } = fakeApi({
      ...auth,
      ...history([
        [99, 'failure'],
        [2, 'success'],
      ]),
    })
    expect(await decide({ ...push, runId: '99', ghApi: api })).toMatchObject({ authorized: true })
  })

  it('stays suspended when the page cap is hit before any deploy is found', async () => {
    const page = Array.from({ length: 100 }, (_, i) => ({ id: 1000 + i }))
    const { api } = fakeApi({
      ...auth,
      [`repos/${REPO}/actions/workflows/image.yml/runs`]: { workflow_runs: page },
      [`repos/${REPO}/actions/runs/`]: { jobs: [{ name: 'image', conclusion: 'success' }] },
    })
    const out = await decide({ ...push, ghApi: api })
    expect(out.authorized).toBe(false)
    expect(out.reason).toContain('unknown')
  })
})

describe('deploy gate: recheck inside the deploy lock', () => {
  const auth = pullRoutes('congvc-dev')

  it('overlap: run B passes the gate while A deploys, then A fails; B is stopped at the lock', async () => {
    // At gate time A's deploy job has no conclusion yet, so B is authorized.
    const atGate = fakeApi({ ...auth, ...history([[1, 'in_progress']]) })
    expect(await decide({ ...push, runId: '2', ghApi: atGate.api })).toMatchObject({ authorized: true })
    // B gets the lock only after A released it as failed.
    const atLock = fakeApi({ ...history([[1, 'failure']]) })
    const out = await recheck({ event: 'push', repo: REPO, runId: '2', ghApi: atLock.api })
    expect(out.authorized).toBe(false)
    expect(out.reason).toContain('run 1 failed')
  })

  it('lets a push through when no deploy failed', async () => {
    const { api } = fakeApi({ ...history([[1, 'success']]) })
    expect(await recheck({ event: 'push', repo: REPO, runId: '2', ghApi: api })).toMatchObject({ authorized: true })
  })

  // Sol's HIGH (CWE-863): the gate passed for an owner dispatch, the deploy failed, and a writer
  // reran the failed jobs. GitHub reuses the successful gate, so only recheck can refuse.
  const rerun = { event: 'workflow_dispatch', repo: REPO, runId: '2', attempt: 2 }

  it('refuses a failed-job rerun of an owner dispatch started by someone off the allowlist', async () => {
    const { api } = fakeApi({})
    const out = await recheck({ ...rerun, actor: 'congvc-dev', trigger: 'some-writer', ghApi: api })
    expect(out.authorized).toBe(false)
    expect(out.reason).toContain('some-writer')
  })

  it('control: the owner, or an allowlisted login, may rerun a dispatch', async () => {
    const { api } = fakeApi({})
    for (const [trigger, extra] of [
      ['congvc-dev', ''],
      ['agent-merger', 'agent-merger'],
    ]) {
      expect(await recheck({ ...rerun, actor: 'congvc-dev', trigger, extra, ghApi: api })).toMatchObject({
        authorized: true,
      })
    }
  })

  it('judges the first attempt of a dispatch by its actor, and refuses an unknown actor', async () => {
    const { api } = fakeApi({})
    const first = { ...rerun, attempt: 1 }
    expect(await recheck({ ...first, actor: 'congvc-dev', ghApi: api })).toMatchObject({ authorized: true })
    expect((await recheck({ ...first, actor: 'mallory', ghApi: api })).authorized).toBe(false)
    expect((await recheck({ ...first, ghApi: api })).authorized).toBe(false)
  })

  it('decide and recheck share one dispatch rule: they agree for every actor', async () => {
    const { api } = fakeApi({})
    for (const trigger of ['congvc-dev', 'CONGVC-DEV', 'some-writer', '', undefined]) {
      for (const actor of ['congvc-dev', 'mallory', undefined]) {
        const args = { ...push, ...rerun, actor, trigger, ghApi: api }
        const gate = await decide(args).then(
          (o: { authorized: boolean }) => o.authorized,
          () => false,
        )
        expect((await recheck(args)).authorized).toBe(gate)
      }
    }
  })

  it('a dispatch bypasses suspension only when an authorized login started it', async () => {
    const { api } = fakeApi({ ...history([[1, 'failure']]) })
    expect(await recheck({ ...rerun, actor: 'congvc-dev', trigger: 'congvc-dev', ghApi: api })).toMatchObject({
      authorized: true,
    })
    expect((await recheck({ ...rerun, actor: 'congvc-dev', trigger: 'some-writer', ghApi: api })).authorized).toBe(
      false,
    )
  })

  it('rejects any other event', async () => {
    const { api, calls } = fakeApi({})
    for (const event of ['pull_request', 'schedule', 'workflow_run', undefined]) {
      expect(
        (await recheck({ ...rerun, event, actor: 'congvc-dev', trigger: 'congvc-dev', ghApi: api })).authorized,
      ).toBe(false)
    }
    expect(calls).toEqual([])
  })

  it('fails closed on a GitHub error', async () => {
    const { api } = fakeApi({})
    await expect(recheck({ event: 'push', repo: REPO, runId: '2', ghApi: api })).rejects.toThrow()
  })
})

/* A rerun keeps the run id. Its earlier attempts live under /attempts/N/jobs. */
describe('deploy gate: maximum run age enforced in recheck (Sol, f75bfc8 P1)', () => {
  const auth = pullRoutes('congvc-dev')
  const ICT = (iso: string) => new Date(Date.parse(iso)).toISOString()
  // Run A is created 9 Oct 2026 07:00 ICT, is on attempt 2, and is judged 9 Nov 2026 08:00 ICT,
  // after B's lifting success at 07:30 ICT. Run 1 stays in the failure history as a decoy.
  const aCreated = ICT('2026-10-09T00:00:00Z')
  const b = history([[2, 'success', { created_at: '2026-11-08T00:00:00Z', completed_at: '2026-11-09T00:30:00Z' }]])
  const a = { event: 'push', repo: REPO, runId: '1', attempt: '2', trigger: 'congvc-dev', extra: '' }

  it('refuses a push whose run is older than 30 days, whatever the history says', async () => {
    const out = await recheck({ ...a, created: aCreated, ghApi: fakeApi({ ...auth, ...b }).api })
    expect(out.authorized).toBe(false)
    expect(out.reason).toContain('older than 30 days')
  })

  it('refuses a workflow_dispatch from an allowlisted login the same way', async () => {
    const out = await recheck({
      ...a,
      event: 'workflow_dispatch',
      actor: 'congvc-dev',
      created: aCreated,
      ghApi: fakeApi({}).api,
    })
    expect(out.authorized).toBe(false)
    expect(out.reason).toContain('older than 30 days')
  })

  it('refuses an age of exactly 30 days: the bound is a strict maximum', async () => {
    const exact = new Date(NOW - 30 * DAY).toISOString()
    expect((await recheck({ ...a, created: exact, ghApi: fakeApi(b).api })).reason).toContain('older than 30 days')
  })

  it('refuses a run with no creation time (fail closed)', async () => {
    const out = await recheck({ ...a, created: null, ghApi: fakeApi(b).api })
    expect(out.authorized).toBe(false)
    expect(out.reason).toContain('creation time')
  })

  it('control: a run created 29 days before now still passes', async () => {
    const created = new Date(NOW - 29 * DAY).toISOString()
    expect(await recheck({ ...a, created, ghApi: fakeApi(b).api })).toMatchObject({ authorized: true })
    expect(
      await recheck({ ...a, event: 'workflow_dispatch', actor: 'congvc-dev', created, ghApi: fakeApi({}).api }),
    ).toMatchObject({ authorized: true })
  })
})

const attempt = (id: number, n: number, deploy: string, at = done(id, n)) => ({
  [`repos/${REPO}/actions/runs/${id}/attempts/${n}/jobs`]: { jobs: [deployJob(id, deploy, at)] },
})

describe('deploy gate: a rerun is not a recovery (Sol finding 2, CWE-841)', () => {
  const auth = pullRoutes('congvc-dev')
  const rerun = { ...push, runId: '99', attempt: '2', trigger: 'some-writer' }

  it('a writer reruns a failed push run: its own failed attempt 1 suspends, whatever older run succeeded', async () => {
    const { api } = fakeApi({
      ...auth,
      ...attempt(99, 1, 'failure'),
      ...history([
        [99, null],
        [2, 'success'],
      ]),
    })
    const out = await decide({ ...rerun, ghApi: api })
    expect(out.authorized).toBe(false)
    expect(out.reason).toContain('suspended')
  })

  it('an allowlisted rerun initiator is a deliberate recovery', async () => {
    const { api } = fakeApi({
      ...auth,
      ...attempt(99, 1, 'failure'),
      ...history([
        [99, null],
        [2, 'success'],
      ]),
    })
    expect(await decide({ ...rerun, trigger: 'CongVC-Dev', ghApi: api })).toMatchObject({ authorized: true })
  })

  it('a rerun after a skipped or cancelled attempt 1 is not suspended', async () => {
    const { api } = fakeApi({
      ...auth,
      ...attempt(99, 1, 'skipped'),
      ...history([
        [99, null],
        [2, 'success'],
      ]),
    })
    expect(await decide({ ...rerun, ghApi: api })).toMatchObject({ authorized: true })
  })

  it('the lock-time recheck sees the same earlier failure', async () => {
    const { api } = fakeApi({
      ...attempt(99, 1, 'failure'),
      ...history([
        [99, null],
        [2, 'success'],
      ]),
    })
    const out = await recheck({
      event: 'push',
      repo: REPO,
      runId: '99',
      attempt: '2',
      trigger: 'some-writer',
      extra: '',
      ghApi: api,
    })
    expect(out.authorized).toBe(false)
  })

  it('an older run that failed, then was rerun to green by a writer, does not lift the suspension', async () => {
    const { api } = fakeApi({
      ...auth,
      ...attempt(5, 1, 'failure'),
      ...history([[5, 'success', { run_attempt: 2, triggering_actor: { login: 'some-writer' } }]]),
    })
    const out = await decide({ ...push, ghApi: api })
    expect(out.authorized).toBe(false)
    expect(out.reason).toContain('run 5')
  })

  it('the same rerun by an allowlisted login does lift it', async () => {
    const { api } = fakeApi({
      ...auth,
      ...attempt(5, 1, 'failure'),
      ...history([[5, 'success', { run_attempt: 2, triggering_actor: { login: 'congvc-dev' } }]]),
    })
    expect(await decide({ ...push, ghApi: api })).toMatchObject({ authorized: true })
  })

  it('an older run rerun by a writer that is still unfinished stays suspended', async () => {
    const { api } = fakeApi({
      ...auth,
      ...attempt(5, 1, 'failure'),
      ...history([[5, null, { run_attempt: 2, triggering_actor: { login: 'some-writer' } }]]),
    })
    expect((await decide({ ...push, ghApi: api })).authorized).toBe(false)
  })

  it('a rerun of an owner dispatch is judged by whoever reran it, not the original dispatcher', async () => {
    const d = {
      ...push,
      event: 'workflow_dispatch',
      actor: 'congvc-dev',
      trigger: 'some-writer',
      ghApi: fakeApi({}).api,
    }
    await expect(decide(d)).rejects.toThrow(/some-writer/)
    expect(await decide({ ...d, trigger: 'congvc-dev' })).toMatchObject({ authorized: true })
  })
})

describe('deploy gate: workflow_dispatch', () => {
  const dispatch = { ...push, event: 'workflow_dispatch', actor: 'congvc-dev' }

  it('authorizes the owner and an allowlisted actor, without a merge lookup', async () => {
    const { api, calls } = fakeApi({})
    expect(await decide({ ...dispatch, ghApi: api })).toMatchObject({ authorized: true })
    expect(await decide({ ...dispatch, actor: 'agent-merger', extra: 'agent-merger', ghApi: api })).toMatchObject({
      authorized: true,
    })
    expect(calls).toEqual([])
  })

  it('fails (before any C00 step) for any other actor', async () => {
    const { api } = fakeApi({})
    await expect(decide({ ...dispatch, actor: 'mallory', ghApi: api })).rejects.toThrow(/mallory/)
  })

  it('is a deliberate human act: neither the pause nor a suspension stops the owner', async () => {
    const { api } = fakeApi({ ...history([[4, 'failure']]) })
    expect(await decide({ ...dispatch, paused: 'red', ghApi: api })).toMatchObject({ authorized: true })
  })

  it('refuses a dispatch run from any ref but cheese/main', async () => {
    const { api } = fakeApi({})
    await expect(decide({ ...dispatch, ref: 'refs/heads/feature', ghApi: api })).rejects.toThrow(/cheese\/main/)
  })

  it('refuses an event it does not know', async () => {
    const { api } = fakeApi({})
    await expect(decide({ ...push, event: 'pull_request', ghApi: api })).rejects.toThrow(/event/)
  })
})

/* Sol, HIGH (CWE-841): the API lists runs by creation, but deploys finish in their own order. */
describe('deploy gate: history is read in deployment completion order (Sol, CWE-841)', () => {
  const auth = pullRoutes('congvc-dev')
  const at = (hhmm: string) => `2026-11-09T${hhmm}:00Z`
  // A (id 1) is created 01:00 and builds slowly. B (id 2) is created 01:01 and deploys at 01:02.
  // A then holds the lock and fails at 01:03. C (id 3) starts at 01:04.
  const abc = {
    ...auth,
    ...history([
      [3, null],
      [2, 'success', { completed_at: at('01:02') }],
      [1, 'failure', { completed_at: at('01:03') }],
    ]),
  }
  const c = { ...push, runId: '3', attempt: '1', trigger: 'congvc-dev' }
  const lock = (api: (p: string) => Promise<unknown>) =>
    recheck({ event: 'push', repo: REPO, runId: '3', attempt: '1', trigger: 'congvc-dev', extra: '', ghApi: api })

  it('A fails after the newer-created B succeeded: C stays suspended at the gate and under the lock', async () => {
    const gate = await decide({ ...c, ghApi: fakeApi(abc).api })
    expect(gate.authorized).toBe(false)
    expect(gate.reason).toContain('run 1 failed')
    const held = await lock(fakeApi(abc).api)
    expect(held.authorized).toBe(false)
    expect(held.reason).toContain('run 1 failed')
  })

  it('control: A may still deploy after B, because only runs other than the current one count', async () => {
    const { api } = fakeApi(abc)
    const a = { event: 'push', repo: REPO, runId: '1', attempt: '1', trigger: 'congvc-dev', extra: '', ghApi: api }
    expect(await recheck(a)).toMatchObject({ authorized: true })
  })

  it('control: an allowlisted deploy that succeeds after the failure lifts the suspension', async () => {
    const routes = {
      ...auth,
      ...history([
        [4, 'success', { completed_at: at('01:06') }],
        [3, null],
        [2, 'success', { completed_at: at('01:02') }],
        [1, 'failure', { completed_at: at('01:03') }],
      ]),
    }
    expect(await decide({ ...c, runId: '5', ghApi: fakeApi(routes).api })).toMatchObject({ authorized: true })
    expect(await lock(fakeApi(routes).api)).toMatchObject({ authorized: true })
  })

  it('the same list order does not matter: a failure that finished first is lifted by a later success', async () => {
    const routes = {
      ...auth,
      ...history([
        [3, null],
        [2, 'failure', { completed_at: at('01:02') }],
        [1, 'success', { completed_at: at('01:03') }],
      ]),
    }
    expect(await decide({ ...c, ghApi: fakeApi(routes).api })).toMatchObject({ authorized: true })
  })

  it('a failure and a success that finish at the same instant stay suspended', async () => {
    const routes = {
      ...auth,
      ...history([
        [3, null],
        [2, 'success', { completed_at: at('01:02') }],
        [1, 'failure', { completed_at: at('01:02') }],
      ]),
    }
    expect((await decide({ ...c, ghApi: fakeApi(routes).api })).authorized).toBe(false)
  })

  it('a deploy still in progress says nothing yet: the lock decides, and holds the failure that follows', async () => {
    const running = {
      ...auth,
      ...history([
        [3, null],
        [2, 'success', { completed_at: at('01:02') }],
        [1, 'in_progress'],
      ]),
    }
    expect(await decide({ ...c, ghApi: fakeApi(running).api })).toMatchObject({ authorized: true })
    expect((await lock(fakeApi(abc).api)).authorized).toBe(false)
  })

  it('fails closed when a finished deploy has no completion time', async () => {
    const routes = {
      ...auth,
      ...history([
        [3, null],
        [1, 'failure', { completed_at: null }],
      ]),
    }
    await expect(decide({ ...c, ghApi: fakeApi(routes).api })).rejects.toThrow(/completion time/)
  })

  it('orders the attempts of one run too: a failed attempt 2 after a successful attempt 1', async () => {
    const routes = {
      ...auth,
      ...attempt(2, 1, 'success', at('01:01')),
      ...history([
        [3, null],
        [2, 'failure', { run_attempt: 2, triggering_actor: { login: 'congvc-dev' }, completed_at: at('01:05') }],
      ]),
    }
    expect((await decide({ ...c, ghApi: fakeApi(routes).api })).authorized).toBe(false)
  })

  it('an owner rerun that goes green after the failure lifts it; a writer rerun does not', async () => {
    const run5 = (login: string) => ({
      ...auth,
      ...attempt(5, 1, 'failure', at('01:01')),
      ...history([[5, 'success', { run_attempt: 2, triggering_actor: { login }, completed_at: at('01:03') }]]),
    })
    expect(await decide({ ...push, ghApi: fakeApi(run5('congvc-dev')).api })).toMatchObject({ authorized: true })
    expect((await decide({ ...push, ghApi: fakeApi(run5('some-writer')).api })).authorized).toBe(false)
  })

  it('a rerun attempt that is no longer the latest keeps its own initiator: a writer attempt 2 stays unlifting', async () => {
    const routes = {
      ...auth,
      ...attempt(5, 1, 'failure', at('01:01')),
      ...attempt(5, 2, 'success', at('01:03')),
      ...history([
        [5, 'success', { run_attempt: 3, triggering_actor: { login: 'congvc-dev' }, completed_at: at('01:09') }],
      ]),
    }
    // attempt 3 (owner) is a success later than the failure, so it lifts; attempt 2 alone would not.
    expect(await decide({ ...push, ghApi: fakeApi(routes).api })).toMatchObject({ authorized: true })
    const only2 = { ...routes, ...history([[5, 'in_progress', { run_attempt: 3 }]]) }
    expect((await decide({ ...push, ghApi: fakeApi(only2).api })).authorized).toBe(false)
  })

  it('skips runs that stopped changing before the newest lifting success, and reads those that did not', async () => {
    const routes = {
      ...auth,
      ...history([
        [4, 'success', { updated_at: at('01:09'), completed_at: at('01:08') }],
        [3, 'failure', { updated_at: at('01:04'), completed_at: at('01:03') }],
        [2, 'failure', { updated_at: at('01:12'), completed_at: at('01:11') }],
      ]),
    }
    const { api, calls } = fakeApi(routes)
    const out = await decide({ ...push, ghApi: api })
    // run 2 was created earlier but finished at 01:11, after run 4's success at 01:08
    expect(out.authorized).toBe(false)
    expect(out.reason).toContain('run 2 failed')
    expect(calls.some((x) => x.includes('/runs/3/'))).toBe(false)
  })

  it('stays suspended when the page is full and only skipped deploys are in it', async () => {
    const page = Array.from({ length: 100 }, (_, i) => [1000 + i, 'skipped'] as [number, string])
    const out = await decide({ ...push, ghApi: fakeApi({ ...auth, ...history(page) }).api })
    expect(out.authorized).toBe(false)
    expect(out.reason).toContain('unknown')
  })
})

/* Sol, HIGH (CWE-841), run seq 71: the 100-run page ends where the history does not. A run created
   before the page can still finish its deploy after a success on the page. */
describe('deploy gate: history past the 100-run page (Sol, CWE-841)', () => {
  const auth = pullRoutes('congvc-dev')
  const runsPath = `repos/${REPO}/actions/workflows/image.yml/runs`
  const hour = (h: number) => `2026-11-09T${String(h).padStart(2, '0')}:00:00Z`
  // 99 runs with no deploy, created 10:00-ish, plus `top` first. Newest created first.
  const filler = (from: number, created: string) =>
    Array.from(
      { length: 99 },
      (_, i) => [from + i, null, { created_at: created }] as [number, null, Record<string, unknown>],
    )
  const paged = (pages: Record<number, [number, string | null, Record<string, unknown>?][]>) => {
    const all = Object.values(pages).flat()
    const jobs = history(all)
    return {
      ...jobs,
      [runsPath]: (path: string) => {
        const page = Number(/[?&]page=(\d+)/.exec(path)?.[1] ?? 1)
        return {
          workflow_runs: (jobs[runsPath] as { workflow_runs: unknown[] }).workflow_runs.filter((r) =>
            (pages[page] ?? []).some(([id]) => id === (r as { id: number }).id),
          ),
        }
      },
    }
  }
  const c = { ...push, runId: '9000', attempt: '1', trigger: 'congvc-dev' }
  // page 1: B (success 11:30) on top of 99 deploy-less runs. page 2: A, created earlier, fails 11:45.
  const slowA = (aCreated: string) =>
    paged({
      1: [
        [2000, 'success', { created_at: hour(11), updated_at: hour(11), completed_at: '2026-11-09T11:30:00Z' }],
        ...filler(1000, hour(10)),
      ],
      2: [
        [
          1,
          'failure',
          { created_at: aCreated, updated_at: '2026-11-09T11:45:00Z', completed_at: '2026-11-09T11:45:00Z' },
        ],
      ],
    })

  it('reads the next page when the newest success is not yet older than the page, and finds the later failure', async () => {
    const routes = { ...auth, ...slowA(hour(9)) }
    const gate = await decide({ ...c, ghApi: fakeApi(routes).api })
    const lock = await recheck({ ...c, ghApi: fakeApi(routes).api })
    expect(gate.authorized).toBe(false)
    expect(gate.reason).toContain('run 1 failed')
    expect(lock.authorized).toBe(false)
    expect(lock.reason).toContain('run 1 failed')
  })

  const pagesWith = (created: string) => ({
    ...auth,
    ...paged({
      1: [
        [2000, 'success', { created_at: hour(11), updated_at: hour(11), completed_at: '2026-11-09T11:30:00Z' }],
        ...filler(1000, created),
      ],
      2: [[1, 'failure', { created_at: created, completed_at: '2026-11-09T11:45:00Z' }]],
    }),
  })

  // Sol, HIGH, b31573e: a rerun keeps its creation time, so a run two days old can fail after the success.
  it('reads past a page two days older than the newest success: a rerun finishes later than it was created', async () => {
    const out = await decide({ ...c, ghApi: fakeApi(pagesWith('2026-11-07T09:00:00Z')).api })
    expect(out.authorized).toBe(false)
    expect(out.reason).toContain('run 1 failed')
  })

  it('stops paging once a page is older than the 30-day rerun window before the newest success (control)', async () => {
    const { api, calls } = fakeApi(pagesWith('2026-09-01T09:00:00Z'))
    expect((await decide({ ...c, ghApi: api })).authorized).toBe(true)
    expect(calls.some((x) => x.includes('page=2'))).toBe(false)
  })

  it('ends when a page is short: a repository whose history is read in full may deploy', async () => {
    const routes = {
      ...auth,
      ...paged({
        1: filler(1000, hour(10)).concat([[1500, null, { created_at: hour(10) }]]),
        2: [[1, null, { created_at: hour(9) }]],
      }),
    }
    expect((await decide({ ...c, ghApi: fakeApi(routes).api })).authorized).toBe(true)
  })

  it('stays suspended when the page budget runs out before the history is decided', async () => {
    // every page is full of recent runs with no deploy: older history is never reached
    const routes = {
      ...auth,
      [`repos/${REPO}/actions/runs/`]: { jobs: [] },
      [runsPath]: (path: string) => {
        const page = Number(/[?&]page=(\d+)/.exec(path)?.[1] ?? 1)
        return {
          workflow_runs: Array.from({ length: 100 }, (_, i) => ({ id: page * 1000 + i, created_at: hour(10) })),
        }
      },
    }
    const { api, calls } = fakeApi(routes)
    const out = await decide({ ...c, ghApi: api })
    expect(out.authorized).toBe(false)
    expect(out.reason).toContain('unknown')
    expect(calls.filter((x) => x.includes('/image.yml/runs')).length).toBeLessThanOrEqual(10)
  })

  it('keeps paging when a run has no creation time, since it cannot prove older runs are out of reach', async () => {
    const routes = {
      ...auth,
      ...paged({
        1: [
          [2000, 'success', { updated_at: hour(11), completed_at: '2026-11-09T11:30:00Z' }],
          ...filler(1000, hour(10)).map(([id, c]) => [id, c, {}] as [number, null, Record<string, unknown>]),
        ],
        2: [[1, 'failure', { updated_at: '2026-11-09T11:45:00Z', completed_at: '2026-11-09T11:45:00Z' }]],
      }),
    }
    const out = await decide({ ...c, ghApi: fakeApi(routes).api })
    expect(out.authorized).toBe(false)
    expect(out.reason).toContain('run 1 failed')
  })
})
