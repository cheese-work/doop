import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/* Text assertions on the `lift` job of `cd-deploy.yml` (CHE-5551, train S3b, plan CHE-5474 C-10.7; folded into the one
   workflow the C00 runner group allows, CHE-10091): dispatch only, an allowlisted dispatcher, one C00 job under the
   deploy lock, no human-typed command, no value inlined into a script. */
const deploy = readFileSync('.github/workflows/cd-deploy.yml', 'utf8')

/* The text of one top-level job, up to the next job or end of file. */
function job(wf: string, name: string): string {
  const m = new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [a-z][a-z0-9-]*:\\n|(?![\\s\\S]))`, 'm').exec(wf)
  if (!m?.[1]) throw new Error(`no job ${name}`)
  return m[1]
}
const lift = job(deploy, 'lift')
const on = /^on:\n([\s\S]*?)(?=^\S)/m.exec(deploy)?.[1] ?? ''

/* The text of one step, by its `name:`, up to the next step. */
function step(name: string): string {
  const parts = lift.split(/^ {6}- /m)
  const hit = parts.find((p) => p.startsWith(`name: ${name}\n`) || p.includes(`\n          name: ${name}\n`))
  if (!hit) throw new Error(`no step ${name}`)
  return hit
}
const stepNames = [...lift.matchAll(/^ {6}- name: (.+)$/gm)].map((m) => m[1] ?? '')

describe('cd-deploy.yml lift mode: triggers', () => {
  it('is reached by manual dispatch with mode lift, never by the schedule', () => {
    expect(deploy).toMatch(/^# ci-policy: class=deploy$/m)
    expect(on).toMatch(/^ {6}mode:[\s\S]*?^ {10}- lift$/m)
    expect(lift).toMatch(/^ {4}if: .*github\.event_name == 'workflow_dispatch'.*inputs\.mode == 'lift'/m)
  })

  it('takes one lift input, decision_id: a string that the lift job passes on', () => {
    expect(on).toMatch(/^ {6}decision_id:\n(?: {8}.*\n)*? {8}type: string/m)
    // Only the lift reads it; the train modes ignore it, so it cannot be required of a scheduled or train dispatch.
    expect(on).not.toMatch(/decision_id:\n(?: {8}.*\n)*? {8}required: true/)
  })

  it('reads contents only at workflow level', () => {
    expect(deploy).toMatch(/^permissions:\n {2}contents: read\n/m)
  })

  it('no other job runs in lift mode: the train jobs are skipped, so one dispatch is one lift', () => {
    for (const name of ['resolve', 'evidence']) expect(job(deploy, name)).toMatch(/^ {4}if: .*inputs\.mode != 'lift'/m)
    // admit, deploy, readback-delay, readback-confirm and rollback follow resolve through `needs`.
    expect(job(deploy, 'resolve')).toContain("github.repository == 'cheese-work/doop'")
  })
})

describe('cd-deploy.yml lift job', () => {
  it('runs on the C00 deploy runner, in the deploy lock group that is never cancelled', () => {
    expect(lift).toContain('runs-on: [self-hosted, cheese-c00-deploy]')
    expect(lift).toMatch(/concurrency:\n {6}group: c00-deploy-doop\n {6}cancel-in-progress: false/)
  })

  it('is one job, and it runs only in this repository, from the default branch', () => {
    const jobs = [...deploy.matchAll(/^ {2}([a-z][a-z0-9-]*):\n/gm)].map((m) => m[1])
    expect(jobs.filter((j) => j === 'lift')).toEqual(['lift'])
    expect(lift).toContain("github.repository == 'cheese-work/doop'")
    // A dispatch from a branch would run that branch's lift script: only the default branch lifts.
    expect(lift).toContain("github.ref == 'refs/heads/cheese/main'")
  })

  it('uses the doop-lift environment, which holds the decision read secrets', () => {
    expect(lift).toMatch(/^ {4}environment: doop-lift$/m)
    for (const s of ['DOOP_LIFT_DECISION_READ_TOKEN', 'DOOP_LIFT_MULTICA_SERVER_URL', 'DOOP_LIFT_MULTICA_WORKSPACE_ID'])
      expect(lift).toContain(`secrets.${s}`)
  })

  it('names the approver and the dispatchers as repository variables', () => {
    expect(lift).toContain('vars.DOOP_LIFT_APPROVER_ID')
    expect(lift).toContain('vars.DOOP_LIFT_DISPATCHERS')
  })

  it('never inlines an input, a variable or a secret into a script: values go through env', () => {
    for (const line of lift.split('\n').filter((l) => /^\s+run:/.test(l))) expect(line).not.toContain('${{')
    // A multi-line run block is checked as a whole.
    for (const m of lift.matchAll(/^\s+run: \|\n((?:\s{10,}.*\n?)+)/gm)) expect(m[1]).not.toContain('${{')
  })

  it('passes the decision id through env only, never into a command line', () => {
    expect(lift).toMatch(/DECISION_ID: \$\{\{ inputs\.decision_id \}\}/)
    expect(lift.match(/inputs\.decision_id/g)).toHaveLength(1)
  })

  it('has no human-typed command: every action is a script in this repository', () => {
    const runs = [...lift.matchAll(/^\s+run: (.+)$/gm)].map((m) => m[1] ?? '')
    for (const r of runs) expect(r).toMatch(/^(node scripts\/deploy-lift\.mjs |bash deploy\/cd\/c00\.sh |\|)/)
  })

  it('does not build, pull or start anything', () => {
    expect(lift).not.toMatch(/docker (build|pull|run|compose)|npm (ci|install)|bun /)
  })
})

describe('cd-deploy.yml lift job: step order', () => {
  it('admits the dispatcher first; the marker token is minted only after, and the lift runs last of the C00 steps', () => {
    const at = (n: string) => stepNames.indexOf(n)
    expect(at('Admit the dispatcher')).toBeGreaterThanOrEqual(0)
    expect(at('Admit the dispatcher')).toBeLessThan(at('Mint the marker token'))
    expect(at('Mint the marker token')).toBeLessThan(at('Sweep the compat sandboxes'))
    expect(at('Sweep the compat sandboxes')).toBeLessThan(at('Lift on C00'))
    expect(at('Lift on C00')).toBeLessThan(at('Upload the lift evidence'))
  })

  it('checks out the default branch’s code without keeping the token, before anything runs', () => {
    expect(lift).toMatch(/uses: actions\/checkout@v4\n\s+with:\n\s+persist-credentials: false/)
    expect(stepNames.indexOf('Admit the dispatcher')).toBeGreaterThan(-1)
    expect(lift.indexOf('actions/checkout@v4')).toBeLessThan(lift.indexOf('Admit the dispatcher'))
  })

  it('admits by the actor and the triggering login against the allowlist, before any secret is read', () => {
    const s = step('Admit the dispatcher')
    expect(s).toContain('ACTOR: ${{ github.actor }}')
    expect(s).toContain('TRIGGER: ${{ github.triggering_actor }}')
    expect(s).toContain('DISPATCHERS: ${{ vars.DOOP_LIFT_DISPATCHERS }}')
    expect(s).toContain('run: node scripts/deploy-lift.mjs admit')
    expect(s).not.toContain('secrets.')
  })

  it('mints the marker token for variables only, pinned like D2', () => {
    const s = step('Mint the marker token')
    expect(s).toContain('actions/create-github-app-token@64ab729a6294000f5aa4a4bc0b73d1f32bc45510 # v3.3.0')
    expect(s).toContain('permission-actions-variables: write')
    expect(s).toContain('repositories: doop')
    expect(s).toContain('DOOP_MARKER_APP_KEY')
  })

  it('sweeps first (C-5, C-8.5d), then lifts under the host lock with c00.sh', () => {
    expect(step('Sweep the compat sandboxes')).toContain('run: bash deploy/cd/c00.sh sweep')
    expect(step('Lift on C00')).toContain('run: bash deploy/cd/c00.sh lift')
  })

  it('gives the lift the marker token, the read token and every id it checks, and nothing broader', () => {
    const s = step('Lift on C00')
    for (const v of [
      'GH_TOKEN: ${{ steps.app.outputs.token }}',
      'REPO: ${{ github.repository }}',
      'RUN_ID: ${{ github.run_id }}',
      'LIFTER: ${{ github.triggering_actor }}',
      'DECISION_ID: ${{ inputs.decision_id }}',
      'APPROVER_ID: ${{ vars.DOOP_LIFT_APPROVER_ID }}',
      'MULTICA_SERVER_URL: ${{ secrets.DOOP_LIFT_MULTICA_SERVER_URL }}',
      'MULTICA_WORKSPACE_ID: ${{ secrets.DOOP_LIFT_MULTICA_WORKSPACE_ID }}',
      'DECISION_READ_TOKEN: ${{ secrets.DOOP_LIFT_DECISION_READ_TOKEN }}',
      'HEALTHZ_URL:',
    ])
      expect(s).toContain(v)
    expect(s).not.toContain('github.token')
  })

  it('uploads lift-evidence.json whatever happened, and never the token', () => {
    const s = step('Upload the lift evidence')
    expect(s).toContain('if: ${{ always() }}')
    expect(s).toContain('uses: actions/upload-artifact@')
    expect(s).toContain('lift-evidence.json')
    expect(s).not.toMatch(/secrets\.|token/i)
  })
})

describe('cd-deploy.yml lift job: the train switch stays off', () => {
  it('does not read or write DOOP_DEPLOY_TRAIN, and writes no marker but the lift’s own', () => {
    const code = lift
      .split('\n')
      .filter((l) => !/^\s*#/.test(l))
      .join('\n')
    expect(code).not.toContain('DOOP_DEPLOY_TRAIN')
    expect(code).not.toMatch(/deploy-marker\.mjs/)
  })
})
