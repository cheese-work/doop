import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/* deploy/cd/c00.sh against a stub `docker`. The stub logs every call and answers
   from files in a scratch dir, so each test scripts exactly what C00 would say. */
const SCRIPT = resolve('deploy/cd/c00.sh')
const DIGEST = 'sha256:' + 'a'.repeat(64)
const REF = `ghcr.io/cheese-work/doop@${DIGEST}`
const SHA = 'c'.repeat(40)

const STUB = `#!/usr/bin/env bash
echo "docker $*" >> "$STUB_DIR/log"
case "$*" in *" ps -q "*) echo "doop-db"; exit 0 ;; esac
case "$1" in compose) echo "DOOP_IMAGE=\${DOOP_IMAGE:-}" >> "$STUB_DIR/log"; exit 0 ;; esac
say() { [ -f "$STUB_DIR/$1" ] && cat "$STUB_DIR/$1" || exit 1; }
case "$*" in
  *pg_locks*) cat "$STUB_DIR/locks" 2>/dev/null || echo 0 ;;
  *pg_stat_activity*) cat "$STUB_DIR/sessions" 2>/dev/null || true ;;
  "ps "*) cat "$STUB_DIR/migrate_ps" 2>/dev/null || true ;;
  *RestartCount*) say restart ;;
  "image inspect doop-rollback:previous") [ -f "$STUB_DIR/rollback_tag" ] || exit 1 ;;
  *State.Running*) say running ;;
  *State.Health*)
    n=$(cat "$STUB_DIR/n" 2>/dev/null || echo 0); echo $((n + 1)) > "$STUB_DIR/n"
    total=$(wc -l < "$STUB_DIR/health"); [ "$n" -ge "$total" ] && n=$((total - 1))
    sed -n "$((n + 1))p" "$STUB_DIR/health" ;;
  *RepoDigests*) say repodigests ;;
  *Labels*) say label ;;
  *"{{.Image}}"*) say container_image ;;
  *) exit 0 ;;
esac
`

/* `node` is stubbed too: `apply` runs the pre-apply gate through it (CHE-5544). The stub records its
   arguments and fails when `gate_fail` exists. Like the real gate it writes go/action to $GITHUB_OUTPUT, read
   when it is called: a test changes the files while c00.sh waits for the lock, which is the race the real gate
   must decide after. */
const NODE_STUB = `#!/usr/bin/env bash
echo "node $*" >> "$STUB_DIR/nodelog"
if [ -f "$STUB_DIR/gate_fail" ]; then
  [ -z "\${GITHUB_OUTPUT:-}" ] || echo "go=false" >> "$GITHUB_OUTPUT"
  echo "gate refused" >&2; exit 1
fi
if [ -n "\${GITHUB_OUTPUT:-}" ]; then
  echo "go=true" >> "$GITHUB_OUTPUT"
  case "$*" in *"--op rollback"*) echo "action=$(cat "$STUB_DIR/action" 2>/dev/null || echo rollback)" >> "$GITHUB_OUTPUT" ;; esac
fi
exit 0
`

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c00-'))
  mkdirSync(join(dir, 'bin'))
  writeFileSync(join(dir, 'bin', 'docker'), STUB)
  chmodSync(join(dir, 'bin', 'docker'), 0o755)
  writeFileSync(join(dir, 'bin', 'node'), NODE_STUB)
  chmodSync(join(dir, 'bin', 'node'), 0o755)
  put('log', '')
  put('running', 'true\n')
  put('health', 'healthy\n')
  put('container_image', 'sha256:newimageid\n')
  put('repodigests', `ghcr.io/cheese-work/doop@${DIGEST}\n`)
  put('label', SHA + '\n')
  put('restart', '0\n')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const put = (name: string, text: string) => writeFileSync(join(dir, name), text)
const log = () => readFileSync(join(dir, 'log'), 'utf8')
const nodelog = () => (existsSync(join(dir, 'nodelog')) ? readFileSync(join(dir, 'nodelog'), 'utf8') : '')

function c00(cmd: string, env: Record<string, string> = {}) {
  return spawnSync('bash', [SCRIPT, cmd], {
    encoding: 'utf8',
    env: {
      PATH: `${join(dir, 'bin')}:${process.env.PATH}`,
      STUB_DIR: dir,
      C00_COMPOSE_DIR: '/srv/doop',
      C00_PG_CONTAINER: 'doop-db',
      C00_READBACK_SECONDS: '2',
      C00_ROLLBACK_SECONDS: '2',
      C00_POLL_SECONDS: '0',
      C00_STABLE_CHECKS: '2',
      DEPLOY_REF: REF,
      DEPLOY_SHA: SHA,
      DEPLOY_MODE: 'train',
      MARKER_EXPECT: 'armed:n1:99:' + SHA,
      C00_LOCK_FILE: join(dir, 'lock'),
      C00_LOCK_WAIT: '2',
      ...env,
    },
  })
}

describe('c00.sh apply', () => {
  it('pins the previous image, pulls by digest, then starts that digest without building', () => {
    put('container_image', 'sha256:oldimageid\n')
    const r = c00('apply')
    expect(r.status, r.stderr).toBe(0)
    const l = log()
    expect(l).toContain('docker tag sha256:oldimageid doop-rollback:previous')
    expect(l.indexOf('docker tag')).toBeLessThan(l.indexOf(`docker pull ${REF}`))
    expect(l.indexOf(`docker pull ${REF}`)).toBeLessThan(l.indexOf('docker compose'))
    expect(l).toMatch(/docker compose .*up -d .*--no-build/)
    expect(l).toContain(`DOOP_IMAGE=${REF}`)
    expect(l).not.toMatch(/docker (build|buildx)|compose .* build( |$)/)
  })

  it('recreates only the C00 service `app` from compose.yaml, with the image overlay', () => {
    const r = c00('apply')
    expect(r.status, r.stderr).toBe(0)
    const l = log()
    expect(l).toContain('-f /srv/doop/compose.yaml')
    expect(l).toMatch(/--force-recreate app\n/)
    expect(l).toMatch(/--no-build --pull never --force-recreate app\n/)
  })

  it('drops a stale rollback tag on a first deploy (no container yet)', () => {
    rmSync(join(dir, 'container_image'))
    const r = c00('apply')
    expect(r.status, r.stderr).toBe(0)
    expect(log()).toContain('docker rmi doop-rollback:previous')
    expect(log()).not.toContain('docker tag')
  })

  describe('lock and pre-apply check (C-5)', () => {
    it('runs the pre-apply check for this mode and marker value before the first docker call', () => {
      const r = c00('apply')
      expect(r.status, r.stderr).toBe(0)
      expect(nodelog()).toMatch(/deploy-gate\.mjs recheck train --op pre-apply --expect armed:n1:99:c{40}\n$/)
      expect(log()).toContain('docker pull')
    })

    it('a refused check stops before any docker call: nothing is tagged, pulled or started', () => {
      put('gate_fail', 'x')
      const r = c00('apply', { GITHUB_OUTPUT: join(dir, 'gh_output') })
      expect(r.status).not.toBe(0)
      expect(log()).toBe('')
      // The real gate reports go=false before it refuses; apply itself writes nothing after that.
      const written = readFileSync(join(dir, 'gh_output'), 'utf8')
      expect(written).not.toMatch(/lock_wait_seconds|attempted/)
    })

    it.each([['DEPLOY_MODE'], ['MARKER_EXPECT']])('refuses without %s', (name) => {
      const r = c00('apply', { [name]: '' })
      expect(r.status).not.toBe(0)
      expect(log()).toBe('')
      expect(nodelog()).toBe('')
    })

    it('waits for the lock, and gives up without touching docker or running the check', () => {
      const r = spawnSync('flock', [join(dir, 'lock'), '-c', `bash ${SCRIPT} apply`], {
        encoding: 'utf8',
        env: {
          PATH: `${join(dir, 'bin')}:${process.env.PATH}`,
          STUB_DIR: dir,
          C00_COMPOSE_DIR: '/srv/doop',
          DEPLOY_REF: REF,
          DEPLOY_SHA: SHA,
          DEPLOY_MODE: 'train',
          MARKER_EXPECT: 'armed:n1:99:' + SHA,
          C00_LOCK_FILE: join(dir, 'lock'),
          C00_LOCK_WAIT: '1',
        },
      })
      expect(r.status).not.toBe(0)
      expect(r.stderr).toMatch(/lock/)
      expect(log()).toBe('')
      expect(nodelog()).toBe('')
    })
  })

  describe('attempted flag (rollback only after a real attempt)', () => {
    const out = () => join(dir, 'gh_output')
    const run = () => c00('apply', { GITHUB_OUTPUT: out() })
    const flag = () => (existsSync(out()) ? readFileSync(out(), 'utf8') : '')

    it('is set after the rollback target is captured, before compose starts the new image', () => {
      put('container_image', 'sha256:oldimageid\n')
      expect(run().status).toBe(0)
      expect(flag()).toContain('attempted=true\n')
    })

    it('is not set when the pull fails: the running deployment was never touched', () => {
      writeFileSync(
        join(dir, 'bin', 'docker'),
        STUB.replace('case "$1" in compose)', 'case "$1" in pull) exit 1 ;; compose)'),
      )
      expect(run().status).not.toBe(0)
      expect(flag()).not.toContain('attempted')
      expect(log()).not.toContain('docker compose')
    })

    it('is not set for a refused ref', () => {
      expect(c00('apply', { GITHUB_OUTPUT: out(), DEPLOY_REF: 'x:latest' }).status).not.toBe(0)
      expect(flag()).toBe('')
    })
  })

  it.each([
    ['a tag', 'ghcr.io/cheese-work/doop:latest'],
    ['a short digest', 'ghcr.io/cheese-work/doop@sha256:abc'],
    ['an empty ref', ''],
    ['an injected command', `ghcr.io/x/y@${DIGEST}; rm -rf /`],
  ])('refuses %s before touching docker', (_n, ref) => {
    const r = c00('apply', { DEPLOY_REF: ref })
    expect(r.status).not.toBe(0)
    expect(log()).toBe('')
  })
})

describe('c00.sh readback', () => {
  it('passes when healthy, running the evidence digest, labelled with the deployed SHA', () => {
    const r = c00('readback')
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('readback ok')
  })

  it('waits through "starting" and passes once healthy', () => {
    put('health', 'starting\nstarting\nhealthy\n')
    expect(c00('readback').status).toBe(0)
  })

  it('needs consecutive healthy checks, not one lucky poll', () => {
    put('health', 'healthy\nstarting\nstarting\nstarting\nstarting\nstarting\nstarting\nstarting\n')
    expect(c00('readback', { C00_READBACK_SECONDS: '1' }).status).not.toBe(0)
  })

  it.each([
    ['unhealthy', { health: 'unhealthy\n' }, /unhealthy/],
    ['never healthy within the window', { health: 'starting\n' }, /within/],
    ['a stopped container', { running: 'false\n' }, /not running/],
    ['another digest', { repodigests: 'ghcr.io/cheese-work/doop@sha256:' + 'b'.repeat(64) + '\n' }, /digest/],
    ['no digest at all (locally built image)', { repodigests: '\n' }, /digest/],
    ['another source SHA', { label: 'd'.repeat(40) + '\n' }, /SHA|revision/],
    ['a missing revision label', { label: '\n' }, /SHA|revision/],
  ])('fails on %s', (_n, files, why) => {
    for (const [k, v] of Object.entries(files)) put(k, v)
    const r = c00('readback')
    expect(r.status).not.toBe(0)
    expect(r.stderr).toMatch(why)
  })

  it('fails before polling when the running image is wrong (no 15-minute wait)', () => {
    put('label', 'd'.repeat(40) + '\n')
    c00('readback')
    expect(log()).not.toContain('State.Health')
  })

  it('refuses without a ref or SHA', () => {
    expect(c00('readback', { DEPLOY_SHA: '' }).status).not.toBe(0)
    expect(c00('readback', { DEPLOY_REF: '' }).status).not.toBe(0)
  })
})

describe('c00.sh rollback', () => {
  it('restarts the pinned previous image, without building, and waits for health', () => {
    put('rollback_tag', 'x')
    const r = c00('rollback')
    expect(r.status, r.stderr).toBe(0)
    expect(log()).toContain('DOOP_IMAGE=doop-rollback:previous')
    expect(log()).toMatch(/docker compose .*up -d .*--no-build/)
    expect(r.stdout).toContain('rollback ok')
  })

  it('fails when the restored image is not healthy either', () => {
    put('rollback_tag', 'x')
    put('health', 'unhealthy\n')
    expect(c00('rollback').status).not.toBe(0)
  })

  it('fails loudly with nothing to roll back to (first deploy)', () => {
    const r = c00('rollback')
    expect(r.status).not.toBe(0)
    expect(r.stderr).toMatch(/no previous image/)
    expect(log()).not.toContain('docker compose')
  })
})

describe('c00.sh readback window and T0 (C-9)', () => {
  it('defaults to a 90 s window, 3 consecutive healthy checks', () => {
    expect(readFileSync(SCRIPT, 'utf8')).toMatch(/C00_READBACK_SECONDS:-90\}/)
  })

  it('records T0 for the later jobs: restart count, health, readback time', () => {
    const out = join(dir, 'gh_output')
    put('restart', '2\n')
    const r = c00('readback', { GITHUB_OUTPUT: out })
    expect(r.status, r.stderr).toBe(0)
    const o = readFileSync(out, 'utf8')
    expect(o).toContain('restart_count=2\n')
    expect(o).toContain('health=healthy\n')
    expect(o).toMatch(/t0_epoch=\d{10}\n/)
  })

  it('records the time spent waiting for the lock', () => {
    const out = join(dir, 'gh_output')
    expect(c00('apply', { GITHUB_OUTPUT: out }).status).toBe(0)
    expect(readFileSync(out, 'utf8')).toMatch(/lock_wait_seconds=\d+\n/)
  })
})

describe('c00.sh confirm (C-9 readback-confirm)', () => {
  const old = String(Math.floor(Date.now() / 1000) - 2000)
  const confirmEnv = { RESTART_T0: '0', T0_EPOCH: old }

  it('passes: same restart count, healthy, candidate digest and label, delay honoured', () => {
    const out = join(dir, 'gh_output')
    const r = c00('confirm', { ...confirmEnv, GITHUB_OUTPUT: out })
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('confirm ok')
    expect(readFileSync(out, 'utf8')).toMatch(/confirmed_epoch=\d{10}\n/)
  })

  it('fails when the container restarted since T0', () => {
    put('restart', '1\n')
    const r = c00('confirm', confirmEnv)
    expect(r.status).not.toBe(0)
    expect(r.stderr).toMatch(/restart/)
  })

  it.each([
    ['unhealthy', { health: 'unhealthy\n' }, /unhealthy/],
    ['starting', { health: 'starting\n' }, /healthy/],
    ['a stopped container', { running: 'false\n' }, /not running/],
    ['another digest', { repodigests: 'ghcr.io/cheese-work/doop@sha256:' + 'b'.repeat(64) + '\n' }, /digest/],
    ['another label', { label: 'd'.repeat(40) + '\n' }, /SHA|revision/],
  ])('fails on %s', (_n, files, why) => {
    for (const [k, v] of Object.entries(files)) put(k, v)
    const r = c00('confirm', confirmEnv)
    expect(r.status).not.toBe(0)
    expect(r.stderr).toMatch(why)
  })

  it('refuses a confirm earlier than the delay after T0 (a missing wait timer fails closed)', () => {
    const r = c00('confirm', { ...confirmEnv, T0_EPOCH: String(Math.floor(Date.now() / 1000) - 5) })
    expect(r.status).not.toBe(0)
    expect(r.stderr).toMatch(/delay/)
  })

  it.each(['RESTART_T0', 'T0_EPOCH'])('refuses without %s', (name) => {
    expect(c00('confirm', { ...confirmEnv, [name]: '' }).status).not.toBe(0)
  })

  it('takes the deploy lock, and gives up without a docker call when it is held', () => {
    const r = spawnSync('flock', [join(dir, 'lock'), '-c', `bash ${SCRIPT} confirm`], {
      encoding: 'utf8',
      env: {
        PATH: `${join(dir, 'bin')}:${process.env.PATH}`,
        STUB_DIR: dir,
        C00_COMPOSE_DIR: '/srv/doop',
        DEPLOY_REF: REF,
        DEPLOY_SHA: SHA,
        DEPLOY_MODE: 'train',
        MARKER_EXPECT: 'armed:n1:99:' + SHA,
        ...confirmEnv,
        C00_LOCK_FILE: join(dir, 'lock'),
        C00_LOCK_WAIT: '1',
      },
    })
    expect(r.status).not.toBe(0)
    expect(r.stderr).toMatch(/lock/)
    expect(log()).toBe('')
  })
})

describe('c00.sh rollback to the predecessor by digest (C-9)', () => {
  const PRED = 'sha256:' + 'd'.repeat(64)
  const PSHA = 'b'.repeat(40)
  const predEnv = { PREDECESSOR_DIGEST: PRED, PREDECESSOR_SHA: PSHA }
  beforeEach(() => {
    put('rollback_tag', 'x')
    put('repodigests', `ghcr.io/cheese-work/doop@${PRED}\n`)
    put('label', PSHA + '\n')
  })

  it('starts the retained image and reads back the predecessor digest, label and health', () => {
    const r = c00('rollback', predEnv)
    expect(r.status, r.stderr).toBe(0)
    expect(log()).toContain('DOOP_IMAGE=doop-rollback:previous')
    expect(r.stdout).toContain('rollback ok')
    expect(r.stdout).toContain(PSHA)
  })

  it('refuses before any change when the retained image is not the predecessor digest', () => {
    put('repodigests', 'ghcr.io/cheese-work/doop@sha256:' + 'b'.repeat(64) + '\n')
    const r = c00('rollback', predEnv)
    expect(r.status).not.toBe(0)
    expect(r.stderr).toMatch(/predecessor/)
    expect(log()).not.toContain('docker compose')
  })

  it('fails when the predecessor label is wrong after the restart', () => {
    put('label', 'e'.repeat(40) + '\n')
    const r = c00('rollback', predEnv)
    expect(r.status).not.toBe(0)
    expect(r.stderr).toMatch(/SHA|revision/)
  })

  it('refuses a predecessor digest that is not a sha256 digest', () => {
    expect(c00('rollback', { ...predEnv, PREDECESSOR_DIGEST: 'latest' }).status).not.toBe(0)
    expect(c00('rollback', { ...predEnv, PREDECESSOR_SHA: '' }).status).not.toBe(0)
    expect(log()).not.toContain('docker compose')
  })

  it('takes the deploy lock first', () => {
    const r = spawnSync('flock', [join(dir, 'lock'), '-c', `bash ${SCRIPT} rollback`], {
      encoding: 'utf8',
      env: {
        PATH: `${join(dir, 'bin')}:${process.env.PATH}`,
        STUB_DIR: dir,
        C00_COMPOSE_DIR: '/srv/doop',
        DEPLOY_MODE: 'train',
        MARKER_EXPECT: 'armed:n1:99:' + SHA,
        ...predEnv,
        C00_LOCK_FILE: join(dir, 'lock'),
        C00_LOCK_WAIT: '1',
      },
    })
    expect(r.status).not.toBe(0)
    expect(r.stderr).toMatch(/lock/)
    expect(log()).not.toContain('docker compose')
  })
})

describe('c00.sh usage', () => {
  it('rejects an unknown command and requires a compose dir', () => {
    expect(c00('explode').status).not.toBe(0)
    expect(c00('apply', { C00_COMPOSE_DIR: '' }).status).not.toBe(0)
  })
})

/* CHE-5549 review round 1: the rollback and confirm decisions are made under the lock, on what C00 and the
   marker say at that moment, and migration quiescence is proven under the lock whatever the train switch says. */
describe('c00.sh rollback decides under the lock (C-9, C-5 rollback check)', () => {
  const PRED = 'sha256:' + 'd'.repeat(64)
  const PSHA = 'b'.repeat(40)
  const predEnv = { PREDECESSOR_DIGEST: PRED, PREDECESSOR_SHA: PSHA }
  const out = () => join(dir, 'gh_output')
  const ghOut = () => (existsSync(out()) ? readFileSync(out(), 'utf8') : '')
  beforeEach(() => {
    put('rollback_tag', 'x')
    put('repodigests', `ghcr.io/cheese-work/doop@${PRED}\n`)
    put('label', PSHA + '\n')
  })
  const run = (env: Record<string, string> = {}) => c00('rollback', { ...predEnv, GITHUB_OUTPUT: out(), ...env })
  const changedDocker = /docker (compose|tag|rmi|pull)/

  it("runs the rollback check after the lock, for this mode and this run's own marker value", () => {
    const r = run()
    expect(r.status, r.stderr).toBe(0)
    expect(nodelog()).toMatch(/deploy-gate\.mjs recheck train --op rollback --expect armed:n1:99:c{40}\n$/)
    expect(ghOut()).toContain('action=rollback\n')
    expect(log()).toMatch(/docker compose .*up -d/)
  })

  it.each(['DEPLOY_MODE', 'MARKER_EXPECT'])('refuses without %s before any docker call', (name) => {
    const r = run({ [name]: '' })
    expect(r.status).not.toBe(0)
    expect(log()).toBe('')
    expect(nodelog()).toBe('')
  })

  it.each(['none', 'superseded'])('action %s: no container change and the action is reported', (action) => {
    put('action', action + '\n')
    const r = run()
    expect(r.status, r.stderr).toBe(0)
    expect(ghOut()).toContain(`action=${action}\n`)
    expect(log()).not.toMatch(changedDocker)
  })

  it('an action it does not know is refused closed', () => {
    put('action', 'explode\n')
    expect(run().status).not.toBe(0)
    expect(log()).not.toContain('docker compose')
  })

  it('a refused check changes nothing and reports go=false', () => {
    put('gate_fail', 'x')
    const r = run()
    expect(r.status).not.toBe(0)
    expect(ghOut()).toContain('go=false\n')
    expect(log()).not.toMatch(changedDocker)
  })

  /* Another run holds the lock, changes the world, then lets go. The rollback must read the world after it. */
  const whileWaiting = (change: string) =>
    spawnSync(
      'bash',
      [
        '-c',
        `(flock ${join(dir, 'lock')} -c 'sleep 1; ${change}') & sleep 0.3; bash ${SCRIPT} rollback; code=$?; wait; exit $code`,
      ],
      {
        encoding: 'utf8',
        env: {
          PATH: `${join(dir, 'bin')}:${process.env.PATH}`,
          STUB_DIR: dir,
          C00_COMPOSE_DIR: '/srv/doop',
          C00_PG_CONTAINER: 'doop-db',
          C00_POLL_SECONDS: '0',
          C00_STABLE_CHECKS: '2',
          C00_ROLLBACK_SECONDS: '2',
          DEPLOY_REF: REF,
          DEPLOY_SHA: SHA,
          DEPLOY_MODE: 'train',
          MARKER_EXPECT: 'armed:n1:99:' + SHA,
          ...predEnv,
          GITHUB_OUTPUT: out(),
          C00_LOCK_FILE: join(dir, 'lock'),
          C00_LOCK_WAIT: '10',
        },
      },
    )

  it('a newer deployment that lands while it waits for the lock is not replaced (superseded)', () => {
    const r = whileWaiting(`echo superseded > ${join(dir, 'action')}`)
    expect(r.status, r.stderr).toBe(0)
    expect(ghOut()).toContain('action=superseded\n')
    expect(log()).not.toMatch(changedDocker)
  })

  it('a marker changed while it waits for the lock refuses the rollback', () => {
    const r = whileWaiting(`echo x > ${join(dir, 'gate_fail')}`)
    expect(r.status).not.toBe(0)
    expect(ghOut()).toContain('go=false\n')
    expect(log()).not.toMatch(changedDocker)
  })

  it('migration work that starts while it waits for the lock refuses the rollback', () => {
    const r = whileWaiting(`echo 555 > ${join(dir, 'sessions')}`)
    expect(r.status).not.toBe(0)
    expect(r.stderr).toMatch(/quiescen/i)
    expect(log()).not.toMatch(changedDocker)
  })
})

describe('c00.sh proves migration quiescence under the lock, switch on or off (C-5, C-8.8)', () => {
  const old = String(Math.floor(Date.now() / 1000) - 2000)
  const PRED = 'sha256:' + 'd'.repeat(64)
  const PSHA = 'b'.repeat(40)
  const ops: [string, Record<string, string>][] = [
    ['confirm', { RESTART_T0: '0', T0_EPOCH: old }],
    ['rollback', { PREDECESSOR_DIGEST: PRED, PREDECESSOR_SHA: PSHA }],
  ]
  const switches: [string, Record<string, string>][] = [
    ['absent', {}],
    ['off', { DOOP_DEPLOY_TRAIN: 'off' }],
    ['on', { DOOP_DEPLOY_TRAIN: 'on' }],
  ]
  const active: [string, () => void][] = [
    ['a live migrate session', () => put('sessions', '555|2026-11-16 06:00:01+00\n')],
    ['a held advisory lock', () => put('locks', '1\n')],
    ['a migrate container that is still running', () => put('migrate_ps', 'doop-migrate-1 running\n')],
  ]
  beforeEach(() => {
    put('rollback_tag', 'x')
    put('repodigests', `ghcr.io/cheese-work/doop@${PRED}\n`)
    put('label', PSHA + '\n')
  })

  describe.each(ops)('%s', (op, opEnv) => {
    describe.each(switches)('switch %s', (_s, sw) => {
      it('goes ahead when nothing migrates', () => {
        if (op === 'confirm') {
          put('repodigests', `ghcr.io/cheese-work/doop@${DIGEST}\n`)
          put('label', SHA + '\n')
        }
        const r = c00(op, { ...opEnv, ...sw })
        expect(r.status, r.stderr).toBe(0)
      })

      it.each(active)('refuses on %s and changes nothing', (_n, arrange) => {
        if (op === 'confirm') {
          put('repodigests', `ghcr.io/cheese-work/doop@${DIGEST}\n`)
          put('label', SHA + '\n')
        }
        arrange()
        const gho = join(dir, 'gh_output')
        const r = c00(op, { ...opEnv, ...sw, GITHUB_OUTPUT: gho })
        expect(r.status).not.toBe(0)
        expect(r.stderr).toMatch(/quiescen/i)
        expect(log()).not.toMatch(/docker (compose|tag|rmi|pull)/)
        expect(existsSync(gho) ? readFileSync(gho, 'utf8') : '').not.toContain('confirmed_epoch')
      })
    })
  })

  it('a database that cannot be read counts as not proven', () => {
    const r = c00('confirm', { ...ops[0]![1], C00_PG_CONTAINER: '' })
    expect(r.status).not.toBe(0)
  })
})

describe('c00.sh confirm decides under the lock (C-5 confirm check)', () => {
  const old = String(Math.floor(Date.now() / 1000) - 2000)
  const confirmEnv = { RESTART_T0: '0', T0_EPOCH: old }

  it('runs the confirm check for this mode and marker value after the lock', () => {
    const r = c00('confirm', confirmEnv)
    expect(r.status, r.stderr).toBe(0)
    expect(nodelog()).toMatch(/deploy-gate\.mjs recheck train --op confirm --expect armed:n1:99:c{40}\n$/)
  })

  it('a refused check (marker changed) stops the confirm: no confirmed_epoch', () => {
    put('gate_fail', 'x')
    const gho = join(dir, 'gh_output')
    const r = c00('confirm', { ...confirmEnv, GITHUB_OUTPUT: gho })
    expect(r.status).not.toBe(0)
    expect(readFileSync(gho, 'utf8')).not.toContain('confirmed_epoch')
  })

  it.each(['DEPLOY_MODE', 'MARKER_EXPECT'])('refuses without %s', (name) => {
    expect(c00('confirm', { ...confirmEnv, [name]: '' }).status).not.toBe(0)
  })
})

/* The jobs' own env blocks drive c00.sh: the C00 runner holds nothing but what the workflow gives each job
   (CHE-5549 review: confirm lacked C00_COMPOSE_DIR, so every healthy deploy rolled back). `vars.*` resolve to
   their defaults (an unset variable is empty), job outputs and context values are given by the test. */
describe('workflow job env reaches c00.sh with the default runner configuration', () => {
  const wf = readFileSync(resolve('.github/workflows/cd-deploy.yml'), 'utf8')
  const jobEnv = (name: string): Record<string, string> => {
    const j = new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [a-z][a-z0-9-]*:\\n|(?![\\s\\S]))`, 'm').exec(wf)?.[1] ?? ''
    const block = /^ {4}env:\n((?: {6}.*\n|\s*\n)*)/m.exec(j)?.[1] ?? ''
    const out: Record<string, string> = {}
    for (const line of block.split('\n')) {
      const m = /^ {6}([A-Z0-9_]+): (.*)$/.exec(line)
      if (!m) continue
      const v = m[2]!.trim()
      const dflt = /^\$\{\{ vars\.\w+ \|\| '([^']*)' \}\}$/.exec(v)
      if (dflt) out[m[1]!] = dflt[1]!
      else if (/^\$\{\{ vars\.\w+ \}\}$/.test(v)) out[m[1]!] = ''
      else if (!v.includes('${{')) out[m[1]!] = v
    }
    return out
  }
  // What the workflow expressions that need other jobs would give (these tests are not about them).
  const given = { DEPLOY_REF: REF, DEPLOY_SHA: SHA, DEPLOY_MODE: 'train', MARKER_EXPECT: 'armed:n1:99:' + SHA }
  const runnerEnv = (name: string, extra: Record<string, string>) => ({
    PATH: `${join(dir, 'bin')}:${process.env.PATH}`,
    STUB_DIR: dir,
    C00_LOCK_FILE: join(dir, 'lock'),
    C00_LOCK_WAIT: '2',
    C00_POLL_SECONDS: '0',
    ...given,
    ...extra,
    ...jobEnv(name),
  })
  const run = (cmd: string, name: string, extra: Record<string, string>) =>
    spawnSync('bash', [SCRIPT, cmd], { encoding: 'utf8', env: runnerEnv(name, extra) })

  it.each(['deploy', 'readback-confirm', 'rollback'])(
    '%s sets the compose dir and the database container the same way',
    (name) => {
      const e = jobEnv(name)
      expect(e.C00_COMPOSE_DIR, name).toBeTruthy()
      expect(e).toHaveProperty('C00_PG_CONTAINER')
      expect(wf).toMatch(/DOOP_DEPLOY_TRAIN: \$\{\{ vars\.DOOP_DEPLOY_TRAIN \}\}/)
      expect(e.C00_COMPOSE_DIR).toBe(jobEnv('deploy').C00_COMPOSE_DIR)
    },
  )

  it('a healthy deploy confirms with only the confirm job env: the database is found by default discovery', () => {
    const old = String(Math.floor(Date.now() / 1000) - 2000)
    const r = run('confirm', 'readback-confirm', { RESTART_T0: '0', T0_EPOCH: old })
    expect(r.status, r.stderr).toBe(0)
    expect(r.stderr).not.toContain('C00_COMPOSE_DIR is not set')
    expect(log()).toMatch(/docker compose .* ps -q db/)
  })

  it('rollback runs with only the rollback job env', () => {
    const r = run('rollback', 'rollback', { PREDECESSOR_DIGEST: DIGEST, PREDECESSOR_SHA: SHA })
    expect(r.stderr).not.toContain('C00_COMPOSE_DIR is not set')
  })
})
