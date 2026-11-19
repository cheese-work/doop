import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { SLOPLINT_SHA } from '../shared/designCompleteness.ts'
import { sloplintEntries } from '../server/sloplintInput.ts'

/* CHE-6854: doop accepts the reviewer's sloplint JSON with its SHA256 and keeps only what the digest vouches for. */

const JSON_OUT = JSON.stringify({ findings: [] })
const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const input = (over: Record<string, unknown> = {}) => ({
  frame_id: 'f1',
  updated_at: 5,
  tool_sha: SLOPLINT_SHA,
  result_json: JSON_OUT,
  sha256: sha(JSON_OUT),
  ...over,
})

describe('sloplintEntries', () => {
  it('keeps a result whose digest matches', () => {
    expect(sloplintEntries([input()])).toEqual([
      { frameId: 'f1', updatedAt: 5, toolSha: SLOPLINT_SHA, sha256: sha(JSON_OUT), status: 'ok', resultJson: JSON_OUT },
    ])
  })

  it('reads updated_at as an ISO time too, and compares the digest in any letter case', () => {
    const [e] = sloplintEntries([
      input({ updated_at: '1970-01-01T00:00:00.005Z', sha256: sha(JSON_OUT).toUpperCase() }),
    ])
    expect(e).toMatchObject({ updatedAt: 5, status: 'ok' })
  })

  it('marks NOT-RUN a result with no JSON, a wrong digest, or JSON that does not parse', () => {
    for (const over of [{ result_json: undefined }, { sha256: sha('other') }, { sha256: undefined }]) {
      expect(sloplintEntries([input(over)])[0]!.status, JSON.stringify(over)).toBe('NOT-RUN')
    }
    const bad = 'not json'
    expect(sloplintEntries([input({ result_json: bad, sha256: sha(bad) })])[0]!.status).toBe('NOT-RUN')
  })

  it('marks NOT-RUN a digest-matched result that is not a run of the tool: null, arrays, scalars, a NOT-RUN marker, no findings', () => {
    for (const bad of [
      'null',
      '[]',
      '3',
      '"ok"',
      '{}',
      '{"status":"NOT-RUN"}',
      '{"status":"not_run","findings":[]}',
      '{"findings":"none"}',
    ]) {
      const [e] = sloplintEntries([input({ result_json: bad, sha256: sha(bad) })])
      expect(e!.status, bad).toBe('NOT-RUN')
      expect(e!.resultJson, bad).toBeUndefined()
    }
  })

  it('keeps the verified result JSON on the entry so the attestation stores it', () => {
    const withFindings = JSON.stringify({ findings: [{ rule: 'x', line: 3 }], score: 63 })
    const [e] = sloplintEntries([input({ result_json: withFindings, sha256: sha(withFindings) })])
    expect(e).toMatchObject({ status: 'ok', resultJson: withFindings })
  })

  it('refuses an updated_at it cannot read', () => {
    expect(() => sloplintEntries([input({ updated_at: 'yesterday' })])).toThrow(/updated_at/)
  })
})
