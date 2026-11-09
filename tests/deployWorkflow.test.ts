import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/* Text assertions (`yaml` is only transitive). Each names a property CHE-4585
   requires of the C00 deploy: security controls first. */
const wf = readFileSync('.github/workflows/image.yml', 'utf8')

/* The text of one top-level job, up to the next job or end of file. */
function job(name: string): string {
  const m = new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [a-z][a-z0-9-]*:\\n|(?![\\s\\S]))`, 'm').exec(wf)
  if (!m?.[1]) throw new Error(`no job ${name}`)
  return m[1]
}

describe('deploy chain lives in image.yml', () => {
  it('has gate and deploy jobs behind the image job, so it only ever runs from cheese/main', () => {
    expect(job('gate')).toMatch(/needs:.*\bimage\b/)
    expect(job('deploy')).toMatch(/needs:.*\bgate\b/)
    expect(wf).toMatch(/push:\s*\n\s*branches: \[cheese\/main\]/)
  })

  it('exposes the image digest as a job output', () => {
    expect(job('image')).toMatch(/outputs:\s*\n\s*digest: \$\{\{ steps\.build\.outputs\.digest \}\}/)
  })

  it('labels the image with the source SHA, which the readback checks', () => {
    expect(job('image')).toContain('org.opencontainers.image.revision=${{ github.sha }}')
  })

  it('keeps the build on a GitHub runner; only deploy touches the C00 runner', () => {
    expect(job('image')).toContain('runs-on: ubuntu-latest')
    expect(job('image')).not.toMatch(/runs-on:.*(self-hosted|c00)/i)
    expect(job('gate')).toContain('runs-on: ubuntu-latest')
    expect(job('deploy')).toContain('cheese-c00-deploy')
  })
})

describe('gate job (merge-actor allowlist, MAIN_RED_PAUSED)', () => {
  const gate = job('gate')

  it('decides with scripts/deploy-gate.mjs and publishes the verdict as a job output', () => {
    expect(gate).toContain('scripts/deploy-gate.mjs')
    expect(gate).toMatch(/outputs:\s*\n\s*authorized: \$\{\{ steps\.\w+\.outputs\.authorized \}\}/)
  })

  it('reads only; it holds no write permission and no deploy secret', () => {
    expect(gate).toMatch(/permissions:\s*\n\s*contents: read\s*\n\s*actions: read\s*\n\s*pull-requests: read/)
    expect(gate).not.toMatch(/: write/)
    expect(gate).not.toContain('secrets.')
  })

  it('passes event data through env, never inlined into the script', () => {
    for (const v of ['C00_DEPLOY_AUTHORIZERS', 'MAIN_RED_PAUSED']) expect(gate).toContain(`vars.${v}`)
    expect(gate).toContain('github.actor')
    expect(gate).not.toMatch(/run:[^\n]*\$\{\{/)
  })
})

describe('deploy job', () => {
  const deploy = job('deploy')

  it('runs only when the gate authorized, never on a fork', () => {
    expect(deploy).toContain("needs.gate.outputs.authorized == 'true'")
    expect(deploy).toContain("github.repository == 'cheese-work/doop'")
  })

  it('deploys the digest from this run, never a tag', () => {
    expect(deploy).toContain('needs.image.outputs.digest')
    expect(deploy).toContain('DEPLOY_REF')
    expect(deploy).not.toMatch(/:latest|ghcr\.io[^\n]*:\$\{\{ github\.sha/)
  })

  it('never builds on C00', () => {
    expect(deploy).not.toMatch(/docker\/build-push-action|docker build|buildx/)
    expect(deploy).not.toMatch(/uses: \.\/\.github\/workflows/)
  })

  it('applies, reads back, and on failure rolls back by digest then fails the run', () => {
    expect(deploy).toMatch(/c00\.sh apply/)
    expect(deploy).toMatch(/c00\.sh readback/)
    const rollback = deploy.indexOf('c00.sh rollback')
    expect(rollback).toBeGreaterThan(deploy.indexOf('c00.sh readback'))
    expect(deploy.slice(rollback - 400, rollback)).toMatch(/if: .*failure\(\)/)
  })

  it('rechecks suspension after the lock is held, before anything touches C00', () => {
    const recheck = deploy.indexOf('deploy-gate.mjs recheck')
    expect(recheck).toBeGreaterThan(deploy.indexOf('uses: actions/checkout@v4'))
    expect(recheck).toBeLessThan(deploy.indexOf('c00.sh apply'))
    expect(recheck).toBeLessThan(deploy.indexOf('docker login'))
    expect(deploy).toMatch(/actions: read/)
    expect(deploy).toMatch(/uses: actions\/setup-node@v4/)
    expect(deploy.slice(recheck - 500, recheck)).not.toMatch(/run:[^\n]*\$\{\{/)
  })

  it('rolls back only after this run captured its rollback target and tried the change', () => {
    expect(deploy).toMatch(/- name: Apply\n\s+id: apply\n/)
    const rollback = deploy.indexOf('c00.sh rollback')
    expect(deploy.slice(rollback - 400, rollback)).toMatch(
      /if: \$\{\{ failure\(\) && steps\.apply\.outputs\.attempted == 'true' \}\}/,
    )
  })

  it('serializes deploys and never cancels one midway', () => {
    expect(deploy).toMatch(/concurrency:\s*\n\s*group: c00-deploy-doop\s*\n\s*cancel-in-progress: false/)
  })

  it('pulls from GHCR with the job token and logs out afterwards, even on failure', () => {
    expect(deploy).toMatch(/packages: read/)
    expect(deploy).toContain('secrets.GITHUB_TOKEN')
    expect(deploy).toMatch(/if: always\(\)[\s\S]*docker logout ghcr\.io/)
  })

  it('has no checkout of untrusted code: it uses the SHA that was gated', () => {
    expect(deploy).toMatch(/uses: actions\/checkout@v4\s*\n\s*with:\s*\n\s*ref: \$\{\{ github\.sha \}\}/)
  })

  it('defaults the C00 compose dir to the real path, a repo variable still overrides', () => {
    expect(deploy).toContain("C00_COMPOSE_DIR: ${{ vars.C00_DOOP_COMPOSE_DIR || '/home/congvc/.local/share/doop' }}")
  })

  it('holds a hard timeout above the 15 minute readback window', () => {
    expect(deploy).toMatch(/timeout-minutes: (2\d|3\d)/)
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

describe('dispatch', () => {
  it('manual dispatch also passes the gate and the allowlist', () => {
    expect(wf).toContain('workflow_dispatch')
    expect(job('deploy')).toContain('needs.gate.outputs.authorized')
  })
})
