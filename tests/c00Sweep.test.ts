import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/* `c00.sh sweep` (CHE-5474 C-8.5d): every C00 job in lock group c00-deploy-doop first removes every
   resource labelled doop.compat.run, reads back zero, and records df before and after. */
const SCRIPT = resolve('deploy/cd/c00.sh')

const STUB = `#!/usr/bin/env bash
echo "docker $*" >> "$STUB_DIR/log"
list() { [ -f "$STUB_DIR/$1" ] && cat "$STUB_DIR/$1"; true; }
case "$1 $2" in
  "ps -aq") list containers ;;
  "network ls") list networks ;;
  "volume ls") list volumes ;;
  "rm -f") [ -f "$STUB_DIR/rm_fails" ] && exit 1; [ -f "$STUB_DIR/stuck" ] || : > "$STUB_DIR/containers" ;;
  "network rm") [ -f "$STUB_DIR/rm_fails" ] && exit 1; [ -f "$STUB_DIR/stuck" ] || : > "$STUB_DIR/networks" ;;
  "volume rm") [ -f "$STUB_DIR/rm_fails" ] && exit 1; [ -f "$STUB_DIR/stuck" ] || : > "$STUB_DIR/volumes" ;;
esac
exit 0
`

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sweep-'))
  mkdirSync(join(dir, 'bin'))
  writeFileSync(join(dir, 'bin', 'docker'), STUB)
  chmodSync(join(dir, 'bin', 'docker'), 0o755)
  writeFileSync(join(dir, 'log'), '')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const put = (name: string, text: string) => writeFileSync(join(dir, name), text)
const log = () => readFileSync(join(dir, 'log'), 'utf8').trim().split('\n')

const sweep = () =>
  spawnSync('bash', [SCRIPT, 'sweep'], {
    encoding: 'utf8',
    env: { PATH: `${join(dir, 'bin')}:${process.env.PATH}`, STUB_DIR: dir, C00_DF_PATH: dir },
  })

describe('c00.sh sweep', () => {
  it('removes containers, then networks, then volumes carrying the compat label', () => {
    put('containers', 'c1\nc2\n')
    put('networks', 'n1\n')
    put('volumes', 'v1\n')
    const r = sweep()
    expect(r.status, r.stderr).toBe(0)
    const l = log()
    const at = (re: RegExp) => l.findIndex((x) => re.test(x))
    expect(l.some((x) => /ps -aq.*label=doop\.compat\.run/.test(x))).toBe(true)
    expect(at(/^docker rm -f -v c1 c2$/)).toBeGreaterThan(-1)
    expect(at(/^docker network rm n1$/)).toBeGreaterThan(at(/^docker rm -f -v/))
    expect(at(/^docker volume rm -f v1$/)).toBeGreaterThan(at(/^docker network rm/))
  })

  it('reads back zero and records df before and after', () => {
    put('containers', 'c1\n')
    const r = sweep()
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/df_before_bytes=\d+/)
    expect(r.stdout).toMatch(/df_after_bytes=\d+/)
    expect(r.stdout).toMatch(/containers=0 networks=0 volumes=0/)
  })

  it('succeeds and removes nothing when nothing is labelled', () => {
    const r = sweep()
    expect(r.status).toBe(0)
    expect(log().some((x) => / rm | rm$/.test(x))).toBe(false)
  })

  it('fails when a resource is still there after the removal (a failed sweep fails the job)', () => {
    put('containers', 'c1\n')
    put('stuck', '1')
    const r = sweep()
    expect(r.status).not.toBe(0)
    expect(r.stderr).toMatch(/sweep/)
  })

  it('fails when a removal itself fails', () => {
    put('networks', 'n1\n')
    put('rm_fails', '1')
    expect(sweep().status).not.toBe(0)
  })

  it('needs no compose dir and no deploy ref', () => {
    expect(sweep().stderr).not.toMatch(/C00_COMPOSE_DIR|DEPLOY_REF/)
  })
})
