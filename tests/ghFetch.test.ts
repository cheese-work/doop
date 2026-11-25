import { describe, expect, it } from 'vitest'

import { ghFetch } from '../scripts/gh-fetch.mjs'

const reply =
  (status: number, message = '', headers: Record<string, string> = {}) =>
  () =>
    Promise.resolve(new Response(JSON.stringify({ message }), { status, headers }))
const run = (steps: Array<() => Promise<Response>>) => {
  const waits: number[] = []
  let i = 0
  const fetchFn = () => steps[Math.min(i++, steps.length - 1)]!()
  const call = () =>
    ghFetch('u', {}, { fetchFn: fetchFn as typeof fetch, sleep: async (ms: number) => void waits.push(ms) })
  return { call, waits, calls: () => i }
}

describe('ghFetch (CHE-9888)', () => {
  it('waits out a rate-limit 403, then returns the success', async () => {
    const t = run([reply(403, 'API rate limit exceeded for installation ID 1'), reply(200, '')])
    expect((await t.call()).status).toBe(200)
    expect(t.waits).toEqual([15000])
  })

  it('honours retry-after on 429, capped at 60s', async () => {
    const t = run([reply(429, '', { 'retry-after': '600' }), reply(200)])
    await t.call()
    expect(t.waits).toEqual([60000])
  })

  it('gives up after 3 retries and keeps the GitHub message', async () => {
    const t = run([reply(403, 'API rate limit exceeded')])
    const res = await t.call()
    expect(res.status).toBe(403)
    expect((res as Response & { ghMessage: string }).ghMessage).toContain('rate limit')
    expect(t.calls()).toBe(4)
  })

  it('does not retry a permission 403 or a 404', async () => {
    for (const status of [403, 404]) {
      const t = run([reply(status, 'Resource not accessible by integration')])
      expect((await t.call()).status).toBe(status)
      expect(t.calls()).toBe(1)
    }
  })
})
