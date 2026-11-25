import { afterEach, describe, expect, it, vi } from 'vitest'
// @ts-expect-error plain .mjs script, no type declarations
import { fetchRead } from '../scripts/lib/gh-fetch.mjs'

/* CHE-9861: CD deploy failed closed on a GitHub rate-limit 403 during confirm and rollback. Reads now ride out a
   short limit; a long one (exhausted hourly budget) still fails closed. */
const res = (status: number, headers: Record<string, string> = {}) => new Response('{}', { status, headers })
const calls = (...rs: Response[]) =>
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => rs.shift()!),
  )
afterEach(() => vi.unstubAllGlobals())

describe('fetchRead', () => {
  it('retries a 403 with retry-after and returns the later success', async () => {
    calls(res(403, { 'retry-after': '2' }), res(200))
    const waits: number[] = []
    const r = await fetchRead('u', {}, { sleep: async (s: number) => void waits.push(s) })
    expect(r.status).toBe(200)
    expect(waits).toEqual([2])
  })
  it('retries a 403 whose x-ratelimit-reset is near, and a 502', async () => {
    calls(res(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1010' }), res(502), res(200))
    const waits: number[] = []
    const r = await fetchRead('u', {}, { sleep: async (s: number) => void waits.push(s), now: () => 1_000_000 })
    expect(r.status).toBe(200)
    expect(waits).toEqual([10, 5])
  })
  it('does not wait out an exhausted hourly budget: returns the 403 so the caller fails closed', async () => {
    calls(res(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '4600' }))
    const r = await fetchRead(
      'u',
      {},
      {
        sleep: async () => {
          throw new Error('slept')
        },
        now: () => 1_000_000,
      },
    )
    expect(r.status).toBe(403)
  })
  it('does not retry a plain 403 or a 404', async () => {
    calls(res(403), res(404))
    expect(
      (
        await fetchRead(
          'u',
          {},
          {
            sleep: async () => {
              throw new Error('slept')
            },
          },
        )
      ).status,
    ).toBe(403)
    expect(
      (
        await fetchRead(
          'u',
          {},
          {
            sleep: async () => {
              throw new Error('slept')
            },
          },
        )
      ).status,
    ).toBe(404)
  })
  it('gives up after 4 tries', async () => {
    const f = vi.fn(async () => res(429, { 'retry-after': '1' }))
    vi.stubGlobal('fetch', f)
    expect((await fetchRead('u', {}, { sleep: async () => {} })).status).toBe(429)
    expect(f).toHaveBeenCalledTimes(4)
  })
})
