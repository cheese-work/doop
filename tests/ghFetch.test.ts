import { describe, expect, it, vi } from 'vitest'
// @ts-expect-error plain .mjs script, no type declarations
import { ghFetch } from '../scripts/lib/gh-fetch.mjs'

/* CHE-9860: a GitHub rate-limit answer is transient. ghFetch waits for the stated reset and retries, at most
   3 attempts and never past a 5 minute wait; everything else, and a wait that is too long, is returned as is
   so the caller still fails closed. */
const limited = (status: number, headers: Record<string, string>, message = 'API rate limit exceeded') =>
  new Response(JSON.stringify({ message }), { status, headers })
const ok = () => new Response('{}', { status: 200 })

function run(responses: Response[], now = 1_000_000) {
  const fetchImpl = vi.fn(async () => responses.shift() as Response)
  const sleep = vi.fn(async () => {})
  return { fetchImpl, sleep, call: () => ghFetch('u', {}, { fetchImpl, sleep, now: () => now }) }
}

describe('ghFetch', () => {
  it('retries a 403 with retry-after, then returns the success', async () => {
    const t = run([limited(403, { 'retry-after': '7' }), ok()])
    expect((await t.call()).status).toBe(200)
    expect(t.fetchImpl).toHaveBeenCalledTimes(2)
    expect(t.sleep).toHaveBeenCalledWith(7000)
  })

  it('waits until x-ratelimit-reset when the primary quota is empty', async () => {
    const t = run([limited(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1060' }), ok()])
    expect((await t.call()).status).toBe(200)
    expect(t.sleep).toHaveBeenCalledWith(60_000) // reset 1060 s, now 1000 s
  })

  it('retries a 429', async () => {
    const t = run([limited(429, { 'retry-after': '1' }), ok()])
    expect((await t.call()).status).toBe(200)
  })

  it('gives up after 3 attempts and returns the last rate-limit answer', async () => {
    const t = run([1, 2, 3, 4].map(() => limited(403, { 'retry-after': '1' })))
    expect((await t.call()).status).toBe(403)
    expect(t.fetchImpl).toHaveBeenCalledTimes(3)
  })

  it('does not wait when the reset is more than 5 minutes away', async () => {
    const t = run([limited(403, { 'retry-after': '301' }), ok()])
    expect((await t.call()).status).toBe(403)
    expect(t.fetchImpl).toHaveBeenCalledTimes(1)
    expect(t.sleep).not.toHaveBeenCalled()
  })

  it('does not retry a real denial (403 without rate-limit signs) or a 404', async () => {
    const denied = run([limited(403, {}, 'Resource not accessible by integration'), ok()])
    expect((await denied.call()).status).toBe(403)
    expect(denied.fetchImpl).toHaveBeenCalledTimes(1)
    const missing = run([new Response('{}', { status: 404 })])
    expect((await missing.call()).status).toBe(404)
    expect(missing.fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('retries a 403 whose message names the rate limit even without headers, after 60 s', async () => {
    const t = run([limited(403, {}), ok()])
    expect((await t.call()).status).toBe(200)
    expect(t.sleep).toHaveBeenCalledWith(60_000)
  })
})
