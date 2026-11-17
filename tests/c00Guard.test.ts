import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/* The durable `needs_operator` guard (CHE-5474 C-8.8): an unproven migration refuses every later apply, rollback,
   sweep (compat) and lift until the three facts hold. */
const SCRIPT = resolve('deploy/cd/c00.sh')
const ARGS = ['r1', 'doop-compat-migrate-r1', 'doop-compat-db-r1', 'doop', 'doop', 'doop-compat-migrate-r1']

// State comes from files in STUB_DIR: `migrate_running`, `db_state` (true|false|gone|unknown), `sessions`, `locks`.
const STUB = `#!/usr/bin/env bash
echo "docker $*" >> "$STUB_DIR/log"
f() { [ -f "$STUB_DIR/$1" ] && cat "$STUB_DIR/$1" || echo "$2"; }
case "$1" in
  inspect)
    case "$4" in
      doop-compat-migrate-r1) f migrate_running false ;;
      doop-compat-db-r1)
        s=$(f db_state true)
        [ "$s" = gone ] && { echo "Error: No such object: $4" >&2; exit 1; }
        [ "$s" = unknown ] && { echo "Cannot connect to the Docker daemon" >&2; exit 1; }
        echo "$s" ;;
      *) echo "sha256:prev" ;;
    esac ;;
  exec)
    case "$*" in
      *pg_stat_activity*) f sessions 0 ;;
      *pg_locks*) f locks 0 ;;
    esac ;;
  ps | network | volume) ;;
esac
exit 0
`

let dir: string
let guardFile: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'guard-'))
  mkdirSync(join(dir, 'bin'))
  writeFileSync(join(dir, 'bin', 'docker'), STUB)
  chmodSync(join(dir, 'bin', 'docker'), 0o755)
  writeFileSync(join(dir, 'log'), '')
  guardFile = join(dir, 'state', 'compat-unresolved.env')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const put = (name: string, text: string) => writeFileSync(join(dir, name), text)
const log = () => readFileSync(join(dir, 'log'), 'utf8')
const c00 = (cmd: string, args: string[] = [], env: Record<string, string> = {}) =>
  spawnSync('bash', [SCRIPT, cmd, ...args], {
    encoding: 'utf8',
    env: {
      PATH: `${join(dir, 'bin')}:${process.env.PATH}`,
      STUB_DIR: dir,
      C00_GUARD_FILE: guardFile,
      C00_DF_PATH: dir,
      C00_COMPOSE_DIR: dir,
      DEPLOY_REF: 'ghcr.io/cheese-work/doop@sha256:' + 'a'.repeat(64),
      ...env,
    },
  })
const arm = () => {
  const r = c00('guard-set', ARGS)
  expect(r.status, r.stderr).toBe(0)
}

describe('c00.sh guard', () => {
  it('passes at once when no guard exists, and touches docker not at all', () => {
    const r = c00('guard')
    expect(r.status, r.stderr).toBe(0)
    expect(log()).toBe('')
  })

  it('guard-set writes the run, containers, db and application name, and an ICT time', () => {
    arm()
    const text = readFileSync(guardFile, 'utf8')
    expect(text).toContain('run_id=r1\n')
    expect(text).toContain('migrate_container=doop-compat-migrate-r1\n')
    expect(text).toContain('db_container=doop-compat-db-r1\n')
    expect(text).toContain('app_name=doop-compat-migrate-r1\n')
    expect(text).toMatch(/written_ict=\d{4}-\d\d-\d\d \d\d:\d\d:\d\d ICT\n/)
  })

  it.each([
    ['a shell metacharacter', ["r1'; rm -rf /; '", ...ARGS.slice(1)]],
    ['too few arguments', ARGS.slice(0, 4)],
    ['an empty value', ['', ...ARGS.slice(1)]],
  ])('guard-set refuses %s and writes nothing', (_n, args) => {
    const r = c00('guard-set', args)
    expect(r.status).not.toBe(0)
    expect(existsSync(guardFile)).toBe(false)
  })

  it.each([
    ['the migration container is still running', 'migrate_running', 'true', /not exited/],
    ['a session of the run is still open', 'sessions', '1', /1 session\(s\)/],
    ['the advisory key is still held', 'locks', '1', /advisory key is held/],
    ['the database container cannot be inspected', 'db_state', 'unknown', /cannot inspect doop-compat-db-r1/],
  ])('refuses while %s, and keeps the guard', (_n, file, value, msg) => {
    arm()
    put(file!, value!)
    const r = c00('guard')
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(msg)
    expect(r.stderr).toContain('needs_operator')
    expect(existsSync(guardFile)).toBe(true)
  })

  it('clears the guard once the three facts hold, and says so', () => {
    arm()
    const r = c00('guard')
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('guard cleared')
    expect(existsSync(guardFile)).toBe(false)
  })

  it('treats a database container that is gone or stopped as no session and no lock', () => {
    for (const state of ['gone', 'false']) {
      arm()
      put('db_state', state)
      const r = c00('guard')
      expect(r.status, `${state}: ${r.stderr}`).toBe(0)
      expect(existsSync(guardFile)).toBe(false)
    }
  })

  it('refuses a guard file it cannot read as plain tokens', () => {
    mkdirSync(join(dir, 'state'))
    writeFileSync(guardFile, 'run_id=r1\nmigrate_container=$(touch pwned)\n')
    const r = c00('guard')
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/unreadable/)
    expect(existsSync(join(dir, 'pwned'))).toBe(false)
  })

  it('a corrupt guard never clears itself', () => {
    mkdirSync(join(dir, 'state'))
    writeFileSync(guardFile, '')
    expect(c00('guard').status).toBe(1)
    expect(existsSync(guardFile)).toBe(true)
  })
})

describe('c00.sh refuses every later job while the guard is unproven', () => {
  beforeEach(() => {
    arm()
    put('sessions', '2')
  })

  it.each([
    ['apply', {}],
    ['rollback', {}],
    ['sweep', {}],
  ])('%s refuses before it touches containers, images or the sweep', (cmd, env) => {
    const r = c00(cmd, [], env)
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/refused: compat run r1 is unresolved \(needs_operator\)/)
    expect(log()).not.toMatch(/pull|rmi|tag|compose|rm -f|network rm|volume rm|image inspect/)
    expect(existsSync(guardFile)).toBe(true)
  })

  it('apply does not report attempted=true, so no rollback is triggered for a deploy that never started', () => {
    const out = join(dir, 'gh_output')
    writeFileSync(out, '')
    const r = c00('apply', [], { GITHUB_OUTPUT: out })
    expect(r.status).toBe(1)
    expect(readFileSync(out, 'utf8')).toBe('')
  })

  it('the sweep, apply and rollback all go through once the facts hold', () => {
    put('sessions', '0')
    const r = c00('sweep')
    expect(r.status, r.stderr).toBe(0)
    expect(existsSync(guardFile)).toBe(false)
  })
})
