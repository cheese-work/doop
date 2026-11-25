// fetch for the deploy scripts that waits out a short GitHub rate limit (CHE-9862). Run 45564279031 and two
// more failed closed on `403 API rate limit exceeded for installation` while reading DOOP_DEPLOY_SUSPENDED.
// Only a 403 or 429 that names a rate limit is retried, and only when GitHub says it clears within MAX_WAIT_MS
// (Retry-After, or X-RateLimit-Reset when the quota is 0). A request refused for rate limit never ran, so
// retrying a write cannot double it. A longer wait (the hourly quota) is returned as is: the caller fails closed.
export const MAX_WAIT_MS = 60_000
const ATTEMPTS = 3

export const rateLimitWaitMs = (res, now = Date.now()) => {
  if (res.status !== 403 && res.status !== 429) return null
  const retryAfter = Number(res.headers.get('retry-after'))
  if (retryAfter > 0) return retryAfter * 1000
  if (res.headers.get('x-ratelimit-remaining') === '0') {
    const reset = Number(res.headers.get('x-ratelimit-reset'))
    if (reset > 0) return Math.max(0, reset * 1000 - now) + 1000
  }
  return null
}

export async function fetchRetry(
  url,
  init,
  { sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now } = {},
) {
  for (let i = 1; ; i++) {
    const res = await fetch(url, init)
    const wait = rateLimitWaitMs(res, now())
    if (wait === null || wait > MAX_WAIT_MS || i >= ATTEMPTS) return res
    console.error(`GitHub rate limit (${res.status}); retry ${i} of ${ATTEMPTS - 1} in ${Math.ceil(wait / 1000)}s`)
    await sleep(wait)
  }
}
