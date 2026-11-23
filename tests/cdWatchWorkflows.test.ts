import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/* CHE-5550 (train S7, plan CHE-5474 C-7). `yaml` is only a transitive dependency, so assert on the text: each
   check names a property the plan requires of one of the two watchers. The decisions themselves are tested
   in cdWatch.test.ts. */
const read = (f: string) => (existsSync(f) ? readFileSync(f, 'utf8') : '')
const freshness = read('.github/workflows/cd-freshness-watch.yml')
const live = read('.github/workflows/cd-live-revision.yml')
const noComments = (s: string) => s.replace(/^\s*#.*$/gm, '')

describe('cd-freshness-watch.yml (C-7.1)', () => {
  it('exists, is classified scheduled, and fires at :12 :27 :42 :57', () => {
    expect(freshness).not.toBe('')
    expect(freshness).toMatch(/^# ci-policy: class=scheduled$/m)
    expect(freshness).toMatch(/cron: '12,27,42,57 \* \* \* \*'/)
  })

  it('runs on a GitHub-hosted runner, so a dead deploy runner cannot silence it', () => {
    expect(freshness).toMatch(/runs-on: ubuntu-24\.04/)
    expect(noComments(freshness)).not.toMatch(/self-hosted|c00/i)
  })

  it('has no concurrency group and no PR or push trigger', () => {
    const body = noComments(freshness)
    expect(body).not.toContain('concurrency:')
    expect(body).not.toMatch(/pull_request|push:|merge_group/)
  })

  it('takes the least token permissions that can dispatch and rerun: actions write, contents read', () => {
    expect(freshness).toMatch(/permissions:\s*\n\s*contents: read\s*\n\s*actions: write/)
  })

  it('acts as github-actions[bot] through the workflow token, the identity D2 admits for schedule_backup', () => {
    expect(freshness).toMatch(/GH_TOKEN: \$\{\{ github\.token \}\}/)
    expect(noComments(freshness)).not.toMatch(/secrets\./)
  })

  it('may read the deployment record: deployments read', () => {
    expect(freshness).toMatch(/permissions:[\s\S]*\n\s*deployments: read/)
  })

  it('reads the switch from the repo variable and runs the decision script', () => {
    expect(freshness).toMatch(/DOOP_DEPLOY_TRAIN: \$\{\{ vars\.DOOP_DEPLOY_TRAIN \}\}/)
    expect(freshness).toContain('node scripts/cd-watch.mjs freshness')
  })
})

describe('cd-live-revision.yml (C-7.2)', () => {
  it('exists, is classified scheduled, and runs on a schedule only', () => {
    expect(live).not.toBe('')
    expect(live).toMatch(/^# ci-policy: class=scheduled$/m)
    expect(live).toMatch(/schedule:\s*\n\s*- cron: '/)
    expect(noComments(live)).not.toMatch(/workflow_dispatch|pull_request|push:|merge_group/)
  })

  it('runs on the tailnet gate runner cheese-x99-gate, never the deploy runner', () => {
    expect(live).toContain('cheese-x99-gate')
    expect(live).not.toMatch(/cheese-c00-deploy/)
  })

  it('reads the C00 host from a repo variable and checks the live revision with the script', () => {
    expect(live).toMatch(/DOOP_C00_HOST: \$\{\{ vars\.DOOP_C00_HOST \}\}/)
    expect(live).toContain('node scripts/cd-watch.mjs live')
  })

  it('holds a full clone, so the live SHA can be placed against the last deployed SHA', () => {
    expect(live).toMatch(/fetch-depth: 0/)
  })

  it('is read only: contents and actions read, no deploy secret, no build', () => {
    expect(live).toMatch(/permissions:\s*\n\s*contents: read\s*\n\s*actions: read/)
    expect(noComments(live)).not.toMatch(/secrets\.|docker (build|push)|build-push-action|actions: write/)
  })

  it('may read the deployment record: deployments read', () => {
    expect(live).toMatch(/permissions:[\s\S]*\n\s*deployments: read/)
  })

  it('reads the switch from the repo variable', () => {
    expect(live).toMatch(/DOOP_DEPLOY_TRAIN: \$\{\{ vars\.DOOP_DEPLOY_TRAIN \}\}/)
  })
})

describe('D2 records each confirmed deploy durably (the last successful D2 SHA outlives artifacts and skipped runs)', () => {
  const d2 = read('.github/workflows/cd-deploy.yml')
  const evidence = d2.slice(d2.indexOf('\n  evidence:'))

  it('the evidence job writes the deployment record with the workflow token, hosted, after the evidence', () => {
    expect(evidence).toMatch(/permissions:\s*\n\s*contents: read\s*\n\s*deployments: write/)
    expect(evidence).toContain('node scripts/cd-watch.mjs record deploy-evidence.json')
    expect(evidence).toMatch(/GH_TOKEN: \$\{\{ github\.token \}\}/)
    expect(evidence.indexOf('cd-watch.mjs record')).toBeGreaterThan(evidence.indexOf('deploy-evidence.mjs'))
    expect(evidence).toMatch(/runs-on: ubuntu-latest/)
  })
})

describe('both watchers ship before the switch', () => {
  it('neither workflow nor the repo turns the train on', () => {
    for (const wf of [freshness, live]) expect(noComments(wf)).not.toMatch(/DOOP_DEPLOY_TRAIN:\s*['"]?on\b/)
  })

  it('the deploy README names the watchers and makes a green scheduled run of each a precondition of the switch', () => {
    const readme = read('deploy/cd/README.md')
    expect(readme).toContain('cd-freshness-watch.yml')
    expect(readme).toContain('cd-live-revision.yml')
    expect(readme).toMatch(/before .*DOOP_DEPLOY_TRAIN.*on/is)
  })
})
