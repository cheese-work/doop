import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error plain .mjs script, no type declarations
import { buildEvidence, ict, summaryOf } from '../scripts/deploy-evidence.mjs'

/* CHE-5549 (train S5, plan CHE-5474 C-12). Every D2 run writes deploy-evidence.json and a run summary. The
   inputs are job results and outputs, passed through env; nothing here talks to C00 or GitHub. */
const CAND = 'c'.repeat(40)
const PRED = 'b'.repeat(40)
const D_CAND = 'sha256:' + 'e'.repeat(64)
const D_PRED = 'sha256:' + 'd'.repeat(64)
const T0 = 1_795_000_000 // 2026-11-18 11:06:40 UTC
const base = {
  RUN_ID: '4242',
  RUN_ATTEMPT: '1',
  MODE: 'train',
  CANDIDATE: CAND,
  DIGEST: D_CAND,
  PREDECESSOR_SHA: PRED,
  PREDECESSOR_DIGEST: D_PRED,
  RESOLVE_RESULT: 'success',
  ADMIT_RESULT: 'success',
  DEPLOY_RESULT: 'success',
  DELAY_RESULT: 'success',
  CONFIRM_RESULT: 'success',
  ROLLBACK_RESULT: 'skipped',
  HEALTH: 'healthy',
  RESTART_COUNT: '0',
  RESTART_COUNT_CONFIRM: '0',
  T0_EPOCH: String(T0),
  CONFIRMED_EPOCH: String(T0 + 905),
  LOCK_WAIT_SECONDS: '3',
  NOW_EPOCH: String(T0 + 910),
}

describe('buildEvidence (C-12)', () => {
  it('a confirmed deploy carries the candidate, digest, health, readback, lock wait and both time zones', () => {
    const e = buildEvidence(base)
    expect(e).toMatchObject({
      outcome: 'confirmed',
      mode: 'train',
      candidate_sha: CAND,
      digest: D_CAND,
      health: 'healthy',
      lock_wait_seconds: 3,
      readback: { restart_count_t0: 0, restart_count_confirm: 0, delay_seconds: 905 },
    })
    expect(e.times.readback_t0).toEqual({ ict: '2026-11-18 18:06:40 ICT', utc: '2026-11-18T11:06:40Z' })
    expect(e.times.confirmed.utc).toBe('2026-11-18T11:21:45Z')
    expect(e.times.written.ict).toBe('2026-11-18 18:21:50 ICT')
  })

  it('ict() writes Asia/Bangkok wall time', () => {
    expect(ict(0)).toBe('1970-01-01 07:00:00 ICT')
  })

  it.each([
    [
      'rolled back',
      {
        CONFIRM_RESULT: 'skipped',
        ROLLBACK_RESULT: 'failure',
        ROLLBACK_ACTION: 'rollback',
        ROLLBACK_APPLIED: 'success',
      },
      'rolled_back',
    ],
    [
      'rollback itself failed',
      {
        CONFIRM_RESULT: 'skipped',
        ROLLBACK_RESULT: 'failure',
        ROLLBACK_ACTION: 'rollback',
        ROLLBACK_APPLIED: 'failure',
      },
      'rollback_failed',
    ],
    [
      'predecessor already running',
      { CONFIRM_RESULT: 'skipped', ROLLBACK_RESULT: 'failure', ROLLBACK_ACTION: 'none' },
      'predecessor_running',
    ],
    [
      'superseded',
      { CONFIRM_RESULT: 'skipped', ROLLBACK_RESULT: 'failure', ROLLBACK_ACTION: 'superseded' },
      'superseded',
    ],
    ['rollback check refused', { CONFIRM_RESULT: 'skipped', ROLLBACK_RESULT: 'failure' }, 'rollback_refused'],
    [
      'confirm failed, rollback after',
      {
        CONFIRM_RESULT: 'failure',
        ROLLBACK_RESULT: 'failure',
        ROLLBACK_ACTION: 'rollback',
        ROLLBACK_APPLIED: 'success',
      },
      'rolled_back',
    ],
    [
      'failed before any change',
      { DEPLOY_RESULT: 'failure', DELAY_RESULT: 'skipped', CONFIRM_RESULT: 'skipped' },
      'failed_before_change',
    ],
    [
      'no deploy (skip at resolve)',
      {
        RESOLVE_RESULT: 'success',
        ADMIT_RESULT: 'skipped',
        DEPLOY_RESULT: 'skipped',
        DELAY_RESULT: 'skipped',
        CONFIRM_RESULT: 'skipped',
      },
      'not_deployed',
    ],
  ])('outcome when %s', (_n, over, outcome) => {
    expect(buildEvidence({ ...base, ...over }).outcome).toBe(outcome)
  })

  it('a run that never reached C00 still writes evidence, with nothing invented', () => {
    const e = buildEvidence({
      RUN_ID: '1',
      RUN_ATTEMPT: '1',
      RESOLVE_RESULT: 'success',
      ADMIT_RESULT: 'skipped',
      DEPLOY_RESULT: 'skipped',
      DELAY_RESULT: 'skipped',
      CONFIRM_RESULT: 'skipped',
      ROLLBACK_RESULT: 'skipped',
      NOW_EPOCH: String(T0),
    })
    expect(e).toMatchObject({ outcome: 'not_deployed', candidate_sha: null, digest: null, lock_wait_seconds: null })
    expect(e.times.readback_t0).toBeNull()
  })

  it('drops any value that is not the shape it should be (nothing from a job output reaches the summary raw)', () => {
    const e = buildEvidence({
      ...base,
      CANDIDATE: 'x`\n## injected',
      DIGEST: 'latest',
      HEALTH: '<b>',
      LOCK_WAIT_SECONDS: 'NaN',
    })
    expect(e).toMatchObject({ candidate_sha: null, digest: null, health: null, lock_wait_seconds: null })
  })
})

describe('summaryOf and the CLI', () => {
  it('the run summary lists the read-back values, with ICT first and UTC beside it, for CHE-2752', () => {
    const md = summaryOf(buildEvidence(base))
    expect(md).toContain('confirmed')
    expect(md).toContain(CAND)
    expect(md).toContain(D_CAND)
    expect(md).toContain('2026-11-18 18:06:40 ICT (2026-11-18T11:06:40Z)')
    expect(md).toContain('CHE-2752')
  })

  it('writes deploy-evidence.json and appends the summary', () => {
    const dir = mkdtempSync(join(tmpdir(), 'evidence-'))
    try {
      const r = spawnSync('node', [resolve('scripts/deploy-evidence.mjs'), join(dir, 'deploy-evidence.json')], {
        encoding: 'utf8',
        env: { PATH: process.env.PATH, ...base, GITHUB_STEP_SUMMARY: join(dir, 'summary.md') },
      })
      expect(r.status, r.stderr).toBe(0)
      expect(JSON.parse(readFileSync(join(dir, 'deploy-evidence.json'), 'utf8')).candidate_sha).toBe(CAND)
      expect(readFileSync(join(dir, 'summary.md'), 'utf8')).toContain(CAND)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
