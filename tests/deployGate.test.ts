import { describe, expect, it } from 'vitest'
// @ts-expect-error plain .mjs script, no type declarations
import { decide, recheck } from '../scripts/deploy-gate.mjs'

type Api = (path: string) => Promise<unknown>
const SHA = 'c'.repeat(40)
const REPO = 'cheese-work/doop'

/* Fake GitHub: answers by path, records every read so a test can prove a path
   was never taken. An unknown path is an error, like a failed `gh api`. */
function fakeApi(routes: Record<string, unknown>) {
  const calls: string[] = []
  const api: Api = async (path) => {
    calls.push(path)
    for (const [prefix, value] of Object.entries(routes)) {
      if (path.startsWith(prefix)) return typeof value === 'function' ? value(path) : value
    }
    throw new Error(`unexpected read ${path}`)
  }
  return { api, calls }
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

/* history: newest first, each [runId, deploy job conclusion | null for "no deploy job ran"] */
function history(entries: [number, string | null, Record<string, unknown>?][]) {
  return {
    [`repos/${REPO}/actions/workflows/image.yml/runs`]: {
      workflow_runs: entries.map(([id, , extra]) => ({ id, ...extra })),
    },
    ...Object.fromEntries(
      entries.map(([id, c]) => [
        `repos/${REPO}/actions/runs/${id}/jobs`,
        { jobs: [{ name: 'image', conclusion: 'success' }, ...(c ? [{ name: 'deploy', conclusion: c }] : [])] },
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

  it('never reads history for a dispatch: that is a deliberate human act', async () => {
    const { api, calls } = fakeApi({})
    expect(await recheck({ event: 'workflow_dispatch', repo: REPO, runId: '2', ghApi: api })).toMatchObject({
      authorized: true,
    })
    expect(calls).toEqual([])
  })

  it('fails closed on a GitHub error', async () => {
    const { api } = fakeApi({})
    await expect(recheck({ event: 'push', repo: REPO, runId: '2', ghApi: api })).rejects.toThrow()
  })
})

/* A rerun keeps the run id. Its earlier attempts live under /attempts/N/jobs. */
const attempt = (id: number, n: number, deploy: string) => ({
  [`repos/${REPO}/actions/runs/${id}/attempts/${n}/jobs`]: { jobs: [{ name: 'deploy', conclusion: deploy }] },
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
