import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/* CHE-5543 (train S1, plan CHE-5474 C-1): files that must live on the default
   branch once cheese/main replaces main. */
const read = (p: string) => readFileSync(resolve(p), 'utf8')

describe('merge-queue-watch continuity (C-1.6)', () => {
  for (const f of [
    '.github/workflows/merge-queue-watch.yml',
    'scripts/merge-queue-watch.py',
    'scripts/merge-queue-watch.test.py',
    'scripts/fixtures/merge-queue-watch/healthy.json',
  ]) {
    it(`${f} exists`, () => expect(existsSync(resolve(f))).toBe(true))
  }
  it('keeps the queue on main and the schedule', () => {
    const w = read('.github/workflows/merge-queue-watch.yml')
    expect(w).toMatch(/^\s+MERGE_QUEUE_BRANCH: main$/m)
    expect(w).toContain("cron: '3,18,33,48 * * * *'")
  })
})

describe('mirror workflow (C-1.3)', () => {
  const w = () => read('.github/workflows/mirror-upstream-main.yml')
  it('has cron, dispatch, environment and non-cancelling concurrency', () => {
    expect(w()).toContain("cron: '17 */6 * * *'")
    expect(w()).toContain('workflow_dispatch:')
    expect(w()).toMatch(/environment: ci-app-token/)
    expect(w()).toMatch(/group: mirror-upstream-main\n\s+cancel-in-progress: false/)
  })
  it('mirrors the upstream fork parent, never deploys', () => {
    expect(w()).toContain('UPSTREAM_URL: https://github.com/kgoedecke/doop.git')
    expect(w()).not.toMatch(/docker|cheese-c00-deploy/)
  })
})

// real git subprocesses; generous timeout for a loaded runner
describe('scripts/mirror-upstream-main.sh', { timeout: 120_000 }, () => {
  let dir: string
  const git = (cwd: string, ...a: string[]) => {
    const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, encoding: 'utf8' })
    if (r.status !== 0) throw new Error(r.stderr)
    return r.stdout.trim()
  }
  const commit = (repo: string, msg: string) => git(repo, 'commit', '-q', '--allow-empty', '-m', msg)
  const run = () =>
    spawnSync('bash', [resolve('scripts/mirror-upstream-main.sh')], {
      encoding: 'utf8',
      env: { ...process.env, UPSTREAM_URL: join(dir, 'up'), TARGET_URL: join(dir, 'target.git') },
    })
  const mirror = () => git(join(dir, 'target.git'), 'rev-parse', 'refs/heads/upstream-main')

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mirror-'))
    git(dir, 'init', '-q', '--bare', 'target.git')
    git(dir, 'init', '-q', '-b', 'main', 'up')
    commit(join(dir, 'up'), 'one')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('creates the mirror, then fast-forwards it', () => {
    expect(run().status).toBe(0)
    expect(mirror()).toBe(git(join(dir, 'up'), 'rev-parse', 'main'))
    commit(join(dir, 'up'), 'two')
    expect(run().status).toBe(0)
    expect(mirror()).toBe(git(join(dir, 'up'), 'rev-parse', 'main'))
  })
  it('is a no-op when equal', () => {
    run()
    expect(run().stdout).toContain('up to date')
  })
  it('refuses a rewritten upstream history and leaves the mirror alone', () => {
    run()
    const before = mirror()
    git(join(dir, 'up'), 'reset', '-q', '--hard', 'HEAD')
    git(join(dir, 'up'), 'commit', '-q', '--amend', '--allow-empty', '-m', 'rewritten')
    const r = run()
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('not a fast-forward')
    expect(mirror()).toBe(before)
  })
})
