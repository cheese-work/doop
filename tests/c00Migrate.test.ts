import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/* CHE-5474 S4b (C-8.7, C-8.8): `c00.sh apply` runs migrations once in a supervised one-shot
   container and proves quiescence before it lets anything else change C00. The stub `docker`
   answers from files in a scratch dir, so each test scripts exactly what C00 would report. */
const SCRIPT = resolve('deploy/cd/c00.sh')
const DIGEST = 'sha256:' + 'a'.repeat(64)
const REF = `ghcr.io/cheese-work/doop@${DIGEST}`
const RUN = '4242-1'
const NAME = `doop-migrate-${RUN}`

/* Files steer the stub:
   migrate      ok | fail | hang          what the one-shot container does
   sessions     rows `pid|backend_start`  pg_stat_activity answer (before pg_terminate_backend)
   run_sessions, run_locks      same, but only once the one-shot container was started
   sessions_after, locks, locks_after, ledger, ledger_after, state_after_kill
   Presence of `terminated` / `killed` marks that the script ran pg_terminate_backend / docker kill. */
const STUB = `#!/usr/bin/env bash
echo "docker $*" >> "$STUB_DIR/log"
f() { # $1 = file; reads <file>_after once terminated
  if [ -f "$STUB_DIR/terminated" ] && [ -f "$STUB_DIR/$1_after" ]; then cat "$STUB_DIR/$1_after"
  elif [ -f "$STUB_DIR/started" ] && [ -f "$STUB_DIR/run_$1" ]; then cat "$STUB_DIR/run_$1"
  elif [ -f "$STUB_DIR/$1" ]; then cat "$STUB_DIR/$1"; fi
}
case "$1" in
  compose)
    echo "DOOP_IMAGE=\${DOOP_IMAGE:-}" >> "$STUB_DIR/log"
    case "$*" in *" ps -q "*) [ -f "$STUB_DIR/no_db_service" ] || echo "doop-db-1"; exit 0 ;; esac
    case "$*" in *" run "*) touch "$STUB_DIR/started" ;; esac
    [ -f "$STUB_DIR/compose_fail" ] && exit 1
    exit 0 ;;
  kill) touch "$STUB_DIR/killed"; exit 0 ;;
  wait)
    case "$(cat "$STUB_DIR/migrate")" in
      ok) echo 0 ;;
      fail) echo 1 ;;
      hang) [ -f "$STUB_DIR/killed" ] && echo 137 || { exec sleep 10; } ;;
    esac
    exit 0 ;;
  ps) f migrate_ps; exit 0 ;;
  exec)
    [ -f "$STUB_DIR/pg_down" ] && { echo "pg down" >&2; exit 1; }
    sql="\${@: -1}"
    case "$sql" in
      *pg_terminate_backend*) touch "$STUB_DIR/terminated"; echo "t" ;;
      *pg_stat_activity*) f sessions ;;
      *pg_locks*) f locks ;;
      *__drizzle_migrations*) f ledger ;;
      *) echo "unexpected sql: $sql" >&2; exit 1 ;;
    esac
    exit 0 ;;
esac
say() { [ -f "$STUB_DIR/$1" ] && cat "$STUB_DIR/$1" || exit 1; }
case "$*" in
  "image inspect doop-rollback:previous") [ -f "$STUB_DIR/rollback_tag" ] || exit 1 ;;
  *State.Status*) if [ -f "$STUB_DIR/killed" ] && [ -f "$STUB_DIR/state_after_kill" ]; then cat "$STUB_DIR/state_after_kill"; else say state; fi ;;
  *State.Running*) say running ;;
  *State.Health*) echo healthy ;;
  *"{{.Image}}"*) say container_image ;;
  *) exit 0 ;;
esac
`

let dir: string
const put = (name: string, text: string) => writeFileSync(join(dir, name), text)
const log = () => readFileSync(join(dir, 'log'), 'utf8')
const out = () => join(dir, 'gh_output')
const ghOut = () => (existsSync(out()) ? readFileSync(out(), 'utf8') : '')

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c00m-'))
  mkdirSync(join(dir, 'bin'))
  writeFileSync(join(dir, 'bin', 'docker'), STUB)
  chmodSync(join(dir, 'bin', 'docker'), 0o755)
  put('log', '')
  put('running', 'true\n')
  put('container_image', 'sha256:oldimageid\n')
  put('state', 'exited\n')
  put('migrate', 'ok')
  put('sessions', '')
  put('locks', '0\n')
  put('ledger', 'h1|1000\nh2|2000\n')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function c00(cmd: string, env: Record<string, string> = {}) {
  return spawnSync('bash', [SCRIPT, cmd], {
    encoding: 'utf8',
    env: {
      PATH: `${join(dir, 'bin')}:${process.env.PATH}`,
      STUB_DIR: dir,
      GITHUB_OUTPUT: out(),
      C00_COMPOSE_DIR: '/srv/doop',
      C00_PG_CONTAINER: 'doop-db',
      C00_POLL_SECONDS: '0',
      C00_QUIESCE_POLL_SECONDS: '0',
      C00_MIGRATE_SECONDS: '1',
      C00_QUIESCE_SECONDS: '1',
      C00_ROLLBACK_SECONDS: '2',
      C00_STABLE_CHECKS: '1',
      DEPLOY_REF: REF,
      DEPLOY_SHA: 'c'.repeat(40),
      DEPLOY_RUN_ID: RUN,
      ...env,
    },
  })
}
const idx = (needle: string | RegExp) => {
  const l = log()
  return typeof needle === 'string' ? l.indexOf(needle) : l.search(needle)
}

describe('supervised apply (C-8.8)', () => {
  it('runs the migrations once in a one-shot container of the candidate image, before the app is recreated', () => {
    const r = c00('apply')
    expect(r.status, r.stderr).toBe(0)
    const l = log()
    expect(l).toMatch(/docker compose .*run -d .*--no-deps .*--name doop-migrate-4242-1 /)
    expect(l).toContain(`DOOP_IMAGE=${REF}`)
    expect(l).toMatch(/node server\/db\/migrate\.ts/)
    expect(l).toMatch(/doop\.migrate\.run=4242-1/)
    expect(idx(`docker pull ${REF}`)).toBeLessThan(idx('run -d'))
    expect(idx('run -d')).toBeLessThan(idx(/up -d .*--force-recreate app/))
    expect(idx('wait doop-migrate-4242-1')).toBeLessThan(idx(/up -d .*--force-recreate app/))
  })

  it('names the session and the advisory lock owner by application_name = the container name', () => {
    c00('apply')
    expect(log()).toContain(`DOOP_MIGRATE_APP_NAME=${NAME}`)
  })

  it('gives the migration a deadline: the wait is bounded by C00_MIGRATE_SECONDS', () => {
    put('migrate', 'hang')
    const t0 = Date.now()
    const r = c00('apply')
    expect(r.status).not.toBe(0)
    expect(Date.now() - t0).toBeLessThan(15_000)
  })

  it('reports attempted only after the migration succeeded, before the app is recreated', () => {
    expect(c00('apply').status).toBe(0)
    expect(ghOut()).toContain('attempted=true')
    expect(ghOut()).not.toContain('outcome=')
  })

  it('removes the one-shot container after success', () => {
    c00('apply')
    expect(log()).toContain(`docker rm -f ${NAME}`)
  })

  it('app starts with DOOP_SKIP_MIGRATIONS=1 (compose overlay)', () => {
    const overlay = readFileSync(resolve('deploy/cd/compose.image.yml'), 'utf8')
    expect(overlay).toMatch(/DOOP_SKIP_MIGRATIONS:\s*['"]?1['"]?/)
  })
})

describe('migration timeout or failure (C-8.8)', () => {
  const hung = () => {
    put('migrate', 'hang')
    put('run_sessions', '321|2026-11-16 06:00:01+00\n')
    put('state', 'running\n')
    put('state_after_kill', 'exited\n')
    put('sessions_after', '')
  }

  it('timeout: kills and waits the container, terminates its sessions, proves quiescence -> migrate_failed', () => {
    hung()
    const r = c00('apply')
    expect(r.status).not.toBe(0)
    expect(ghOut()).toContain('outcome=migrate_failed')
    const l = log()
    expect(l).toContain(`docker kill ${NAME}`)
    expect(l).toMatch(new RegExp(`pg_terminate_backend[^\\n]*application_name = '${NAME}'`))
    expect(idx(`docker kill ${NAME}`)).toBeLessThan(idx('pg_terminate_backend'))
    // the proof reads all three facts
    expect(l).toMatch(/State\.Status[^\n]*doop-migrate-4242-1/)
    expect(l).toMatch(/pg_stat_activity/)
    expect(l).toMatch(/pg_locks/)
  })

  it('timeout: no app start, rollback target not mistaken for an attempt, running app untouched', () => {
    hung()
    c00('apply')
    expect(log()).not.toMatch(/up -d/)
    expect(ghOut()).not.toContain('attempted=true')
  })

  it('timeout: records (pid, backend_start) of the sessions before and after', () => {
    hung()
    const r = c00('apply')
    expect(r.stdout + r.stderr).toMatch(/sessions_before=\(321, 2026-11-16 06:00:01\+00\)/)
    expect(r.stdout + r.stderr).toMatch(/sessions_after=none/)
  })

  it('non-zero exit: same path, outcome migrate_failed, no app start', () => {
    put('migrate', 'fail')
    const r = c00('apply')
    expect(r.status).not.toBe(0)
    expect(ghOut()).toContain('outcome=migrate_failed')
    expect(log()).toContain(`docker kill ${NAME}`)
    expect(log()).not.toMatch(/up -d/)
  })

  it('compares the ledger with the pre-apply ledger and says so', () => {
    put('migrate', 'fail')
    const r = c00('apply')
    expect(r.stdout + r.stderr).toMatch(/ledger_changed=false/)
  })

  it('a ledger that changed during the failed run is reported, not hidden', () => {
    put('migrate', 'fail')
    put('ledger_after', 'h1|1000\nh2|2000\nh3|3000\n')
    const r = c00('apply')
    expect(ghOut()).toContain('outcome=migrate_failed')
    expect(r.stdout + r.stderr).toMatch(/ledger_changed=true/)
  })

  it('an unreadable ledger after the failure is unproven -> needs_operator', () => {
    put('migrate', 'fail')
    put('ledger_after', '')
    // empty ledger text after a non-empty one cannot be told from a wiped table: treat as changed, not as proof
    const r = c00('apply')
    expect(r.status).not.toBe(0)
    expect(ghOut()).toMatch(/outcome=(migrate_failed|needs_operator)/)
  })
})

describe('quiescence not proven -> needs_operator (C-8.8)', () => {
  const failing = () => {
    put('migrate', 'fail')
    put('run_sessions', '321|2026-11-16 06:00:01+00\n')
  }

  it('a session that survives pg_terminate_backend', () => {
    failing()
    put('sessions_after', '321|2026-11-16 06:00:01+00\n')
    const r = c00('apply')
    expect(r.status).not.toBe(0)
    expect(ghOut()).toContain('outcome=needs_operator')
    expect(ghOut()).not.toContain('migrate_failed')
    expect(log()).not.toMatch(/up -d/)
  })

  it('an advisory lock that survives', () => {
    failing()
    put('sessions_after', '')
    put('run_locks', '1\n')
    put('locks_after', '1\n')
    c00('apply')
    expect(ghOut()).toContain('outcome=needs_operator')
  })

  it('a container that is not exited', () => {
    failing()
    put('state', 'running\n')
    put('state_after_kill', 'running\n')
    expect(c00('apply').status).not.toBe(0)
    expect(ghOut()).toContain('outcome=needs_operator')
  })

  it('a container that cannot be inspected', () => {
    failing()
    rmSync(join(dir, 'state'))
    expect(c00('apply').status).not.toBe(0)
    expect(ghOut()).toContain('outcome=needs_operator')
  })

  it('a database that cannot be queried', () => {
    failing()
    put('pg_down', '1')
    expect(c00('apply').status).not.toBe(0)
    expect(log()).not.toMatch(/up -d/)
  })

  it('the proof has a bounded budget (C00_QUIESCE_SECONDS)', () => {
    failing()
    put('sessions_after', '321|2026-11-16 06:00:01+00\n')
    const t0 = Date.now()
    c00('apply', { C00_QUIESCE_SECONDS: '1', C00_POLL_SECONDS: '0' })
    expect(Date.now() - t0).toBeLessThan(10_000)
  })
})

describe('later operations check the same three facts first (C-8.8)', () => {
  const cases: [string, () => void][] = [
    ['a live migrate session', () => put('sessions', '555|2026-11-16 06:00:01+00\n')],
    ['a held advisory lock', () => put('locks', '1\n')],
    ['a migrate container that is still running', () => put('migrate_ps', `${NAME} running\n`)],
    ['a database that cannot be read', () => put('pg_down', '1')],
  ]

  describe.each(['apply', 'rollback', 'quiescence'])('%s', (op) => {
    it.each(cases)('refuses on %s and touches nothing', (_n, arrange) => {
      put('rollback_tag', 'x')
      arrange()
      const r = c00(op)
      expect(r.status).not.toBe(0)
      expect(r.stderr).toMatch(/quiescen/i)
      expect(ghOut()).toContain('outcome=needs_operator')
      expect(log()).not.toMatch(/docker (pull|tag|rmi|compose)/)
    })
  })

  it('quiescence passes when all three hold (usable by the compat and lift jobs)', () => {
    const r = c00('quiescence')
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toMatch(/quiescent/)
  })

  it('a finished migrate container from an earlier run is fine', () => {
    put('migrate_ps', `${NAME} exited\n`)
    expect(c00('quiescence').status).toBe(0)
  })

  it('rollback proceeds once the facts hold', () => {
    put('rollback_tag', 'x')
    const r = c00('rollback')
    expect(r.status, r.stderr).toBe(0)
    expect(log()).toMatch(/up -d/)
  })

  it('the gate reads the database read-only', () => {
    c00('quiescence')
    expect(log()).toContain('default_transaction_read_only=on')
  })
})

describe('inputs fail closed', () => {
  it.each([
    ['no run id', { DEPLOY_RUN_ID: '' }],
    ['a run id with shell characters', { DEPLOY_RUN_ID: '1; rm -rf /' }],
    ['a run id with an underscore (LIKE wildcard)', { DEPLOY_RUN_ID: 'a_b' }],
  ])('apply refuses %s before touching docker', (_n, env) => {
    const r = c00('apply', env)
    expect(r.status).not.toBe(0)
    expect(log()).toBe('')
  })

  it('apply refuses when no Postgres container is named and the compose project has no db service', () => {
    put('no_db_service', '1')
    const r = c00('apply', { C00_PG_CONTAINER: '' })
    expect(r.status).not.toBe(0)
    expect(log()).not.toMatch(/docker (pull|tag|rmi)|up -d|compose[^\n]* run /)
  })
})

/* The deploy job's own env (`.github/workflows/image.yml`) is what c00.sh really gets. Resolve the few
   expressions it uses, then run `apply` and `rollback` with exactly that env. */
function workflowDeployEnv(): Record<string, string> {
  const wf = readFileSync(resolve('.github/workflows/image.yml'), 'utf8')
  const job = /^ {2}deploy:\n([\s\S]*?)(?=^ {2}[a-z][a-z0-9-]*:\n|(?![\s\S]))/m.exec(wf)?.[1] ?? ''
  const block = /^ {4}env:\n((?: {6}.*\n)+)/m.exec(job)?.[1] ?? ''
  const out: Record<string, string> = {}
  for (const line of block.split('\n')) {
    const m = /^ {6}([A-Z0-9_]+): (.*)$/.exec(line)
    if (!m?.[1] || m[2] === undefined) continue
    out[m[1]] = m[2]
      .replace(/\$\{\{\s*format\('\{0\}-\{1\}', github\.run_id, github\.run_attempt\)\s*\}\}/g, '9001-2')
      .replace(/\$\{\{\s*vars\.\w+\s*\|\|\s*'([^']*)'\s*\}\}/g, '$1')
      .replace(/\$\{\{\s*vars\.\w+\s*\}\}/g, '')
      .replace(/\$\{\{\s*format\('ghcr\.io\/\{0\}@\{1\}'[^}]*\)\s*\}\}/g, REF)
      .replace(/\$\{\{\s*github\.sha\s*\}\}/g, 'c'.repeat(40))
    if (out[m[1]]!.includes('${{')) throw new Error(`unresolved expression in deploy env ${m[1]}: ${m[2]}`)
  }
  return out
}

describe('the real deploy workflow environment', () => {
  const run = (cmd: string, env: Record<string, string> = {}) => {
    const wf = workflowDeployEnv()
    return spawnSync('bash', [SCRIPT, cmd], {
      encoding: 'utf8',
      env: {
        PATH: `${join(dir, 'bin')}:${process.env.PATH}`,
        STUB_DIR: dir,
        GITHUB_OUTPUT: out(),
        C00_POLL_SECONDS: '0',
        C00_STABLE_CHECKS: '1',
        ...wf,
        ...env,
      },
    })
  }

  it('gives apply a valid run id that is unique per attempt', () => {
    const e = workflowDeployEnv()
    expect(e.DEPLOY_RUN_ID).toBe('9001-2')
  })

  it('apply runs end to end with only what image.yml provides (no extra inputs)', () => {
    const r = run('apply')
    expect(r.status, r.stderr).toBe(0)
    expect(log()).toContain('doop-migrate-9001-2')
    expect(log()).toMatch(/docker exec [^\n]* doop-db-1 psql/)
  })

  it('rollback runs with only what image.yml provides', () => {
    put('rollback_tag', 'x')
    const r = run('rollback')
    expect(r.status, r.stderr).toBe(0)
  })

  it('an explicit C00_PG_CONTAINER wins over the compose lookup', () => {
    const r = run('quiescence', { C00_PG_CONTAINER: 'my-pg' })
    expect(r.status, r.stderr).toBe(0)
    expect(log()).toMatch(/docker exec [^\n]* my-pg psql/)
  })

  it('with no database container to be found, it refuses closed before any change', () => {
    put('no_db_service', '1')
    const r = run('apply')
    expect(r.status).not.toBe(0)
    expect(log()).not.toMatch(/docker (pull|tag|rmi)|up -d/)
  })
})
