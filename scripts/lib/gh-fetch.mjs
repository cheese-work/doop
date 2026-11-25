// fetch for GitHub reads that rides out a short rate limit (CHE-9861). A 403/429 that carries a rate-limit signal
// (retry-after, or x-ratelimit-remaining: 0 with a reset time) or a 5xx is retried while the wait is at most
// MAX_WAIT_S; a longer wait (an exhausted hourly budget) returns the response so the caller still fails closed.
// Reads only: a write is never retried here.
const MAX_WAIT_S = 60
const TRIES = 4

const waitSeconds = (res, now) => {
  if (res.status >= 500) return 5
  if (res.status !== 403 && res.status !== 429) return null
  const after = Number(res.headers.get('retry-after'))
  if (after > 0) return after
  if (res.headers.get('x-ratelimit-remaining') === '0') {
    const reset = Number(res.headers.get('x-ratelimit-reset'))
    if (reset > 0) return Math.max(1, reset - Math.floor(now() / 1000))
  }
  return null
}

export async function fetchRead(
  url,
  init,
  { sleep = (s) => new Promise((r) => setTimeout(r, s * 1000)), now = Date.now } = {},
) {
  for (let i = 1; ; i++) {
    const res = await fetch(url, init)
    if (res.ok || i === TRIES) return res
    const wait = waitSeconds(res, now)
    if (wait === null || wait > MAX_WAIT_S) return res
    await sleep(wait)
  }
}
