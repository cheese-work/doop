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
case "$1" in compose) echo "DOOP_IMAGE=\${DOOP_IMAGE:-}" >> "$STUB_DIR/log"; exit 0 ;; esac
say() { [ -f "$STUB_DIR/$1" ] && cat "$STUB_DIR/$1" || exit 1; }
case "$*" in
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

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c00-'))
  mkdirSync(join(dir, 'bin'))
  writeFileSync(join(dir, 'bin', 'docker'), STUB)
  chmodSync(join(dir, 'bin', 'docker'), 0o755)
  put('log', '')
  put('running', 'true\n')
  put('health', 'healthy\n')
  put('container_image', 'sha256:newimageid\n')
  put('repodigests', `ghcr.io/cheese-work/doop@${DIGEST}\n`)
  put('label', SHA + '\n')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const put = (name: string, text: string) => writeFileSync(join(dir, name), text)
const log = () => readFileSync(join(dir, 'log'), 'utf8')

function c00(cmd: string, env: Record<string, string> = {}) {
  return spawnSync('bash', [SCRIPT, cmd], {
    encoding: 'utf8',
    env: {
      PATH: `${join(dir, 'bin')}:${process.env.PATH}`,
      STUB_DIR: dir,
      C00_COMPOSE_DIR: '/srv/doop',
      C00_READBACK_SECONDS: '2',
      C00_ROLLBACK_SECONDS: '2',
      C00_POLL_SECONDS: '0',
      C00_STABLE_CHECKS: '2',
      DEPLOY_REF: REF,
      DEPLOY_SHA: SHA,
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

  describe('attempted flag (rollback only after a real attempt)', () => {
    const out = () => join(dir, 'gh_output')
    const run = () => c00('apply', { GITHUB_OUTPUT: out() })
    const flag = () => (existsSync(out()) ? readFileSync(out(), 'utf8') : '')

    it('is set after the rollback target is captured, before compose starts the new image', () => {
      put('container_image', 'sha256:oldimageid\n')
      expect(run().status).toBe(0)
      expect(flag()).toBe('attempted=true\n')
    })

    it('is not set when the pull fails: the running deployment was never touched', () => {
      writeFileSync(
        join(dir, 'bin', 'docker'),
        STUB.replace('case "$1" in compose)', 'case "$1" in pull) exit 1 ;; compose)'),
      )
      expect(run().status).not.toBe(0)
      expect(flag()).toBe('')
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

describe('c00.sh usage', () => {
  it('rejects an unknown command and requires a compose dir', () => {
    expect(c00('explode').status).not.toBe(0)
    expect(c00('apply', { C00_COMPOSE_DIR: '' }).status).not.toBe(0)
  })
})
