// fetch for the GitHub API that waits out a rate limit instead of failing the deploy (CHE-9888).
// GitHub answers a rate-limited App installation with 403 or 429; a rejected request changed nothing, so a retry is safe.
// Any other failure is returned as is. A final failure carries GitHub's message, so a log can tell a limit from a missing permission.
const limited = (res, message) =>
  res.status === 429 ||
  (res.status === 403 &&
    (res.headers.get('retry-after') || res.headers.get('x-ratelimit-remaining') === '0' || /rate limit/i.test(message)))

export async function ghFetch(
  url,
  init,
  { retries = 3, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), fetchFn = fetch } = {},
) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetchFn(url, init)
    if (res.ok) return res
    const body = await res
      .clone()
      .json()
      .catch(() => ({}))
    const message = typeof body?.message === 'string' ? body.message.slice(0, 200) : ''
    if (attempt >= retries || !limited(res, message)) return Object.assign(res, { ghMessage: message })
    const wait = Number(res.headers.get('retry-after')) || 15 * (attempt + 1)
    await sleep(Math.min(wait, 60) * 1000)
  }
}
