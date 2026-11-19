import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
  it('refuses to advance a mirror seeded from a diverged fork main (why init must not use main)', () => {
    // fork main and upstream main share a base, then each gets its own commits
    const up = join(dir, 'up')
    git(up, 'branch', 'fork-main')
    commit(up, 'upstream only')
    git(up, 'checkout', '-q', 'fork-main')
    commit(up, 'fork only')
    git(up, 'checkout', '-q', 'main')
    git(up, 'push', '-q', join(dir, 'target.git'), 'fork-main:refs/heads/upstream-main')
    const before = mirror()
    const r = run()
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('not a fast-forward')
    expect(mirror()).toBe(before)
  })
  it('fast-forwards a mirror seeded at the upstream tip', () => {
    const up = join(dir, 'up')
    git(up, 'push', '-q', join(dir, 'target.git'), 'main:refs/heads/upstream-main')
    commit(up, 'next')
    expect(run().status).toBe(0)
    expect(mirror()).toBe(git(up, 'rev-parse', 'main'))
  })
})

describe('scripts/doop-s1-admin.sh initial mirror (C-1.3)', () => {
  const a = () => read('scripts/doop-s1-admin.sh')
  it('seeds upstream-main from the upstream tip, never from fork main', () => {
    expect(a()).toContain('UP=kgoedecke/doop')
    expect(a()).toContain('"repos/$UP/git/ref/heads/main"')
    expect(a()).not.toContain('"repos/$R/git/ref/heads/main"')
  })
})

// Behavioral: run the admin script against a fake `gh` that logs every call.
describe('scripts/doop-s1-admin.sh upstream-main seeding gate (C-1.3)', () => {
  let dir: string
  const MUTATION = /rulesets|environments|default_branch|PATCH|PUT/
  // id 1 = organization ruleset `protect main` (not editable on the repo endpoint); id 2 = repo ruleset
  const ORG_PLUS_REPO = JSON.stringify([
    { id: 1, name: 'protect main', source_type: 'Organization' },
    { id: 2, name: 'protect default branches', source_type: 'Repository' },
  ])
  // FAKE_RULESETS mimics the repo ruleset list, which includes organization rulesets (source_type).
  // PUT to an organization ruleset id on the repo endpoint returns 404, as on GitHub (CHE-5543 v4).
  const fakeGh = `#!/usr/bin/env bash
echo "$*" >> "$FAKE_LOG"
jqx=""; prev=""
for a in "$@"; do [ "$prev" = --jq ] && jqx="$a"; prev="$a"; done
out() { if [ -n "$jqx" ]; then jq -r "$jqx" 2>/dev/null || true; else cat; fi; }
case "$*" in *--input*) cat >> "$FAKE_LOG.in" ;; esac
case "$*" in
  *"git/ref/heads/upstream-main"*) [ "$FAKE_EXISTS" = 1 ] && { echo sha-mirror; exit 0; } || exit 1 ;;
  *"kgoedecke/doop/git/ref/heads/main"*) echo sha-up; exit 0 ;;
  *"git/refs"*) [ "$FAKE_CREATE" = ok ] && exit 0 || exit 1 ;;
  *"/compare/"*) echo "$FAKE_COMPARE"; exit 0 ;;
  *"-X PUT"*"rulesets/1 "*) echo '{"message":"Not Found","status":"404"}' >&2; echo "gh: Not Found (HTTP 404)" >&2; exit 1 ;;
  *"rulesets/1") echo '{"name":"protect main","target":"branch","enforcement":"active","rules":[{"type":"deletion"},{"type":"pull_request"}],"conditions":{"ref_name":{"include":["~DEFAULT_BRANCH"],"exclude":[]}}}'; exit 0 ;;
  *"rulesets/"[0-9]*) echo '{"name":"n","target":"branch","enforcement":"active","rules":[],"conditions":{"ref_name":{"include":[],"exclude":[]}}}' | out; exit 0 ;;
  *"/rulesets"*) echo "\${FAKE_RULESETS:-$DEFAULT_RULESETS}" | out; exit 0 ;;
esac
exit 0
`
  const sh = (cmd: string, env: Record<string, string>) => {
    const r = spawnSync('bash', [resolve('scripts/doop-s1-admin.sh'), cmd], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        FAKE_LOG: join(dir, 'log'),
        DEFAULT_RULESETS: ORG_PLUS_REPO,
        ...env,
      },
    })
    const log = existsSync(join(dir, 'log')) ? readFileSync(join(dir, 'log'), 'utf8') : ''
    const body = existsSync(join(dir, 'log.in')) ? readFileSync(join(dir, 'log.in'), 'utf8') : ''
    return { ...r, log, body }
  }
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'admin-'))
    writeFileSync(join(dir, 'gh'), fakeGh, { mode: 0o755 })
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('stops before any settings change when branch creation fails', () => {
    const r = sh('apply', { FAKE_EXISTS: '0', FAKE_CREATE: 'fail' })
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('upstream-main')
    expect(r.log).not.toMatch(MUTATION)
  })
  it('stops before any settings change when an existing upstream-main diverged', () => {
    const r = sh('apply', { FAKE_EXISTS: '1', FAKE_COMPARE: 'diverged' })
    expect(r.status).not.toBe(0)
    expect(r.log).not.toMatch(MUTATION)
  })
  it('stops when an existing upstream-main is ahead of upstream (not an ancestor)', () => {
    const r = sh('apply', { FAKE_EXISTS: '1', FAKE_COMPARE: 'behind' })
    expect(r.status).not.toBe(0)
    expect(r.log).not.toMatch(MUTATION)
  })
  it('proceeds when an existing upstream-main is an ancestor of upstream', () => {
    const r = sh('apply', { FAKE_EXISTS: '1', FAKE_COMPARE: 'ahead' })
    expect(r.status).toBe(0)
    expect(r.log).toMatch(/PATCH/)
  })
  it('proceeds after a successful create', () => {
    const r = sh('apply', { FAKE_EXISTS: '0', FAKE_CREATE: 'ok' })
    expect(r.status).toBe(0)
    expect(r.log).toMatch(/PATCH/)
  })
  it('verify fails when upstream-main is absent', () => {
    const r = sh('verify', { FAKE_EXISTS: '0' })
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('upstream-main')
  })

  it('apply never writes an organization ruleset (repo endpoint 404s) and retargets the repo ruleset', () => {
    const r = sh('apply', { FAKE_EXISTS: '1', FAKE_COMPARE: 'identical' })
    expect(r.status).toBe(0)
    expect(r.log).not.toMatch(/-X PUT repos\/cheese-work\/doop\/rulesets\/1( |$)/m)
    expect(r.log).toMatch(/-X PUT repos\/cheese-work\/doop\/rulesets\/2 /)
    expect(r.body).toContain('"refs/heads/main"')
    expect(r.log).toMatch(/PATCH/)
    expect(r.stderr).toMatch(/organization ruleset/)
  })
  it('apply still retargets a repo ruleset named protect main', () => {
    const list = JSON.stringify([
      { id: 1, name: 'protect main', source_type: 'Organization' },
      { id: 3, name: 'protect main', source_type: 'Repository' },
      { id: 2, name: 'protect default branches', source_type: 'Repository' },
    ])
    const r = sh('apply', { FAKE_EXISTS: '1', FAKE_COMPARE: 'identical', FAKE_RULESETS: list })
    expect(r.status).toBe(0)
    expect(r.log).toMatch(/-X PUT repos\/cheese-work\/doop\/rulesets\/3 /)
    expect(r.log).not.toMatch(/-X PUT repos\/cheese-work\/doop\/rulesets\/1( |$)/m)
  })
  it('apply stops before any ruleset write when a named ruleset is absent', () => {
    const list = JSON.stringify([{ id: 2, name: 'protect default branches', source_type: 'Repository' }])
    const r = sh('apply', { FAKE_EXISTS: '1', FAKE_COMPARE: 'identical', FAKE_RULESETS: list })
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('protect main')
    expect(r.log).not.toMatch(/-X (PUT|POST|PATCH)/)
  })
  it('rollback restores the default branch and retargets only repo rulesets', () => {
    const r = sh('rollback', {})
    expect(r.status).toBe(0)
    expect(r.log).toMatch(/PATCH repos\/cheese-work\/doop -f default_branch=main/)
    expect(r.log).not.toMatch(/-X PUT repos\/cheese-work\/doop\/rulesets\/1( |$)/m)
    expect(r.log).toMatch(/-X PUT repos\/cheese-work\/doop\/rulesets\/2 /)
    expect(r.body).toContain('~DEFAULT_BRANCH')
  })
  it('apply keeps main protected: copies the org ruleset rules to a repo ruleset on main', () => {
    const r = sh('apply', { FAKE_EXISTS: '1', FAKE_COMPARE: 'identical' })
    expect(r.status).toBe(0)
    expect(r.log).toMatch(/-X POST repos\/cheese-work\/doop\/rulesets /)
    const copy = r.body.split('\n').find((l) => l.includes('protect main (repo copy)')) ?? ''
    expect(copy).toContain('"refs/heads/main"')
    expect(copy).toContain('"deletion"')
    expect(copy).toContain('"pull_request"')
  })
  it('apply does not duplicate the repo copy when it already exists', () => {
    const list = JSON.stringify([
      { id: 1, name: 'protect main', source_type: 'Organization' },
      { id: 2, name: 'protect default branches', source_type: 'Repository' },
      { id: 4, name: 'protect main (repo copy)', source_type: 'Repository' },
    ])
    const r = sh('apply', { FAKE_EXISTS: '1', FAKE_COMPARE: 'identical', FAKE_RULESETS: list })
    expect(r.status).toBe(0)
    expect(r.body).not.toContain('protect main (repo copy)')
  })
  it('rollback deletes the repo copy', () => {
    const list = JSON.stringify([
      { id: 1, name: 'protect main', source_type: 'Organization' },
      { id: 2, name: 'protect default branches', source_type: 'Repository' },
      { id: 4, name: 'protect main (repo copy)', source_type: 'Repository' },
    ])
    const r = sh('rollback', { FAKE_RULESETS: list })
    expect(r.status).toBe(0)
    expect(r.log).toMatch(/-X DELETE repos\/cheese-work\/doop\/rulesets\/4( |$)/m)
  })
})
