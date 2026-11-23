import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/* Text assertions (`yaml` is only transitive). CHE-5544 (train S2, plan CHE-5474 C-2, C-3, C-5, C-6):
   D1 (`image.yml`) builds and records the candidate manifest and holds no deploy power; D2
   (`cd-deploy.yml`) is the only workflow that touches C00. */
const d1 = readFileSync('.github/workflows/image.yml', 'utf8')
const d2 = readFileSync('.github/workflows/cd-deploy.yml', 'utf8')

/* The text of one top-level job, up to the next job or end of file. */
function job(wf: string, name: string): string {
  const m = new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [a-z][a-z0-9-]*:\\n|(?![\\s\\S]))`, 'm').exec(wf)
  if (!m?.[1]) throw new Error(`no job ${name}`)
  return m[1]
}
const hasJob = (wf: string, name: string) => new RegExp(`^  ${name}:\\n`, 'm').test(wf)

describe('D1 image.yml: build and manifest only', () => {
  it('keeps ci and image, and has no gate or deploy job', () => {
    expect(hasJob(d1, 'ci')).toBe(true)
    expect(hasJob(d1, 'image')).toBe(true)
    expect(hasJob(d1, 'gate')).toBe(false)
    expect(hasJob(d1, 'deploy')).toBe(false)
  })

  it('holds no C00 runner and no deploy secret', () => {
    expect(d1).not.toMatch(/self-hosted|cheese-c00-deploy|c00-deploy-doop/)
    expect(d1.replace(/secrets\.GITHUB_TOKEN/g, '')).not.toContain('secrets.')
    expect(d1).not.toMatch(/c00\.sh|deploy-gate/)
  })

  it('records the candidate manifest: SHA, digest, inventory sha and D1 run id', () => {
    const image = job(d1, 'image')
    expect(image).toContain('scripts/migration-inventory.mjs')
    for (const v of ['DIGEST', 'SHA', 'INVENTORY_SHA', 'D1_RUN_ID']) expect(image).toContain(`${v}:`)
    expect(image).toContain('github.run_id')
    expect(image).toMatch(/name: candidate-manifest/)
    expect(image).toContain('retention-days')
  })

  it('still labels the image with the source SHA, which the pin and the readback check', () => {
    expect(job(d1, 'image')).toContain('org.opencontainers.image.revision=${{ github.sha }}')
  })
})

describe('D2 cd-deploy.yml: triggers (C-2, C-3)', () => {
  it('is classed deploy, and runs on the 8-hour schedule and on dispatch only', () => {
    expect(d2).toMatch(/^# ci-policy: class=deploy$/m)
    expect(d2).toMatch(/schedule:\s*\n\s*- cron: '17 23,7,15 \* \* \*'/)
    expect(d2).toContain('workflow_dispatch:')
    expect(d2).not.toMatch(/^\s+push:/m)
    expect(d2).not.toContain('pull_request')
  })

  it('takes mode, candidate_sha, schedule_backup and fault as dispatch inputs', () => {
    const inputs = d2.slice(d2.indexOf('inputs:'), d2.indexOf('\npermissions:'))
    for (const i of ['mode', 'candidate_sha', 'schedule_backup', 'fault'])
      expect(inputs).toMatch(new RegExp(`^ {6}${i}:`, 'm'))
    for (const m of ['train', 'recovery', 'drill']) expect(inputs).toContain(`- ${m}`)
  })

  it('has no workflow-level concurrency; the lock is per C00 job', () => {
    expect(d2).not.toMatch(/^concurrency:/m)
  })
})

describe('D2 hosted jobs: resolve and admit', () => {
  it('run on GitHub runners, read only, with nothing from the deploy host', () => {
    for (const name of ['resolve', 'admit']) {
      const j = job(d2, name)
      expect(j).toContain('runs-on: ubuntu-latest')
      expect(j).not.toMatch(/self-hosted|cheese-c00-deploy/)
      expect(j).not.toMatch(/: write/)
    }
  })

  it('resolve decides with deploy-gate.mjs and downloads the manifest of the chosen D1 run', () => {
    const j = job(d2, 'resolve')
    expect(j).toContain('scripts/deploy-gate.mjs decide')
    expect(j).toContain('scripts/deploy-gate.mjs resolve')
    expect(j).toContain('candidate-manifest')
    expect(j).toMatch(/outputs:[\s\S]*candidate:/)
  })

  it('admit pins manifest, run, image label and inventory to the candidate', () => {
    const j = job(d2, 'admit')
    expect(j).toMatch(/needs: resolve/)
    expect(j).toContain('scripts/deploy-gate.mjs admit')
    expect(j).toContain('scripts/migration-inventory.mjs')
    expect(j).toMatch(/ref: \$\{\{ needs\.resolve\.outputs\.candidate \}\}/)
    expect(j).toMatch(/outputs:[\s\S]*go:[\s\S]*digest:/)
  })

  it('never inlines event data or inputs into a script', () => {
    for (const name of ['resolve', 'admit']) expect(job(d2, name)).not.toMatch(/run:[^\n]*\$\{\{/)
  })
})

describe('D2 C00 jobs: deploy, readback-confirm, rollback', () => {
  const c00jobs = ['deploy', 'readback-confirm', 'rollback']

  it.each(c00jobs)('%s runs on the C00 runner under one non-cancelling lock group', (name) => {
    const j = job(d2, name)
    expect(j).toContain('[self-hosted, cheese-c00-deploy]')
    expect(j).toMatch(/concurrency:\s*\n\s*group: c00-deploy-doop\s*\n\s*cancel-in-progress: false/)
    expect(j).toContain("github.repository == 'cheese-work/doop'")
  })

  it('only the C00 jobs name the C00 runner', () => {
    expect(job(d2, 'resolve')).not.toContain('cheese-c00-deploy')
    expect(job(d2, 'admit')).not.toContain('cheese-c00-deploy')
  })

  it('deploy runs only when admit said go, and deploys the admitted digest, never a tag or a build', () => {
    const j = job(d2, 'deploy')
    expect(j).toContain("needs.admit.outputs.go == 'true'")
    expect(j).toContain('needs.admit.outputs.digest')
    expect(j).toContain('DEPLOY_REF')
    expect(j).not.toMatch(/:latest|docker\/build-push-action|docker build|buildx/)
  })

  it('deploy step 1 is the pre-arm recheck, before login, apply or any docker call', () => {
    const j = job(d2, 'deploy')
    const recheck = j.indexOf('deploy-gate.mjs recheck')
    expect(recheck).toBeGreaterThan(-1)
    expect(j.slice(recheck, recheck + 80)).toContain('--op pre-arm')
    expect(recheck).toBeGreaterThan(j.indexOf('uses: actions/checkout@v4'))
    for (const later of ['docker login', 'c00.sh apply', 'c00.sh readback'])
      expect(j.indexOf(later), later).toBeGreaterThan(recheck)
    expect(j).toMatch(
      /uses: actions\/checkout@v4\s*\n\s*with:\s*\n\s*ref: \$\{\{ needs\.admit\.outputs\.candidate \}\}/,
    )
  })

  it.each(c00jobs)('%s checks out full history, so the ancestry and range checks see the running revision', (name) => {
    expect(job(d2, name)).toMatch(/uses: actions\/checkout@v4\s*\n\s*with:[\s\S]*?fetch-depth: 0/)
  })

  it('deploy passes the entry facts to the pre-arm and pre-apply checks', () => {
    const j = job(d2, 'deploy')
    for (const v of ['EVENT:', 'ACTOR:', 'TRIGGER:', 'ATTEMPT:', 'INPUT_MODE:', 'INPUT_SCHEDULE_BACKUP:'])
      expect(j, v).toContain(v)
  })

  it('apply gets the mode and the run-own marker value, so pre-apply runs inside the flock', () => {
    const j = job(d2, 'deploy')
    expect(j).toContain('DEPLOY_MODE:')
    expect(j).toContain('MARKER_EXPECT:')
  })

  it('the deploy job reports the facts the later jobs need', () => {
    expect(job(d2, 'deploy')).toMatch(/outputs:[\s\S]*predecessor_digest:/)
  })

  it('confirm runs the confirm check; rollback runs the rollback check before any change', () => {
    const confirm = job(d2, 'readback-confirm')
    expect(confirm).toMatch(/needs: \[admit, deploy\]/)
    expect(confirm).toContain('--op confirm')
    const rb = job(d2, 'rollback')
    expect(rb).toContain('--op rollback')
    expect(rb.indexOf('--op rollback')).toBeLessThan(rb.indexOf('c00.sh rollback'))
    expect(rb).toMatch(/if: \$\{\{ always\(\) && /)
  })

  it('set no job-level timeout past the age bound and never swallow a failure', () => {
    for (const name of c00jobs) {
      const j = job(d2, name)
      expect(j).toMatch(/timeout-minutes: (\d|[1-5]\d)\b/)
      expect(j).not.toMatch(/continue-on-error|nohup|setsid|disown/)
    }
  })

  it('passes event data through env, and logs out of GHCR even on failure', () => {
    for (const name of c00jobs) expect(job(d2, name)).not.toMatch(/run:[^\n]*\$\{\{/)
    expect(job(d2, 'deploy')).toMatch(/if: always\(\)[\s\S]*docker logout ghcr\.io/)
  })
})

describe('D2 suspension marker wiring (CHE-5545, C-10.1 to C-10.3)', () => {
  const deploy = job(d2, 'deploy')
  const confirm = job(d2, 'readback-confirm')
  const rollback = job(d2, 'rollback')
  const at = (j: string, needle: string) => {
    const i = j.indexOf(needle)
    expect(i, needle).toBeGreaterThan(-1)
    return i
  }

  it.each([
    ['deploy', deploy],
    ['readback-confirm', confirm],
    ['rollback', rollback],
  ])('%s writes the marker with a GitHub App token from the doop-deploy-marker environment', (_n, j) => {
    expect(j).toMatch(/environment: doop-deploy-marker/)
    expect(j).toMatch(/uses: actions\/create-github-app-token@[0-9a-f]{40}/)
    expect(j).toContain('permission-variables: write')
    expect(j).toContain('repositories: doop')
    // The token is minted before the first marker write. Deploy and confirm mint before their checks, which read
    // variables, and `github.token` cannot (CHE-9181): the gate gets it as VARS_TOKEN, the marker writer as
    // GH_TOKEN. Rollback mints before its check, which runs even if the mint fails (see below).
    expect(at(j, 'create-github-app-token')).toBeLessThan(at(j, 'deploy-marker.mjs'))
    expect(at(j, 'create-github-app-token')).toBeLessThan(at(j, 'deploy-gate.mjs recheck'))
    expect(j).toMatch(/VARS_TOKEN: \$\{\{ steps\.app\.outputs\.token \}\}/)
    expect(j).toMatch(/GH_TOKEN: \$\{\{ steps\.app\.outputs\.token \}\}/)
  })

  it('resolve/decide reads the switches through vars, not the variables API (CHE-9181)', () => {
    const decide = job(d2, 'resolve')
    const step = decide.slice(decide.indexOf('- id: decide'), decide.indexOf('- id: pick'))
    for (const name of ['DOOP_DEPLOY_TRAIN', 'MAIN_RED_PAUSED', 'DOOP_DEPLOY_SUSPENDED'])
      expect(step).toContain(`${name}: \${{ vars.${name} }}`)
    expect(step).not.toContain('github.token')
  })

  it('hosted jobs never get the marker token or the environment', () => {
    for (const name of ['resolve', 'admit']) {
      expect(job(d2, name)).not.toContain('doop-deploy-marker')
      expect(job(d2, name)).not.toContain('create-github-app-token')
    }
  })

  it('arms right after the pre-arm check and before login, apply or any docker call', () => {
    const arm = at(deploy, 'deploy-marker.mjs')
    expect(arm).toBeGreaterThan(at(deploy, '--op pre-arm'))
    for (const later of ['docker login', 'c00.sh apply', 'c00.sh readback']) expect(arm).toBeLessThan(at(deploy, later))
    // A train run arms; recovery and drill suspend. Neither can write clear.
    expect(deploy).toMatch(/deploy-marker\.mjs arm/)
    expect(deploy).toMatch(/deploy-marker\.mjs suspend/)
    expect(deploy).not.toMatch(/deploy-marker\.mjs restore/)
  })

  it('a failed arm write stops the deploy: login, apply and readback run only after a passing arm', () => {
    const armStep = deploy.slice(at(deploy, 'id: arm'), at(deploy, 'Log in to GHCR'))
    expect(armStep).not.toMatch(/continue-on-error|if: always|if: \$\{\{ (always|failure)/)
    for (const name of ['Apply', 'Read back']) {
      const step = deploy.slice(at(deploy, `- name: ${name}`)).split('\n      - ')[0] ?? ''
      expect(step, name).not.toMatch(/always\(\)|failure\(\)|cancelled\(\)/)
    }
  })

  it('the run-own marker value is the arm step output, not a value computed from the run id', () => {
    for (const j of [deploy, confirm, rollback]) expect(j).not.toMatch(/armed:n\{|format\('armed:/)
    expect(deploy).toMatch(/MARKER_EXPECT: \$\{\{ steps\.arm\.outputs\.marker \}\}/)
    expect(deploy).toMatch(/outputs:[\s\S]*marker: \$\{\{ steps\.arm\.outputs\.marker \}\}/)
    expect(confirm).toMatch(/MARKER_EXPECT: \$\{\{ needs\.deploy\.outputs\.marker \}\}/)
    expect(rollback).toMatch(/MARKER_EXPECT: \$\{\{ needs\.deploy\.outputs\.marker \}\}/)
  })

  it('only a passing confirm of a train run restores; the restore is its last step and never runs after a failure', () => {
    const restore = at(confirm, 'deploy-marker.mjs restore')
    expect(restore).toBeGreaterThan(at(confirm, '--op confirm'))
    const step = confirm.slice(confirm.lastIndexOf('- name:', restore))
    expect(step).toMatch(/if: \$\{\{ env\.DEPLOY_MODE == 'train' \}\}/)
    expect(step).not.toMatch(/always\(\)|failure\(\)|cancelled\(\)|continue-on-error/)
    expect(step).toContain('MARKER_EXPECT')
    expect(confirm.slice(restore + 1)).not.toContain('\n      - name:')
  })

  it('rollback suspends over its own arm after the check, whatever the rollback itself did', () => {
    const suspendAt = at(rollback, 'deploy-marker.mjs suspend')
    expect(suspendAt).toBeGreaterThan(at(rollback, '--op rollback'))
    expect(suspendAt).toBeGreaterThan(at(rollback, 'c00.sh rollback'))
    const step = rollback.slice(rollback.lastIndexOf('- name:', suspendAt))
    expect(step).toMatch(/if: \$\{\{ !cancelled\(\) && steps\.check\.outputs\.go == 'true' \}\}/)
    expect(step).toContain('MARKER_EXPECT')
    expect(rollback).not.toMatch(/deploy-marker\.mjs (arm|restore)/)
    // A failed token mint can never keep a broken deploy from rolling back: the check and the rollback run after
    // it (!cancelled()), the job still fails, and the check then decides from C00 alone. The check reads the marker when it has the token.
    const mint = rollback.slice(rollback.lastIndexOf('- name:', at(rollback, 'create-github-app-token')))
    expect(mint).not.toContain('continue-on-error')
    expect(at(rollback, 'create-github-app-token')).toBeLessThan(at(rollback, '--op rollback'))
    const check = rollback.slice(rollback.lastIndexOf('- name:', at(rollback, '--op rollback')))
    expect(check).toMatch(/id: check\n\s+if: \$\{\{ !cancelled\(\) \}\}/)
    expect(rollback).toMatch(/if: \$\{\{ !cancelled\(\) && steps\.check\.outputs\.action == 'rollback' \}\}/)
    expect(check).toMatch(/VARS_TOKEN: \$\{\{ steps\.app\.outputs\.token \}\}/)
  })

  it('the marker is written by these three C00 jobs only', () => {
    for (const name of ['resolve', 'admit']) expect(job(d2, name)).not.toContain('deploy-marker.mjs')
    expect(d1).not.toContain('deploy-marker.mjs')
  })

  it('passes ids and values through env, never into a script', () => {
    for (const j of [deploy, confirm, rollback]) {
      for (const line of j.split('\n').filter((l) => /^\s+run:/.test(l))) expect(line).not.toContain('${{')
    }
  })
})

describe('compose overlay', () => {
  const overlay = readFileSync('deploy/cd/compose.image.yml', 'utf8')

  it('overrides the C00 service `app`, never a made-up name', () => {
    expect(overlay).toMatch(/^services:\n {2}app:\n/m)
    expect(overlay).not.toMatch(/^ {2}doop:/m)
    expect(overlay).toContain('pull_policy: never')
  })
})
