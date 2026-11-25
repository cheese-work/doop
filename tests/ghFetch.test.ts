import { afterEach, describe, expect, it, vi } from 'vitest'
// @ts-expect-error plain .mjs script, no type declarations
import { MAX_WAIT_MS, fetchRetry, rateLimitWaitMs } from '../scripts/lib/gh-fetch.mjs'

/* CHE-9862: the deploy gate and marker read DOOP_DEPLOY_SUSPENDED through the App token; a 403 rate limit
   failed three runs closed. A short limit is waited out; a long one (hourly quota) still fails closed. */
const res = (status: number, headers: Record<string, string> = {}) => new Response('{}', { status, headers })
const NOW = 1_000_000_000_000

afterEach(() => vi.unstubAllGlobals())

describe('rateLimitWaitMs', () => {
  it('reads Retry-After, then an exhausted quota reset; ignores other 403s and other statuses', () => {
    expect(rateLimitWaitMs(res(403, { 'retry-after': '5' }), NOW)).toBe(5000)
    expect(
      rateLimitWaitMs(res(429, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(NOW / 1000 + 10) }), NOW),
    ).toBe(11000)
    expect(rateLimitWaitMs(res(403), NOW)).toBeNull() // a permission 403
    expect(rateLimitWaitMs(res(403, { 'x-ratelimit-remaining': '12' }), NOW)).toBeNull()
    expect(rateLimitWaitMs(res(500, { 'retry-after': '5' }), NOW)).toBeNull()
  })
})

describe('fetchRetry', () => {
  const run = (responses: Response[]) => {
    const fetchMock = vi.fn(async () => responses.shift() as Response)
    vi.stubGlobal('fetch', fetchMock)
    const sleep = vi.fn(async () => {})
    return { fetchMock, sleep, call: () => fetchRetry('u', {}, { sleep, now: () => NOW }) }
  }
  it('waits out a short rate limit and returns the next response', async () => {
    const t = run([res(403, { 'retry-after': '2' }), res(200)])
    expect((await t.call()).status).toBe(200)
    expect(t.sleep).toHaveBeenCalledWith(2000)
  })
  it('gives up after 3 attempts', async () => {
    const t = run([
      res(403, { 'retry-after': '1' }),
      res(403, { 'retry-after': '1' }),
      res(403, { 'retry-after': '1' }),
    ])
    expect((await t.call()).status).toBe(403)
    expect(t.fetchMock).toHaveBeenCalledTimes(3)
  })
  it('does not wait for the hourly quota and does not retry a permission 403', async () => {
    const long = run([res(403, { 'retry-after': String(MAX_WAIT_MS / 1000 + 1) })])
    expect((await long.call()).status).toBe(403)
    expect(long.sleep).not.toHaveBeenCalled()
    const perm = run([res(403)])
    await perm.call()
    expect(perm.fetchMock).toHaveBeenCalledTimes(1)
  })
})
