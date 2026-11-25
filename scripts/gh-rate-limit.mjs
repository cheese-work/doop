// Waits out a GitHub rate limit instead of failing the deploy on it (CHE-9842). Shared by deploy-gate.mjs and
// deploy-marker.mjs. The C00 App's hourly quota can be spent by another consumer of the same App; a confirm that
// refused on that 403 rolled back a healthy deploy.
//
// A rate-limit response is a 403 or 429 with `retry-after`, or with `x-ratelimit-remaining: 0`. It is retried after
// `retry-after` or until `x-ratelimit-reset`, plus one second. Waits add up to at most RATE_LIMIT_CAP_MS; a wait that
// would pass the cap is not started, and the response comes back as it is, so the caller fails closed as before.
// Any other 403 (a missing permission) comes back at once.
// `beforeRetry`, when given, runs after each wait and before the request is sent again. A write uses it to check that
// the state it checked before the first try still stands; if it throws, the request is not sent again.
export const RATE_LIMIT_CAP_MS = 20 * 60 * 1000
const NO_HINT_MS = 60_000
const BUFFER_MS = 1_000

/** Milliseconds to wait when `res` is a rate-limit response, else null. */
export function rateLimitWaitMs(res, nowMs) {
  if (res.status !== 403 && res.status !== 429) return null
  const retryAfter = res.headers.get('retry-after')
  if (retryAfter !== null) {
    const seconds = Number(retryAfter)
    if (!Number.isFinite(seconds) || retryAfter.trim() === '') return NO_HINT_MS
    return Math.max(0, seconds) * 1000 + BUFFER_MS
  }
  if (res.headers.get('x-ratelimit-remaining') !== '0') return null
  const reset = res.headers.get('x-ratelimit-reset')
  const resetMs = reset === null || reset.trim() === '' ? NaN : Number(reset) * 1000
  return Number.isFinite(resetMs) ? Math.max(0, resetMs - nowMs) + BUFFER_MS : NO_HINT_MS
}

const resetAt = (res, nowMs, waitMs) => {
  const reset = Number(res.headers.get('x-ratelimit-reset'))
  return new Date(res.headers.get('x-ratelimit-reset') && Number.isFinite(reset) ? reset * 1000 : nowMs + waitMs)
}

/** `doFetch()` returns a Response. A rate-limited one is retried after its wait; every other one is returned. */
export async function fetchWithRateLimit(doFetch, opts = {}) {
  const {
    capMs = RATE_LIMIT_CAP_MS,
    sleep = (ms) => new Promise((done) => setTimeout(done, ms)),
    now = Date.now,
    log = (line) => console.error(line),
    label = '',
    beforeRetry,
  } = opts
  let waited = 0
  for (;;) {
    const res = await doFetch()
    const nowMs = now()
    const wait = rateLimitWaitMs(res, nowMs)
    if (wait === null || waited + wait > capMs) return res
    log(
      `GitHub rate limit (${res.status}) on ${label || 'a request'}: waiting ${Math.ceil(wait / 1000)}s until ` +
        `${resetAt(res, nowMs, wait).toISOString()} (${Math.ceil((waited + wait) / 1000)}s of ${capMs / 1000}s used)`,
    )
    await res.arrayBuffer().catch(() => {})
    await sleep(wait)
    waited += wait
    if (beforeRetry) await beforeRetry()
  }
}
