import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/* Text assertions (`yaml` is only transitive). CHE-5544 (train S2, plan CHE-5474 C-2, C-3, C-5, C-6):
   D1 (`image.yml`) builds and records the candidate manifest and holds no deploy power; D2
   (`cd-deploy.yml`) is the only workflow that touches C00. */
const d1 = readFileSync('.github/workflows/image.yml', 'utf8')
const d2 = readFileSync('.github/workflows/cd-deploy.yml', 'utf8')
const c00sh = readFileSync('deploy/cd/c00.sh', 'utf8')

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

  it('confirm and rollback decide inside c00.sh, under the lock, not in a step before it (CHE-5549 review)', () => {
    const confirm = job(d2, 'readback-confirm')
    expect(confirm).toMatch(/needs: \[admit, deploy, readback-delay\]/)
    const rb = job(d2, 'rollback')
    // A workflow step before c00.sh would decide before the flock is taken, on a state that can change.
    for (const j of [confirm, rb]) expect(j).not.toContain('deploy-gate.mjs')
    expect(rb).toMatch(/if: \$\{\{ always\(\) && /)
    for (const op of ['confirm', 'rollback']) {
      const body = new RegExp(`^  ${op}\\)\\n([\\s\\S]*?)^    ;;`, 'm').exec(c00sh)?.[1] ?? ''
      expect(body, op).not.toBe('')
      const lock = body.indexOf('take_lock')
      const quiet = body.indexOf('require_quiescent')
      const gate = body.indexOf(`gate_recheck ${op}`)
      expect(lock, `${op} takes the lock`).toBeGreaterThan(-1)
      expect(quiet, `${op} proves quiescence after the lock`).toBeGreaterThan(lock)
      expect(gate, `${op} rechecks after quiescence`).toBeGreaterThan(quiet)
      // Whatever the train switch says: a migration can run with it off, so the proof is never conditional.
      expect(body.slice(lock, gate)).not.toMatch(/train_on/)
      if (op === 'rollback') {
        for (const change of ['compose_up', 'docker image inspect']) expect(body.indexOf(change)).toBeGreaterThan(gate)
      }
    }
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
  ])('%s writes the marker with a GitHub App token from the ci-app-token environment', (_n, j) => {
    expect(j).toMatch(/environment: ci-app-token/)
    // The c00-multicado App already lives there; no new App or environment (CHE-9181).
    expect(j).toContain('app-id: ${{ secrets.C00_MULTICADO_APP_ID }}')
    expect(j).toContain('private-key: ${{ secrets.C00_MULTICADO_CI_PRIVATE_KEY }}')
    expect(j).not.toMatch(/doop-deploy-marker|DOOP_MARKER_APP/)
    expect(j).toMatch(/uses: actions\/create-github-app-token@[0-9a-f]{40}/)
    expect(j).toContain('permission-actions-variables: write')
    expect(j).toContain('repositories: doop')
    // The token is minted before the first marker write. Deploy and confirm mint before their checks, which read
    // variables, and `github.token` cannot (CHE-9181): the gate gets it as VARS_TOKEN, the marker writer as
    // GH_TOKEN. Rollback mints before its check, which runs even if the mint fails (see below). Confirm and rollback
    // run their check inside c00.sh, under the lock; deploy still runs the pre-arm check in the workflow.
    const check = _n === 'deploy' ? 'deploy-gate.mjs recheck' : `c00.sh ${_n === 'rollback' ? 'rollback' : 'confirm'}`
    expect(at(j, 'create-github-app-token')).toBeLessThan(at(j, 'deploy-marker.mjs'))
    expect(at(j, 'create-github-app-token')).toBeLessThan(at(j, check))
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
      expect(job(d2, name)).not.toContain('ci-app-token')
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
    expect(restore).toBeGreaterThan(at(confirm, 'c00.sh confirm'))
    const step = confirm.slice(confirm.lastIndexOf('- name:', restore))
    expect(step).toMatch(/if: \$\{\{ env\.DEPLOY_MODE == 'train' \}\}/)
    expect(step).not.toMatch(/always\(\)|failure\(\)|cancelled\(\)|continue-on-error/)
    expect(step).toContain('MARKER_EXPECT')
    expect(confirm.slice(restore + 1)).not.toContain('\n      - name:')
  })

  it('rollback is one c00.sh step that decides under the lock; it suspends over its own arm after it', () => {
    const suspendAt = at(rollback, 'deploy-marker.mjs suspend')
    const rollbackAt = at(rollback, 'c00.sh rollback')
    expect(suspendAt).toBeGreaterThan(rollbackAt)
    expect(rollback.match(/c00\.sh rollback/g)).toHaveLength(1)
    const rbStep = rollback.slice(rollback.lastIndexOf('- name:', rollbackAt), rollbackAt)
    expect(rbStep).toContain('id: rollback')
    expect(rbStep).toMatch(/\n\s+if: \$\{\{ !cancelled\(\) \}\}\n/) // runs after a failed mint; never skipped by a decision made before the lock
    expect(rbStep).toMatch(/MARKER_EXPECT: \$\{\{ needs\.deploy\.outputs\.marker \}\}/)
    expect(rollback).toMatch(/action: \$\{\{ steps\.rollback\.outputs\.action \}\}/)
    expect(rollback).not.toContain('steps.check')
    const step = rollback.slice(rollback.lastIndexOf('- name:', suspendAt))
    expect(step).toMatch(/if: \$\{\{ !cancelled\(\) && steps\.rollback\.outputs\.go == 'true' \}\}/)
    expect(step).toContain('MARKER_EXPECT')
    expect(rollback).not.toMatch(/deploy-marker\.mjs (arm|restore)/)
    // A failed token mint can never keep a broken deploy from rolling back: it comes before the rollback (whose check
    // reads the marker, CHE-9181), the rollback step runs after it (!cancelled()), the job still fails, and the check
    // then decides from C00 alone. The suspend step needs the token and fails loudly without it.
    const mint = rollback.slice(rollback.lastIndexOf('- name:', at(rollback, 'create-github-app-token')))
    expect(mint).not.toContain('continue-on-error')
    expect(mint).toMatch(/if: \$\{\{ !cancelled\(\) \}\}/)
    expect(at(rollback, 'create-github-app-token')).toBeLessThan(at(rollback, 'c00.sh rollback'))
    expect(rbStep).toMatch(/VARS_TOKEN: \$\{\{ steps\.app\.outputs\.token \}\}/)
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

describe('D2 S5: readback delay, confirm, rollback, evidence (CHE-5549, C-9, C-12)', () => {
  const deploy = job(d2, 'deploy')
  const delay = job(d2, 'readback-delay')
  const confirm = job(d2, 'readback-confirm')
  const rollback = job(d2, 'rollback')
  const evidence = job(d2, 'evidence')
  const at = (j: string, needle: string) => {
    const i = j.indexOf(needle)
    expect(i, needle).toBeGreaterThan(-1)
    return i
  }

  it('readback-delay waits in the c00-readback-delay environment on a hosted runner, so it holds no C00 runner', () => {
    expect(delay).toMatch(/environment: c00-readback-delay/)
    expect(delay).toMatch(/runs-on: ubuntu-latest/)
    expect(delay).not.toContain('cheese-c00-deploy')
    expect(delay).not.toMatch(/concurrency:/)
    expect(delay).toMatch(/needs: \[admit, deploy\]/)
    expect(delay).toContain("needs.deploy.result == 'success'")
    expect(delay).toContain("needs.deploy.outputs.attempted == 'true'")
    expect(delay).not.toMatch(/ci-app-token|secrets\./)
  })

  it('confirm follows the delay, under the lock group, and runs the checks before the restore', () => {
    expect(confirm).toContain("needs.readback-delay.result == 'success'")
    const cmd = at(confirm, 'c00.sh confirm')
    expect(at(confirm, 'deploy-marker.mjs restore')).toBeGreaterThan(cmd)
    // The in-lock confirm check compares the marker with this run's own value.
    expect(confirm.slice(confirm.lastIndexOf('- name:', cmd), cmd)).toMatch(
      /MARKER_EXPECT: \$\{\{ needs\.deploy\.outputs\.marker \}\}/,
    )
    expect(confirm).toMatch(/RESTART_T0: \$\{\{ needs\.deploy\.outputs\.restart_count \}\}/)
    expect(confirm).toMatch(/T0_EPOCH: \$\{\{ needs\.deploy\.outputs\.t0_epoch \}\}/)
    expect(confirm).toMatch(/outputs:[\s\S]*restart_count_confirm:[\s\S]*confirmed_epoch:/)
  })

  it('the deploy job reports T0, the lock wait and the predecessor for the later jobs and the evidence', () => {
    for (const o of ['restart_count:', 'health:', 't0_epoch:', 'lock_wait_seconds:', 'predecessor_sha:'])
      expect(deploy, o).toMatch(new RegExp(`outputs:[\\s\\S]*${o}`))
    expect(deploy).toMatch(/- name: Read back[\s\S]*id: readback/)
  })

  it('rollback also runs after a failed delay, reads back the predecessor, and fails the run', () => {
    expect(rollback).toMatch(/needs: \[admit, deploy, readback-delay, readback-confirm\]/)
    expect(rollback).toContain("needs.readback-delay.result == 'failure'")
    expect(rollback).toMatch(/PREDECESSOR_SHA: \$\{\{ needs\.deploy\.outputs\.predecessor_sha \}\}/)
    expect(rollback).toMatch(/outputs:[\s\S]*action:[\s\S]*applied:/)
    const suspend = at(rollback, 'deploy-marker.mjs suspend')
    const last = rollback.slice(rollback.lastIndexOf('- name:'))
    expect(rollback.lastIndexOf('- name:')).toBeGreaterThan(suspend)
    expect(last).toMatch(/if: \$\{\{ !cancelled\(\) \}\}/)
    expect(last).toMatch(/exit 1/)
  })

  it('evidence runs on every run, hosted, with no deploy power, and writes deploy-evidence.json and the summary', () => {
    expect(evidence).toMatch(/needs: \[resolve, admit, deploy, readback-delay, readback-confirm, rollback\]/)
    expect(evidence).toMatch(/if: \$\{\{ always\(\) && /)
    expect(evidence).toMatch(/runs-on: ubuntu-latest/)
    expect(evidence).not.toMatch(/cheese-c00-deploy|environment:|secrets\.|create-github-app-token|deploy-marker/)
    expect(evidence).toContain('scripts/deploy-evidence.mjs deploy-evidence.json')
    expect(evidence).toMatch(/actions\/upload-artifact@[0-9a-f]{40}/)
    expect(evidence).toContain('name: deploy-evidence')
    for (const need of ['deploy', 'readback-delay', 'readback-confirm', 'rollback'])
      expect(evidence).toContain(`needs.${need}.result`)
    for (const line of evidence.split('\n').filter((l) => /^\s+run:/.test(l))) expect(line).not.toContain('${{')
  })

  it('evidence does not decide a run it did not see: it never fails the run itself', () => {
    expect(evidence).not.toMatch(/continue-on-error/)
    expect(evidence).toMatch(/timeout-minutes: \d+/)
  })

  it('the delay wait is not a C00 job: the lock group and the marker environment stay on the C00 jobs (the lift job is the fourth)', () => {
    expect(d2.match(/group: c00-deploy-doop/g)).toHaveLength(4)
    expect(d2.match(/environment: ci-app-token/g)).toHaveLength(3)
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
