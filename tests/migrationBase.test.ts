import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error plain .mjs script, no type declarations
import { selectBase } from '../scripts/ci/migration-base.mjs'
import {
  formatBaseMarker,
  formatReplayMarker,
  parseBaseMarkers,
  parseReplayMarkers,
  // @ts-expect-error plain .mjs script, no type declarations
} from '../scripts/ci/migration-marker.mjs'

/* CHE-7207 S2a: migration base selection per caller event, the marker, and the replay-marker format. */

const sha = (c: string) => c.repeat(40)
const HEAD = sha('c')
const PARENT1 = sha('a')
const PARENT2 = sha('b')
const ZERO = '0'.repeat(40)

type Call = string[]
function fakeGit(opts: {
  head?: string
  parents?: Record<number, string | null>
  fetchFails?: boolean
  hasCommit?: boolean
}) {
  const calls: Call[] = []
  const git = {
    head: async () => opts.head ?? HEAD,
    fetch: async (args: string[]) => {
      calls.push(args)
      if (opts.fetchFails) throw new Error('fatal: could not read from remote repository')
    },
    parent: async (_rev: string, n: number) => (opts.parents ?? {})[n] ?? null,
    hasCommit: async () => opts.hasCommit ?? true,
  }
  return { git, calls }
}

describe('selectBase: pull_request', () => {
  const payload = (prHead: string) => ({ pull_request: { head: { sha: prHead }, base: { sha: sha('d') } } })

  it('takes HEAD^1 of the merge ref, fetches depth 2, binds merged_head to pr_head', async () => {
    const { git, calls } = fakeGit({ parents: { 1: PARENT1, 2: PARENT2 } })
    const r = await selectBase({
      event: 'pull_request',
      candidate: HEAD,
      payload: payload(PARENT2),
      runAttempt: '1',
      git,
    })
    expect(r.ok).toBe(true)
    expect(r.base).toBe(PARENT1)
    expect(calls).toEqual([['--no-tags', '--depth=2', 'origin', HEAD]])
    expect(r.marker).toBe(
      `migration-base event=pull_request candidate=${HEAD} base=${PARENT1} merged_head=${PARENT2} pr_head=${PARENT2} run_attempt=1`,
    )
    expect(r.env).toEqual({
      MIGRATION_BASE_SHA: PARENT1,
      MIGRATION_CANDIDATE: HEAD,
      MIGRATION_PR_HEAD: PARENT2,
      MIGRATION_RUN_ATTEMPT: '1',
    })
    expect(r.notes.join('\n')).toContain(`pull_request.base.sha=${sha('d')}`)
  })

  it('fails closed when merged_head differs from pr_head', async () => {
    const { git } = fakeGit({ parents: { 1: PARENT1, 2: PARENT2 } })
    const r = await selectBase({
      event: 'pull_request',
      candidate: HEAD,
      payload: payload(sha('e')),
      runAttempt: '1',
      git,
    })
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/merged_head .* pr_head/)
  })

  it('fails closed when the merge ref has no second parent', async () => {
    const { git } = fakeGit({ parents: { 1: PARENT1 } })
    const r = await selectBase({
      event: 'pull_request',
      candidate: HEAD,
      payload: payload(PARENT2),
      runAttempt: '1',
      git,
    })
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/merged_head/)
  })

  it('fails closed when the payload has no pr head', async () => {
    const { git } = fakeGit({ parents: { 1: PARENT1, 2: PARENT2 } })
    const r = await selectBase({ event: 'pull_request', candidate: HEAD, payload: {}, runAttempt: '1', git })
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/pr_head/)
  })
})

describe('selectBase: push', () => {
  it('takes github.event.before and fetches it at depth 1', async () => {
    const { git, calls } = fakeGit({})
    const r = await selectBase({ event: 'push', candidate: HEAD, payload: { before: PARENT1 }, runAttempt: '2', git })
    expect(r.ok).toBe(true)
    expect(r.base).toBe(PARENT1)
    expect(calls).toEqual([['--no-tags', '--depth=1', 'origin', PARENT1]])
    expect(r.marker).toBe(
      `migration-base event=push candidate=${HEAD} base=${PARENT1} merged_head=- pr_head=- run_attempt=2`,
    )
    expect(r.env.MIGRATION_PR_HEAD).toBe('-')
  })

  it.each([
    ['all-zero', ZERO],
    ['empty', ''],
    ['missing', undefined],
    ['not a sha', 'main'],
  ])('fails closed on an %s before', async (_n, before) => {
    const { git, calls } = fakeGit({})
    const r = await selectBase({ event: 'push', candidate: HEAD, payload: { before }, runAttempt: '1', git })
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/before/)
    expect(calls).toEqual([])
  })
})

describe('selectBase: workflow_dispatch', () => {
  it('takes HEAD^1 and fetches depth 2', async () => {
    const { git, calls } = fakeGit({ parents: { 1: PARENT1 } })
    const r = await selectBase({ event: 'workflow_dispatch', candidate: HEAD, payload: {}, runAttempt: '1', git })
    expect(r.ok).toBe(true)
    expect(r.base).toBe(PARENT1)
    expect(calls).toEqual([['--no-tags', '--depth=2', 'origin', HEAD]])
    expect(r.marker).toContain('event=workflow_dispatch')
  })

  it('fails closed on a root commit (no first parent)', async () => {
    const { git } = fakeGit({ parents: {} })
    const r = await selectBase({ event: 'workflow_dispatch', candidate: HEAD, payload: {}, runAttempt: '1', git })
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/first parent/)
  })
})

describe('selectBase: fail closed', () => {
  it('rejects an unknown event without fetching', async () => {
    const { git, calls } = fakeGit({ parents: { 1: PARENT1 } })
    const r = await selectBase({ event: 'schedule', candidate: HEAD, payload: {}, runAttempt: '1', git })
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/schedule/)
    expect(calls).toEqual([])
  })

  it.each([
    ['pull_request', { pull_request: { head: { sha: PARENT2 } } }],
    ['push', { before: PARENT1 }],
    ['workflow_dispatch', {}],
  ])('fails closed when the %s fetch fails', async (event, payload) => {
    const { git } = fakeGit({ parents: { 1: PARENT1, 2: PARENT2 }, fetchFails: true })
    const r = await selectBase({ event, candidate: HEAD, payload, runAttempt: '1', git })
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/fetch/)
  })

  it('fails closed when the base equals HEAD', async () => {
    const { git } = fakeGit({ parents: { 1: HEAD } })
    const r = await selectBase({ event: 'workflow_dispatch', candidate: HEAD, payload: {}, runAttempt: '1', git })
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/equals HEAD/)
  })

  it('fails closed when the push base cannot be resolved after the fetch', async () => {
    const { git } = fakeGit({ hasCommit: false })
    const r = await selectBase({ event: 'push', candidate: HEAD, payload: { before: PARENT1 }, runAttempt: '1', git })
    expect(r.ok).toBe(false)
  })

  it('fails closed when the checked-out HEAD is not the candidate', async () => {
    const { git } = fakeGit({ head: sha('f'), parents: { 1: PARENT1 } })
    const r = await selectBase({ event: 'workflow_dispatch', candidate: HEAD, payload: {}, runAttempt: '1', git })
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/candidate/)
  })

  it('fails closed on a missing run attempt', async () => {
    const { git } = fakeGit({ parents: { 1: PARENT1 } })
    const r = await selectBase({ event: 'workflow_dispatch', candidate: HEAD, payload: {}, runAttempt: '', git })
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/run_attempt/)
  })
})

describe('markers', () => {
  const fields = {
    event: 'pull_request',
    candidate: HEAD,
    base: PARENT1,
    mergedHead: PARENT2,
    prHead: PARENT2,
    runAttempt: '3',
  }

  it('round-trips the base marker, also inside a timestamped log line', () => {
    const line = formatBaseMarker(fields)
    expect(line).toBe(
      `migration-base event=pull_request candidate=${HEAD} base=${PARENT1} merged_head=${PARENT2} pr_head=${PARENT2} run_attempt=3`,
    )
    const log = `2026-11-18T14:00:00.1234567Z ${line}\n2026-11-18T14:00:01.0000000Z other line\n`
    expect(parseBaseMarkers(log)).toEqual([fields])
  })

  it('does not parse a FAIL line or a truncated marker as a base marker', () => {
    expect(parseBaseMarkers('migration-base FAIL base equals HEAD\nmigration-base event=push candidate=abc')).toEqual(
      [],
    )
  })

  it('round-trips the replay marker', () => {
    const r = { candidate: HEAD, base: PARENT1, prHead: PARENT2, runAttempt: '3' }
    const line = formatReplayMarker(r)
    expect(line).toBe(`migration-replay OK candidate=${HEAD} base=${PARENT1} pr_head=${PARENT2} run_attempt=3`)
    expect(parseReplayMarkers(`2026-11-18T14:00:00Z ${line}\n`)).toEqual([r])
    expect(parseReplayMarkers('migration-replay FAIL candidate=x')).toEqual([])
  })

  it('parses a replay marker from a push run, whose pr_head is `-`', () => {
    const r = { candidate: HEAD, base: PARENT1, prHead: '-', runAttempt: '1' }
    expect(parseReplayMarkers(`2026-11-18T14:00:00Z ${formatReplayMarker(r)}\n`)).toEqual([r])
  })
})

describe('CLI (real git)', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })
  const git = (cwd: string, ...a: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, encoding: 'utf8' }).trim()

  it('writes the env file and prints the marker for a pull_request merge ref', { timeout: 60_000 }, () => {
    const root = mkdtempSync(path.join(tmpdir(), 'mig-base-'))
    dirs.push(root)
    const origin = path.join(root, 'origin')
    execFileSync('git', ['init', '-q', '-b', 'main', origin])
    writeFileSync(path.join(origin, 'a'), '1')
    git(origin, 'add', '.')
    git(origin, 'commit', '-qm', 'base')
    const base = git(origin, 'rev-parse', 'HEAD')
    git(origin, 'checkout', '-qb', 'feature')
    writeFileSync(path.join(origin, 'b'), '2')
    git(origin, 'add', '.')
    git(origin, 'commit', '-qm', 'feature')
    const prHead = git(origin, 'rev-parse', 'HEAD')
    git(origin, 'checkout', '-q', 'main')
    git(origin, 'merge', '--no-ff', '-qm', 'merge ref', 'feature')
    const merge = git(origin, 'rev-parse', 'HEAD')
    const work = path.join(root, 'work')
    execFileSync('git', ['clone', '-q', '--depth=1', `file://${origin}`, work])
    const eventPath = path.join(root, 'event.json')
    writeFileSync(eventPath, JSON.stringify({ pull_request: { head: { sha: prHead }, base: { sha: base } } }))
    const envFile = path.join(root, 'env')
    writeFileSync(envFile, '')
    const script = path.resolve('scripts/ci/migration-base.mjs')
    const out = execFileSync('node', [script], {
      cwd: work,
      encoding: 'utf8',
      env: {
        ...process.env,
        GITHUB_EVENT_NAME: 'pull_request',
        GITHUB_SHA: merge,
        GITHUB_RUN_ATTEMPT: '1',
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_ENV: envFile,
      },
    })
    expect(out).toContain(
      `migration-base event=pull_request candidate=${merge} base=${base} merged_head=${prHead} pr_head=${prHead} run_attempt=1`,
    )
    const env = readFileSync(envFile, 'utf8')
    expect(env).toContain(`MIGRATION_BASE_SHA=${base}`)
    expect(env).toContain(`MIGRATION_PR_HEAD=${prHead}`)
  })

  it('exits non-zero and writes no env on an unknown event', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'mig-base-'))
    dirs.push(root)
    const envFile = path.join(root, 'env')
    writeFileSync(envFile, '')
    const script = path.resolve('scripts/ci/migration-base.mjs')
    let status = 0
    let stdout = ''
    try {
      execFileSync('node', [script], {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          GITHUB_EVENT_NAME: 'schedule',
          GITHUB_SHA: HEAD,
          GITHUB_RUN_ATTEMPT: '1',
          GITHUB_ENV: envFile,
        },
      })
    } catch (e) {
      const err = e as { status: number; stdout: string }
      status = err.status
      stdout = err.stdout
    }
    expect(status).toBe(1)
    expect(stdout).toMatch(/^migration-base FAIL /m)
    expect(readFileSync(envFile, 'utf8')).toBe('')
  })
})
