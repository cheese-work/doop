// fetch for the GitHub API that waits out a rate limit (CHE-9860). The installation quota is shared, so a 403
// or 429 that says "rate limit" is transient. It is retried up to 3 attempts, and only when the stated reset is
// at most 5 minutes away. Anything else, and the last rate-limit answer, is returned as is: the caller still
// fails closed on `!res.ok`, so a real denial is never retried.
const MAX_ATTEMPTS = 3
const MAX_WAIT_MS = 5 * 60_000
const DEFAULT_WAIT_MS = 60_000 // a rate-limit message with no retry-after or reset header

// Milliseconds to wait if `res` is a rate-limit answer, else null.
async function waitFor(res, now) {
  if (res.status !== 403 && res.status !== 429) return null
  const after = Number(res.headers.get('retry-after'))
  if (after > 0) return after * 1000
  const reset = Number(res.headers.get('x-ratelimit-reset'))
  if (res.headers.get('x-ratelimit-remaining') === '0' && reset > 0) return Math.max(0, reset * 1000 - now())
  const body = await res
    .clone()
    .json()
    .catch(() => ({}))
  return res.status === 429 || /rate limit/i.test(String(body?.message ?? '')) ? DEFAULT_WAIT_MS : null
}

export async function ghFetch(
  url,
  init,
  { fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now } = {},
) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetchImpl(url, init)
    const wait = res.ok || attempt >= MAX_ATTEMPTS ? null : await waitFor(res, now)
    if (wait === null || wait > MAX_WAIT_MS) return res
    await sleep(wait)
  }
}
