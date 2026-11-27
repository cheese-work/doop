import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/* CHE-10091: the C00 runner group `c00-deploy` lists the workflow files that may use it. A workflow that asks for
   `cheese-c00-deploy` and is not on the list sits pending forever (CHE-9808: the separate `cd-lift.yml` did). Doop's
   entries are `cd-deploy.yml` and `image.yml`; only `cd-deploy.yml` holds C00 jobs (D1 holds none). The group is not
   edited from here, so a new C00 workflow must be folded into `cd-deploy.yml`.
   CHE-9957: `cd-preflight.yml` is the one exception. Its read-only `c00` job needs the group to list
   `cheese-work/doop/.github/workflows/cd-preflight.yml@refs/heads/cheese/main` (an org admin adds it before the merge).
   Until then the job stays queued and the report fails "C00 runner offline" at 10 minutes, by design (FP-01). */
const ALLOWED = ['cd-deploy.yml', 'cd-preflight.yml', 'image.yml']
const dir = '.github/workflows'
const code = (f: string) =>
  readFileSync(`${dir}/${f}`, 'utf8')
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n')
const workflows = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f))

describe('the C00 runner label stays inside the runner group allow-list', () => {
  it('no workflow outside the allow-list asks for cheese-c00-deploy', () => {
    const offenders = workflows.filter((f) => !ALLOWED.includes(f) && code(f).includes('cheese-c00-deploy'))
    expect(offenders).toEqual([])
  })

  it('cd-deploy.yml and cd-preflight.yml are the only workflows with C00 jobs, and the lift is in cd-deploy.yml', () => {
    expect(workflows.filter((f) => code(f).includes('cheese-c00-deploy'))).toEqual([
      'cd-deploy.yml',
      'cd-preflight.yml',
    ])
    expect(code('cd-deploy.yml')).toMatch(/^ {2}lift:\n/m)
  })

  it('cd-lift.yml is gone and nothing in the repository still points at it', () => {
    expect(existsSync(`${dir}/cd-lift.yml`)).toBe(false)
    const self = 'tests/c00RunnerAllowList.test.ts'
    const files = [
      '.context/RELEASE.md',
      '.context/TECHSTACK.md',
      'deploy/cd/README.md',
      'deploy/cd/c00.sh',
      'scripts/deploy-lift.mjs',
    ]
    for (const f of [
      ...workflows.map((w) => `${dir}/${w}`),
      ...readdirSync('tests', { withFileTypes: true })
        .filter((t) => t.isFile())
        .map((t) => `tests/${t.name}`),
      ...files,
    ])
      if (f !== self) expect(readFileSync(f, 'utf8'), f).not.toMatch(/cd-lift/)
  })
})
