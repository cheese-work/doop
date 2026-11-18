import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

const DIGEST = `sha256:${'a'.repeat(64)}`
const SHA = 'b'.repeat(40)
const base = {
  IMAGE: 'ghcr.io/cheese-work/doop',
  DIGEST,
  SHA,
  RUN_URL: 'https://github.com/cheese-work/doop/actions/runs/1',
  INVENTORY_SHA: 'c'.repeat(64),
  D1_RUN_ID: '1',
}

const dir = mkdtempSync(path.join(tmpdir(), 'doop-image-evidence-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

function run(env: Record<string, string>) {
  const out = path.join(dir, 'evidence.json')
  execFileSync(process.execPath, ['scripts/image-evidence.mjs', out], {
    env: { PATH: process.env.PATH, ...env },
    stdio: 'pipe',
  })
  return JSON.parse(readFileSync(out, 'utf8')) as Record<string, string>
}

describe('image evidence', () => {
  it('records the pullable digest reference, source SHA, run URL, migration inventory and D1 run id', () => {
    expect(run(base)).toEqual({
      image: base.IMAGE,
      digest: DIGEST,
      ref: `${base.IMAGE}@${DIGEST}`,
      sha: SHA,
      run_url: base.RUN_URL,
      migration_inventory_sha: base.INVENTORY_SHA,
      d1_run_id: '1',
    })
  })

  it.each([
    ['empty digest (failed push)', { DIGEST: '' }],
    ['tag instead of digest', { DIGEST: 'latest' }],
    ['short SHA', { SHA: 'abc123' }],
    ['missing run URL', { RUN_URL: '' }],
    ['missing inventory sha', { INVENTORY_SHA: '' }],
    ['non-numeric D1 run id', { D1_RUN_ID: 'abc' }],
  ])('refuses to write evidence for %s', (_name, bad) => {
    expect(() => run({ ...base, ...bad })).toThrow()
  })
})
