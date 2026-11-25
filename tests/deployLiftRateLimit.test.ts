import { describe, expect, it } from 'vitest'
// @ts-expect-error plain .mjs script, no type declarations
import { api, lift } from '../scripts/deploy-lift.mjs'

/* CHE-9860: the lift's own GitHub client (marker read and write) waits out a rate limit like deploy-marker.mjs does
   (CHE-9842) instead of failing the lift on the first 403. */
const limited = () =>
  new Response('{"message":"API rate limit exceeded"}', { status: 403, headers: { 'retry-after': '0' } })

describe('deploy-lift api', () => {
  it('retries a rate-limited read and returns the later success', async () => {
    const answers = [limited(), new Response('{"value":"clear:a:b"}', { status: 200 })]
    const seen: string[] = []
    const fetchImpl = async (url: string) => (seen.push(url), answers.shift()!)
    const out = await api('tok', fetchImpl)('repos/o/r/actions/variables/DOOP_DEPLOY_SUSPENDED')
    expect(out).toEqual({ value: 'clear:a:b' })
    expect(seen).toHaveLength(2)
  }, 10_000)

  it('fails at once on a plain 403', async () => {
    const fetchImpl = async () => new Response('{"message":"Resource not accessible"}', { status: 403 })
    await expect(api('tok', fetchImpl)('repos/o/r/x')).rejects.toMatchObject({ status: 403 })
  })

  it('returns a 404 without retry', async () => {
    let calls = 0
    const fetchImpl = async () => (calls++, new Response('{"message":"Not Found"}', { status: 404 }))
    await expect(api('tok', fetchImpl)('repos/o/r/actions/variables/GONE')).rejects.toMatchObject({ status: 404 })
    expect(calls).toBe(1)
  })

  it('stops after 3 requests on a rate limit that never clears, then fails closed', async () => {
    let calls = 0
    const fetchImpl = async () => (calls++, limited())
    await expect(api('tok', fetchImpl)('repos/o/r/x')).rejects.toMatchObject({ status: 403 })
    expect(calls).toBe(3)
  }, 10_000)
})

/* A rate-limited write waits, then must not clear the marker unless the decision still approves it. */
describe('deploy-lift rate-limited write', () => {
  const repo = 'cheese-work/doop'
  const now = new Date('2026-11-26T00:00:00Z')
  const original = `suspended:${'1'.repeat(32)}:123:${'a'.repeat(40)}:operator`

  const run = async (change: (n: number) => { revoked?: boolean; expires?: string }) => {
    let marker = original
    let patches = 0
    let state = { revoked: false, expires: '2026-11-26T01:00:00Z' }
    const gh = async (url: string, init: { method?: string; body?: string } = {}) => {
      if (init.method === 'PATCH') {
        patches++
        if (patches === 1) {
          state = { ...state, ...change(patches) }
          return limited()
        }
        marker = JSON.parse(init.body!).value
        return Response.json({})
      }
      return Response.json({ value: marker })
    }
    const fetchImpl = async (url: string) => {
      if (!url.includes('/api/decisions/')) return new Response('', { status: 200 })
      return Response.json({
        decision_id: 'decision-123',
        action_id: 'action-123',
        action_type: 'doop.deploy_lift',
        action_version: 1,
        state: 'approved',
        approver_id: 'cheese',
        answered_at: '2026-11-25T23:59:00Z',
        withdrawn_at: null,
        revoked_at: state.revoked ? now.toISOString() : null,
        expires_at: state.expires,
        params: { repo, marker_value: original },
      })
    }
    const result = await lift({
      ghApi: api('tok', gh),
      fetchImpl,
      repo,
      runId: '456',
      lifter: 'tester',
      decisionId: 'decision-123',
      approverId: 'cheese',
      server: 'https://multica.test',
      workspace: 'ws',
      token: 'read',
      healthzUrl: 'https://health.test',
      now: () => now,
      facts: {
        quiescent: true,
        digest: `sha256:${'b'.repeat(64)}`,
        revision: 'a'.repeat(40),
        containerHealth: 'healthy',
      },
    })
    return { result, marker, patches }
  }

  it('lifts after one rate-limited write when the approval still stands', async () => {
    const { result, marker, patches } = await run(() => ({}))
    expect(result.outcome).toBe('lifted')
    expect(marker.startsWith('clear:')).toBe(true)
    expect(patches).toBe(2)
  }, 10_000)

  it('refuses and leaves the marker when the approval is revoked during the wait', async () => {
    const { result, marker, patches } = await run(() => ({ revoked: true }))
    expect(result.outcome).toBe('refused')
    expect(result.reason).toMatch(/revoked/)
    expect(marker).toBe(original)
    expect(patches).toBe(1)
  }, 10_000)

  it('refuses and leaves the marker when the approval expires during the wait', async () => {
    const { result, marker, patches } = await run(() => ({ expires: '2026-11-26T00:00:00Z' }))
    expect(result.outcome).toBe('refused')
    expect(result.reason).toMatch(/expired/)
    expect(marker).toBe(original)
    expect(patches).toBe(1)
  }, 10_000)
})
