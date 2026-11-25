import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { describe, expect, it } from 'vitest'
// @ts-expect-error plain .mjs script, no type declarations
import { RATE_LIMIT_CAP_MS, fetchWithRateLimit, rateLimitWaitMs } from '../scripts/gh-rate-limit.mjs'

/* CHE-9842: GitHub's 403 for an exhausted hourly quota (installation rate limit) made readback-confirm refuse a
   healthy deploy. A rate-limit response (403 or 429 with x-ratelimit-remaining 0, or a retry-after header) is
   waited out, capped at 20 minutes in total; any other 403 still fails closed at once. */
const NOW = 1_800_000_000_000 // ms
const limited = (headers: Record<string, string>, status = 403) =>
  new Response(JSON.stringify({ message: 'API rate limit exceeded for installation ID 1' }), { status, headers })
const plain403 = () => new Response(JSON.stringify({ message: 'Resource not accessible' }), { status: 403 })
const ok = () => new Response('{"value":"on"}', { status: 200 })

const harness = (responses: Response[]) => {
  const sleeps: number[] = []
  const logs: string[] = []
  let calls = 0
  return {
    sleeps,
    logs,
    calls: () => calls,
    run: (capMs?: number) =>
      fetchWithRateLimit(async () => responses[calls++] ?? ok(), {
        sleep: async (ms: number) => void sleeps.push(ms),
        now: () => NOW,
        log: (line: string) => void logs.push(line),
        label: 'repos/x/y/actions/variables/Z',
        ...(capMs === undefined ? {} : { capMs }),
      }) as Promise<Response>,
  }
}

describe('rateLimitWaitMs', () => {
  it('is null for a success and for a plain 403', () => {
    expect(rateLimitWaitMs(ok(), NOW)).toBeNull()
    expect(rateLimitWaitMs(plain403(), NOW)).toBeNull()
    expect(rateLimitWaitMs(new Response('', { status: 500, headers: { 'retry-after': '5' } }), NOW)).toBeNull()
  })

  it('403 with remaining 0 waits until the reset second plus one second', () => {
    const reset = String(NOW / 1000 + 90)
    expect(rateLimitWaitMs(limited({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset }), NOW)).toBe(91_000)
  })

  it('a reset already in the past still waits one second', () => {
    const reset = String(NOW / 1000 - 30)
    expect(rateLimitWaitMs(limited({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset }), NOW)).toBe(1_000)
  })

  it('retry-after seconds on a 403 or a 429', () => {
    expect(rateLimitWaitMs(limited({ 'retry-after': '30' }), NOW)).toBe(31_000)
    expect(rateLimitWaitMs(limited({ 'retry-after': '7' }, 429), NOW)).toBe(8_000)
  })

  it('remaining above 0 on a 403 is not a rate limit', () => {
    expect(rateLimitWaitMs(limited({ 'x-ratelimit-remaining': '12', 'x-ratelimit-reset': '1' }), NOW)).toBeNull()
  })

  it('a rate limit with no usable reset waits a minute', () => {
    expect(rateLimitWaitMs(limited({ 'x-ratelimit-remaining': '0' }), NOW)).toBe(60_000)
    expect(rateLimitWaitMs(limited({ 'retry-after': 'soon' }), NOW)).toBe(60_000)
  })
})

describe('fetchWithRateLimit', () => {
  it('one rate-limit 403, then 200: the read succeeds after one wait, and the wait is logged with the reset', async () => {
    const reset = String(NOW / 1000 + 120)
    const h = harness([limited({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset }), ok()])
    const res = await h.run()
    expect(res.status).toBe(200)
    expect(h.calls()).toBe(2)
    expect(h.sleeps).toEqual([121_000])
    expect(h.logs).toHaveLength(1)
    expect(h.logs[0]).toContain('rate limit')
    expect(h.logs[0]).toContain(new Date(Number(reset) * 1000).toISOString())
    expect(h.logs[0]).toContain('repos/x/y/actions/variables/Z')
  })

  it('a plain 403 is returned at once: one call, no wait', async () => {
    const h = harness([plain403(), ok()])
    const res = await h.run()
    expect(res.status).toBe(403)
    expect(h.calls()).toBe(1)
    expect(h.sleeps).toEqual([])
  })

  it('a rate limit whose reset is past the cap is returned at once, never slept on', async () => {
    const reset = String(NOW / 1000 + 3600)
    const h = harness([limited({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset }), ok()])
    const res = await h.run()
    expect(res.status).toBe(403)
    expect(h.calls()).toBe(1)
    expect(h.sleeps).toEqual([])
  })

  it('repeated rate limits stop once the next wait would pass the cap in total', async () => {
    const lim = () => limited({ 'retry-after': '540' }) // 541 s each: two fit in 20 min, the third does not
    const h = harness([lim(), lim(), lim(), ok()])
    const res = await h.run()
    expect(res.status).toBe(403)
    expect(h.calls()).toBe(3)
    expect(h.sleeps).toEqual([541_000, 541_000])
    expect(h.sleeps.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(RATE_LIMIT_CAP_MS)
  })

  it('the cap is 20 minutes', () => {
    expect(RATE_LIMIT_CAP_MS).toBe(20 * 60 * 1000)
  })
})

/* The two CLIs end to end against a local server: one 403 with retry-after: 1, then the real answer. */
const REPO = 'cheese-work/doop'
const SHA = 'a'.repeat(40)
const CLEAR = `clear:${'0'.repeat(32)}:restore`

type Script = { status: number; headers?: Record<string, string>; body: unknown }
async function runCli(script: string, args: string[], env: Record<string, string>, replies: Script[]) {
  const seen: string[] = []
  const server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`)
    const next = replies.shift() ?? { status: 500, body: {} }
    res.statusCode = next.status
    for (const [k, v] of Object.entries(next.headers ?? {})) res.setHeader(k, v)
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(next.body))
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const { port } = server.address() as { port: number }
  try {
    const result = await new Promise<{ code: number | null; out: string }>((done) => {
      const child = spawn('node', [script, ...args], {
        env: { PATH: process.env.PATH ?? '', GITHUB_API_URL: `http://127.0.0.1:${port}`, GH_TOKEN: 't', REPO, ...env },
      })
      let out = ''
      child.stdout.on('data', (d) => (out += d))
      child.stderr.on('data', (d) => (out += d))
      child.on('close', (code) => done({ code, out }))
    })
    return { ...result, seen }
  } finally {
    server.close()
  }
}

describe('the CLIs wait out a rate limit (CHE-9842)', () => {
  it('deploy-gate resolve reads the D1 runs after one rate-limited 403', async () => {
    const r = await runCli('scripts/deploy-gate.mjs', ['resolve'], { MODE: 'train' }, [
      {
        status: 403,
        headers: { 'retry-after': '1' },
        body: { message: 'API rate limit exceeded for installation ID 1' },
      },
      { status: 200, body: { workflow_runs: [] } },
    ])
    expect(r.code).toBe(0)
    expect(r.out).toContain('rate limit')
    expect(r.out).toContain('no successful D1 push run')
    expect(r.seen).toHaveLength(2)
    expect(r.seen[0]).toBe(r.seen[1]) // the same request, retried
  }, 30_000)

  it('deploy-gate with a plain 403 refuses at once', async () => {
    const r = await runCli('scripts/deploy-gate.mjs', ['resolve'], { MODE: 'train' }, [
      { status: 403, body: { message: 'Resource not accessible by integration' } },
    ])
    expect(r.code).not.toBe(0)
    expect(r.out).toContain('403')
    expect(r.out).not.toContain('rate limit')
    expect(r.seen).toHaveLength(1)
  })

  it('deploy-marker suspend --any retries a rate-limited read and then writes', async () => {
    const r = await runCli(
      'scripts/deploy-marker.mjs',
      ['suspend', '--reason', 'rollback', '--any'],
      { RUN_ID: '45564279031', SHA },
      [
        { status: 403, headers: { 'retry-after': '1' }, body: { message: 'API rate limit exceeded' } },
        { status: 200, body: { value: CLEAR } }, // the --any read
        { status: 200, body: { value: CLEAR } }, // writeMarker's read
        { status: 200, body: {} }, // PATCH
        { status: 200, body: { value: 'x' } }, // read back (will not match, so it fails closed after the write)
      ],
    )
    expect(r.out).toContain('rate limit')
    expect(r.seen.filter((s) => s.startsWith('PATCH'))).toHaveLength(1)
  }, 30_000)

  it('deploy-marker with a plain 403 fails closed at once', async () => {
    const r = await runCli(
      'scripts/deploy-marker.mjs',
      ['suspend', '--reason', 'rollback', '--any'],
      { RUN_ID: '45564279031', SHA },
      [{ status: 403, body: { message: 'Resource not accessible' } }],
    )
    expect(r.code).not.toBe(0)
    expect(r.seen).toHaveLength(1)
    expect(r.out).toContain('failed closed')
  })
})
