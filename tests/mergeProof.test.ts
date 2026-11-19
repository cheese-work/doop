import { describe, expect, it } from 'vitest'
// @ts-expect-error plain .mjs script, no type declarations
import { mergeProof } from '../scripts/ci/merge-proof.mjs'

/* CHE-7207 S2a: merge proof rules 1 to 6. Fixtures are recorded job lists and log excerpts. */

const sha = (c: string) => c.repeat(40)
const T = sha('1') // cheese/main tip
const H = sha('2') // PR head
const C = sha('3') // candidate (merge commit)
const OLD = sha('9') // an older tip
const RUN = 4242
const LINT_ID = 11
const SHARD_IDS = [21, 22, 23, 24] as const
const TESTS_ID = 31

const baseLine = (
  o: { base?: string; candidate?: string; prHead?: string; mergedHead?: string; attempt?: number } = {},
) =>
  `2026-11-18T14:00:00.0000000Z migration-base event=pull_request candidate=${o.candidate ?? C} base=${o.base ?? T} merged_head=${o.mergedHead ?? H} pr_head=${o.prHead ?? H} run_attempt=${o.attempt ?? 1}`
const replayLine = (o: { base?: string; candidate?: string; prHead?: string; attempt?: number } = {}) =>
  `2026-11-18T14:05:00.0000000Z migration-replay OK candidate=${o.candidate ?? C} base=${o.base ?? T} pr_head=${o.prHead ?? H} run_attempt=${o.attempt ?? 1}`
const LEDGER = '2026-11-18T14:00:02.0000000Z migration-ledger-check OK base=' + T + ' head=' + H

type Job = { id: number; name: string; conclusion: string; run_attempt: number }
type Scenario = {
  tip?: string
  head?: string
  runs?: unknown[]
  jobs?: Job[]
  logs?: Record<number, string>
  attempt?: number
}

/** A green single-attempt scenario; each case overrides one thing. */
function scenario(over: Scenario = {}) {
  const attempt = over.attempt ?? 1
  const jobs: Job[] = over.jobs ?? [
    { id: LINT_ID, name: 'lint', conclusion: 'success', run_attempt: attempt },
    ...SHARD_IDS.map((id, i) => ({ id, name: `test (${i + 1})`, conclusion: 'success', run_attempt: attempt })),
    { id: TESTS_ID, name: 'tests', conclusion: 'success', run_attempt: attempt },
  ]
  const logs: Record<number, string> = over.logs ?? {
    [LINT_ID]: [baseLine({ attempt }), LEDGER].join('\n'),
    [SHARD_IDS[0]]: 'noise\n',
    [SHARD_IDS[1]]: [baseLine({ attempt }), replayLine({ attempt })].join('\n'),
    [SHARD_IDS[2]]: 'noise\n',
    [SHARD_IDS[3]]: 'noise\n',
    [TESTS_ID]: '',
  }
  const requested: string[] = []
  const api = {
    branchTip: async () => over.tip ?? T,
    prHead: async () => over.head ?? H,
    runs: async (head: string) => {
      requested.push(`runs:${head}`)
      return {
        workflow_runs: over.runs ?? [
          {
            id: RUN,
            path: '.github/workflows/ci.yml',
            event: 'pull_request',
            head_sha: H,
            run_attempt: attempt,
            created_at: '2026-11-18T13:50:00Z',
          },
        ],
      }
    },
    jobs: async (runId: number, a: number) => {
      requested.push(`jobs:${runId}:${a}`)
      return { jobs }
    },
    log: async (jobId: number) => {
      requested.push(`log:${jobId}`)
      return logs[jobId] ?? ''
    },
  }
  return { api, requested, logs, jobs }
}

const run = (s: ReturnType<typeof scenario>) => mergeProof({ pr: 70, api: s.api })

describe('merge-proof PASS', () => {
  it('passes a reopened candidate over the new tip: all evidence from one attempt, unchanged head', async () => {
    // reopen = a new run (id RUN, attempt 1) with the old run (attempt 3) older in the list
    const s = scenario({
      runs: [
        {
          id: 1000,
          path: '.github/workflows/ci.yml',
          event: 'pull_request',
          head_sha: H,
          run_attempt: 3,
          created_at: '2026-11-18T10:00:00Z',
        },
        {
          id: RUN,
          path: '.github/workflows/ci.yml',
          event: 'pull_request',
          head_sha: H,
          run_attempt: 1,
          created_at: '2026-11-18T13:50:00Z',
        },
      ],
    })
    const r = await run(s)
    expect(r).toEqual({ ok: true, line: 'merge-proof PASS' })
    expect(s.requested).toContain(`runs:${H}`)
    expect(s.requested).toContain(`jobs:${RUN}:1`)
  })

  it('passes a full re-run on an unchanged tip (attempt 2, base = tip)', async () => {
    const r = await run(scenario({ attempt: 2 }))
    expect(r.line).toBe('merge-proof PASS')
  })

  it('ignores runs of other workflows and other heads', async () => {
    const s = scenario({
      runs: [
        {
          id: 7,
          path: '.github/workflows/cla.yml',
          event: 'pull_request',
          head_sha: H,
          run_attempt: 1,
          created_at: '2026-11-18T13:59:00Z',
        },
        {
          id: 8,
          path: '.github/workflows/ci.yml',
          event: 'pull_request',
          head_sha: sha('8'),
          run_attempt: 1,
          created_at: '2026-11-18T13:59:30Z',
        },
        {
          id: RUN,
          path: '.github/workflows/ci.yml',
          event: 'pull_request',
          head_sha: H,
          run_attempt: 1,
          created_at: '2026-11-18T13:50:00Z',
        },
      ],
    })
    expect((await run(s)).line).toBe('merge-proof PASS')
    expect(s.requested).toContain(`jobs:${RUN}:1`)
  })
})

describe('merge-proof FAIL', () => {
  const fail = (r: { ok: boolean; line: string }, reason: RegExp) => {
    expect(r.ok).toBe(false)
    expect(r.line).toMatch(/^merge-proof FAIL /)
    expect(r.line).toMatch(reason)
  }

  it('a stale retry: attempt 2 with the old base after the tip moved', async () => {
    const s = scenario({
      attempt: 2,
      logs: {
        [LINT_ID]: [baseLine({ base: OLD, attempt: 2 }), LEDGER].join('\n'),
        [SHARD_IDS[1]]: [baseLine({ base: OLD, attempt: 2 }), replayLine({ base: OLD, attempt: 2 })].join('\n'),
      },
    })
    fail(await run(s), /^merge-proof FAIL stale base/)
  })

  it('a marker whose pr_head is not the current head', async () => {
    const stale = sha('7')
    const s = scenario({
      logs: {
        [LINT_ID]: [baseLine({ prHead: stale, mergedHead: stale }), LEDGER].join('\n'),
        [SHARD_IDS[1]]: [baseLine({ prHead: stale, mergedHead: stale }), replayLine({ prHead: stale })].join('\n'),
      },
    })
    fail(await run(s), /^merge-proof FAIL mismatched value.*pr_head/)
  })

  it('no test (N) log has migration-replay OK', async () => {
    const s = scenario({ logs: { [LINT_ID]: [baseLine(), LEDGER].join('\n'), [SHARD_IDS[1]]: baseLine() } })
    fail(await run(s), /^merge-proof FAIL missing marker.*replay/)
  })

  it('2 test (N) logs have migration-replay OK', async () => {
    const both = [baseLine(), replayLine()].join('\n')
    const s = scenario({
      logs: { [LINT_ID]: [baseLine(), LEDGER].join('\n'), [SHARD_IDS[1]]: both, [SHARD_IDS[2]]: both },
    })
    fail(await run(s), /^merge-proof FAIL 2 replay markers/)
  })

  it('the replay marker candidate differs from the lint marker', async () => {
    const s = scenario({
      logs: {
        [LINT_ID]: [baseLine(), LEDGER].join('\n'),
        [SHARD_IDS[1]]: [baseLine(), replayLine({ candidate: sha('4') })].join('\n'),
      },
    })
    fail(await run(s), /^merge-proof FAIL mismatched value.*candidate/)
  })

  it('the replay marker base differs from the lint marker', async () => {
    const s = scenario({
      logs: {
        [LINT_ID]: [baseLine(), LEDGER].join('\n'),
        [SHARD_IDS[1]]: [baseLine(), replayLine({ base: OLD })].join('\n'),
      },
    })
    fail(await run(s), /^merge-proof FAIL mismatched value.*base/)
  })

  it('a partial rerun: lint from attempt 1, the replay shard from attempt 2', async () => {
    const jobs: Job[] = [
      { id: LINT_ID, name: 'lint', conclusion: 'success', run_attempt: 1 },
      { id: SHARD_IDS[0], name: 'test (1)', conclusion: 'success', run_attempt: 2 },
      { id: SHARD_IDS[1], name: 'test (2)', conclusion: 'success', run_attempt: 2 },
      { id: TESTS_ID, name: 'tests', conclusion: 'success', run_attempt: 2 },
    ]
    const s = scenario({
      attempt: 2,
      jobs,
      logs: {
        [LINT_ID]: [baseLine({ attempt: 1 }), LEDGER].join('\n'),
        [SHARD_IDS[1]]: [baseLine({ attempt: 2 }), replayLine({ attempt: 2 })].join('\n'),
      },
    })
    fail(await run(s), /^merge-proof FAIL partial rerun/)
  })

  it('a partial rerun is caught from the marker run_attempt even when the job list hides it', async () => {
    const s = scenario({
      attempt: 2,
      logs: {
        [LINT_ID]: [baseLine({ attempt: 1 }), LEDGER].join('\n'),
        [SHARD_IDS[1]]: [baseLine({ attempt: 2 }), replayLine({ attempt: 2 })].join('\n'),
      },
    })
    fail(await run(s), /^merge-proof FAIL partial rerun/)
  })

  it('the tests aggregate is not success', async () => {
    const s = scenario()
    s.jobs.find((j) => j.name === 'tests')!.conclusion = 'failure'
    fail(await run(s), /^merge-proof FAIL job not success.*tests/)
  })

  it('the replay shard is not success', async () => {
    const s = scenario()
    s.jobs.find((j) => j.name === 'test (2)')!.conclusion = 'cancelled'
    fail(await run(s), /^merge-proof FAIL job not success.*test \(2\)/)
  })

  it('lint is not success', async () => {
    const s = scenario()
    s.jobs.find((j) => j.name === 'lint')!.conclusion = 'failure'
    fail(await run(s), /^merge-proof FAIL job not success.*lint/)
  })

  it('the lint log has no migration-base marker', async () => {
    const s = scenario({
      logs: { [LINT_ID]: LEDGER, [SHARD_IDS[1]]: [baseLine(), replayLine()].join('\n') },
    })
    fail(await run(s), /^merge-proof FAIL missing marker.*lint/)
  })

  it('the lint log has no migration-ledger-check OK', async () => {
    const s = scenario({
      logs: { [LINT_ID]: baseLine(), [SHARD_IDS[1]]: [baseLine(), replayLine()].join('\n') },
    })
    fail(await run(s), /^merge-proof FAIL missing marker.*ledger/)
  })

  it('the replay shard has no migration-base marker', async () => {
    const s = scenario({ logs: { [LINT_ID]: [baseLine(), LEDGER].join('\n'), [SHARD_IDS[1]]: replayLine() } })
    fail(await run(s), /^merge-proof FAIL missing marker.*replay shard/)
  })

  it('merged_head differs from the PR head', async () => {
    const s = scenario({
      logs: {
        [LINT_ID]: [baseLine({ mergedHead: sha('5') }), LEDGER].join('\n'),
        [SHARD_IDS[1]]: [baseLine(), replayLine()].join('\n'),
      },
    })
    fail(await run(s), /^merge-proof FAIL mismatched value.*merged_head/)
  })

  it('there is no ci.yml pull_request run for the head', async () => {
    const s = scenario({ runs: [] })
    fail(await run(s), /^merge-proof FAIL missing marker.*no ci run/)
  })

  it('there is no lint job in the attempt', async () => {
    const s = scenario()
    s.jobs.splice(0, 1)
    fail(await run(s), /^merge-proof FAIL missing marker.*lint/)
  })

  it('fails closed when GitHub cannot be read', async () => {
    const s = scenario()
    s.api.log = async () => {
      throw new Error('HTTP 404')
    }
    fail(await run(s), /^merge-proof FAIL evidence unreadable.*HTTP 404/)
  })
})
