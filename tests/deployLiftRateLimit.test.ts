import { describe, expect, it } from 'vitest'
// @ts-expect-error plain .mjs script, no type declarations
import { api } from '../scripts/deploy-lift.mjs'

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
})
