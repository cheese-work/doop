import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/* CHE-10354 (plan CHE-9850, gap from CHE-9479/CHE-9877): GitHub's own cron skips slots, so X99 sends a
   `workflow_dispatch` for cd-freshness-watch.yml every 15 minutes from a systemd user timer. The script may only
   ever dispatch the watch; a fake token minter and a fake `gh` record what it does. */

const DIR = resolve('deploy/cd/watch-trigger')
const SCRIPT = join(DIR, 'cd-watch-trigger.sh')
const read = (f: string) => (existsSync(f) ? readFileSync(f, 'utf8') : '')
const noComments = (s: string) => s.replace(/^\s*#.*$/gm, '')

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cdwt-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const exe = (name: string, body: string) => {
  const p = join(dir, name)
  writeFileSync(p, `#!/usr/bin/env bash\n${body}\n`)
  chmodSync(p, 0o755)
  return p
}

const run = (opts: { ghExit?: number; mintExit?: number; mintOut?: string } = {}) => {
  const log = join(dir, 'calls.log')
  const mint = exe(
    'mint',
    `echo "mint owner=$GITHUB_APP_OWNER repos=$GITHUB_APP_REPOSITORIES perms=$GITHUB_APP_PERMISSIONS" >> "${log}"
${opts.mintExit ? `echo boom >&2; exit ${opts.mintExit}` : `printf '%s' '${opts.mintOut ?? 'ghs_faketoken'}'`}`,
  )
  const gh = exe('gh', `echo "gh token=$GH_TOKEN args=$*" >> "${log}"\nexit ${opts.ghExit ?? 0}`)
  const r = spawnSync('bash', [SCRIPT], {
    encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin', CD_WATCH_TOKEN_BIN: mint, GH_BIN: gh },
  })
  return { ...r, calls: read(log).split('\n').filter(Boolean) }
}

describe('cd-watch-trigger.sh', () => {
  it('dispatches only cd-freshness-watch.yml on cheese/main, with a token minted for actions:write on doop', () => {
    const r = run()
    expect(r.status).toBe(0)
    expect(r.calls).toEqual([
      'mint owner=cheese-work repos=["doop"] perms={"actions":"write"}',
      'gh token=ghs_faketoken args=workflow run cd-freshness-watch.yml -R cheese-work/doop --ref cheese/main',
    ])
  })

  it('has no way to name another workflow: no argument, no cd-deploy', () => {
    const src = noComments(read(SCRIPT))
    expect(src).not.toMatch(/cd-deploy|\$1|\$@|\$\{1/)
    const r = spawnSync('bash', [SCRIPT, 'cd-deploy.yml'], {
      encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin', CD_WATCH_TOKEN_BIN: '/nonexistent', GH_BIN: '/nonexistent' },
    })
    expect(r.status).not.toBe(0)
  })

  it('fails without calling gh when the token cannot be minted', () => {
    const r = run({ mintExit: 3 })
    expect(r.status).not.toBe(0)
    expect(r.calls.some((c) => c.startsWith('gh '))).toBe(false)
  })

  it('fails without calling gh when the minter prints nothing', () => {
    const r = run({ mintOut: '' })
    expect(r.status).not.toBe(0)
    expect(r.calls.some((c) => c.startsWith('gh '))).toBe(false)
  })

  it('fails when the dispatch fails, so the unit shows failed in systemd', () => {
    const r = run({ ghExit: 1 })
    expect(r.status).not.toBe(0)
  })

  it('never prints the token', () => {
    const r = run()
    expect(r.stdout + r.stderr).not.toContain('ghs_faketoken')
  })
})

describe('systemd units', () => {
  const svc = read(join(DIR, 'cd-watch-trigger.service'))
  const tmr = read(join(DIR, 'cd-watch-trigger.timer'))

  it('service runs the script once and never mentions the deploy workflow', () => {
    expect(svc).toMatch(/^Type=oneshot$/m)
    expect(svc).toMatch(/^ExecStart=.*cd-watch-trigger\.sh$/m)
    expect(noComments(svc) + noComments(tmr)).not.toMatch(/cd-deploy/)
  })

  it('timer fires every 15 minutes at :05 :20 :35 :50, offset from GitHub cron at :12 :27 :42 :57', () => {
    expect(tmr).toMatch(/^OnCalendar=\*:05\/15$/m)
    expect(tmr).toMatch(/^Persistent=true$/m)
    expect(tmr).toMatch(/^WantedBy=timers\.target$/m)
  })
})
