import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/* `yaml` is only a transitive dependency, so assert on the text: each check
   names a property CHE-4584 requires of the image pipeline. */
const wf = readFileSync('.github/workflows/image.yml', 'utf8')
const ci = readFileSync('.github/workflows/ci.yml', 'utf8')

describe('image workflow', () => {
  it('runs only on pushes to cheese/main (and by hand), never on pull requests', () => {
    expect(wf).toMatch(/push:\s*\n\s*branches: \[cheese\/main\]/)
    expect(wf).toContain('workflow_dispatch')
    expect(wf).not.toContain('pull_request')
  })

  it('gates the image on the existing CI suite, reused rather than copied', () => {
    expect(wf).toContain('uses: ./.github/workflows/ci.yml')
    expect(ci).toMatch(/on:[\s\S]*workflow_call:/)
    expect(wf).toMatch(/needs: ci/)
  })

  it('builds the existing Dockerfile on a GitHub runner and pushes to GHCR', () => {
    expect(wf).toContain('runs-on: ubuntu-latest')
    expect(wf).toContain('docker/build-push-action@')
    expect(wf).toContain('ghcr.io/${{ github.repository }}')
    expect(wf).toContain('push: true')
    // The build never runs on a deploy host. Only the deploy job (slice B,
    // tests/deployWorkflow.test.ts) may name the C00 runner.
    const image = /^ {2}image:\n([\s\S]*?)(?=^ {2}[a-z][a-z0-9-]*:\n|(?![\s\S]))/m.exec(wf)?.[1] ?? ''
    expect(image).not.toMatch(/runs-on:.*(c00|self-hosted)/i)
  })

  it('takes least-privilege token permissions and never lets a fork push', () => {
    expect(wf).toContain('packages: write')
    expect(wf).toMatch(/permissions:\s*\n\s*contents: read/)
    expect(wf).toContain("github.repository == 'cheese-work/doop'")
  })

  it('gives every merge its own concurrency group, so a queued run is never replaced', () => {
    /* One shared group keeps at most one pending run: a third merge would
       cancel the second's pending run, and that SHA would get no image. */
    expect(wf).toMatch(/group: image-\$\{\{ github\.sha \}\}/)
    expect(wf).not.toMatch(/group: image-\$\{\{ github\.ref \}\}/)
    expect(wf).toContain('cancel-in-progress: false')
  })

  it('declares its ci-policy class: a per-SHA, never-cancelled publish is a deploy', () => {
    /* The base ci-policy gate (D-1) fails an unclassified workflow, and its
       main-build class forbids the per-SHA group above. */
    expect(wf).toMatch(/^# ci-policy: class=deploy$/m)
  })

  it('records digest and source SHA as an evidence artifact', () => {
    expect(wf).toContain('steps.build.outputs.digest')
    expect(wf).toContain('scripts/image-evidence.mjs')
    expect(wf).toContain('actions/upload-artifact@')
  })
})
