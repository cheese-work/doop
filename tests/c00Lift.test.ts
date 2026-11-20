import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/* `c00.sh lift` (CHE-5551, train S3b, plan CHE-5474 C-10.7) against a stub `docker` and a stub `node`. It takes the
   host lock, proves migration quiescence, reads what C00 runs (digest, revision label, container health), and
   only then runs the lift script, under the same lock, with those facts. The stubs answer from files in a scratch
   dir; the lift decision itself is tested in deployLift.test.ts. */
const SCRIPT = resolve('deploy/cd/c00.sh')
const DIGEST = 'sha256:' + 'a'.repeat(64)
const SHA = 'c'.repeat(40)

const DOCKER = `#!/usr/bin/env bash
echo "docker $*" >> "$STUB_DIR/log"
case "$*" in *" ps -q "*) echo "doop-db"; exit 0 ;; esac
say() { [ -f "$STUB_DIR/$1" ] && cat "$STUB_DIR/$1" || exit 1; }
case "$*" in
  *pg_locks*) cat "$STUB_DIR/locks" 2>/dev/null || echo 0 ;;
  *pg_stat_activity*) cat "$STUB_DIR/sessions" 2>/dev/null || true ;;
  "ps "*) cat "$STUB_DIR/migrate_ps" 2>/dev/null || true ;;
  *State.Health*) say health ;;
  *RepoDigests*) say repodigests ;;
  *Labels*) say label ;;
  *"{{.Image}}"*) say container_image ;;
  *) exit 0 ;;
esac
`

/* Records what it was given, and how long it ran (for the lock test). It writes lift-evidence.json like the real one. */
const NODE = `#!/usr/bin/env bash
{
  echo "start $(date +%s.%N) $*"
  echo "env LIFT_QUIESCENT=$LIFT_QUIESCENT LIFT_DIGEST=$LIFT_DIGEST LIFT_REVISION=$LIFT_REVISION LIFT_CONTAINER_HEALTH=$LIFT_CONTAINER_HEALTH"
} >> "$STUB_DIR/nodelog"
[ ! -f "$STUB_DIR/node_sleep" ] || sleep "$(cat "$STUB_DIR/node_sleep")"
echo "end $(date +%s.%N)" >> "$STUB_DIR/nodelog"
[ ! -f "$STUB_DIR/node_fail" ] || exit 1
exit 0
`

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c00lift-'))
  mkdirSync(join(dir, 'bin'))
  for (const [name, text] of [
    ['docker', DOCKER],
    ['node', NODE],
  ] as const) {
    writeFileSync(join(dir, 'bin', name), text)
    chmodSync(join(dir, 'bin', name), 0o755)
  }
  put('log', '')
  put('health', 'healthy\n')
  put('container_image', 'sha256:runningid\n')
  put('repodigests', `ghcr.io/cheese-work/doop@${DIGEST}\n`)
  put('label', SHA + '\n')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const put = (name: string, text: string) => writeFileSync(join(dir, name), text)
const log = () => readFileSync(join(dir, 'log'), 'utf8')
const nodelog = () => (existsSync(join(dir, 'nodelog')) ? readFileSync(join(dir, 'nodelog'), 'utf8') : '')

const envOf = (extra: Record<string, string> = {}) => ({
  PATH: `${join(dir, 'bin')}:${process.env.PATH}`,
  STUB_DIR: dir,
  C00_PG_CONTAINER: 'doop-db',
  C00_LOCK_FILE: join(dir, 'lock'),
  C00_LOCK_WAIT: '5',
  C00_STATE_DIR: join(dir, 'state'),
  GITHUB_OUTPUT: join(dir, 'out'),
  ...extra,
})
const c00 = (cmd: string, extra: Record<string, string> = {}) =>
  spawnSync('bash', [SCRIPT, cmd], { encoding: 'utf8', env: envOf(extra) })

describe('c00.sh lift', () => {
  it('proves quiescence, reads digest, revision label and health, then runs the lift script with them', () => {
    const r = c00('lift')
    expect(r.status, r.stderr).toBe(0)
    expect(nodelog()).toMatch(/start \S+ .*scripts\/deploy-lift\.mjs lift/)
    expect(nodelog()).toContain(
      `env LIFT_QUIESCENT=true LIFT_DIGEST=${DIGEST} LIFT_REVISION=${SHA} LIFT_CONTAINER_HEALTH=healthy`,
    )
    // The three C-8.8 facts were read before the lift script ran.
    expect(log()).toContain('pg_stat_activity')
    expect(log()).toContain('pg_locks')
    expect(log()).toMatch(/docker ps -a .*doop\.migrate\.run/)
  })

  it('never changes C00: no pull, tag, compose, rm, kill or restart', () => {
    c00('lift')
    expect(log()).not.toMatch(
      /docker (pull|tag|rm|rmi|kill|stop|restart|compose|run|exec .*(insert|update|delete|alter|drop))/i,
    )
  })

  it('passes the lift script’s refusal on: exit 1, nothing else claims success', () => {
    put('node_fail', '1')
    expect(c00('lift').status).toBe(1)
  })

  it.each([
    ['a live migrate session', () => put('sessions', '4242|2026-11-20 09:00:00\n')],
    ['the advisory key held', () => put('locks', '1\n')],
    ['a migrate container not exited', () => put('migrate_ps', 'doop-migrate-9 running\n')],
  ])('unproven quiescence (%s): outcome needs_operator, and the lift script is told so', (_n, arrange) => {
    arrange()
    const r = c00('lift')
    expect(readFileSync(join(dir, 'out'), 'utf8')).toContain('outcome=needs_operator')
    expect(nodelog()).toContain('LIFT_QUIESCENT=false')
    expect(r.status).toBe(0) // the stub node would refuse; here only the facts handed over matter
  })

  it('an unhealthy container is handed over as such', () => {
    put('health', 'unhealthy\n')
    c00('lift')
    expect(nodelog()).toContain('LIFT_CONTAINER_HEALTH=unhealthy')
  })

  it('a missing running container hands over empty facts, never a guess', () => {
    rmSync(join(dir, 'container_image'))
    c00('lift')
    expect(nodelog()).toContain('LIFT_DIGEST= LIFT_REVISION=')
  })

  it('an unresolved compat guard refuses before the lock and before the lift script', () => {
    mkdirSync(join(dir, 'state'))
    writeFileSync(join(dir, 'state', 'compat-unresolved.env'), 'junk\n')
    const r = c00('lift')
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/unreadable|unresolved/)
    expect(nodelog()).toBe('')
  })
})

describe('c00.sh lift under the lock (two concurrent lifts serialize)', () => {
  const start = (extra: Record<string, string> = {}) =>
    new Promise<{ code: number | null; stderr: string }>((done) => {
      const child = spawn('bash', [SCRIPT, 'lift'], { env: envOf(extra) })
      let stderr = ''
      child.stderr.on('data', (d) => (stderr += d))
      child.on('close', (code) => done({ code, stderr }))
    })

  it('the second waits until the first has finished: the lift script runs twice, never at the same time', async () => {
    put('node_sleep', '1')
    const both = await Promise.all([start(), start()])
    expect(both.map((r) => r.code)).toEqual([0, 0])
    const lines = nodelog().trim().split('\n')
    const stamps = lines
      .filter((l) => /^(start|end) /.test(l))
      .map((l) => [l.split(' ')[0], Number(l.split(' ')[1])] as [string, number])
    expect(stamps.map(([k]) => k)).toEqual(['start', 'end', 'start', 'end'])
    expect((stamps[2] ?? [0, 0])[1]).toBeGreaterThanOrEqual((stamps[1] ?? [0, 0])[1])
  }, 30_000)

  it('a lift that cannot get the lock in time fails and never runs the lift script', async () => {
    put('node_sleep', '3')
    const first = start()
    await new Promise((r) => setTimeout(r, 700))
    const second = await start({ C00_LOCK_WAIT: '1' })
    expect(second.code).toBe(1)
    expect(second.stderr).toMatch(/could not take the deploy lock/)
    await first
    expect(nodelog().match(/^start /gm)).toHaveLength(1)
  }, 30_000)
})
