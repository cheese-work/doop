/** The Multica workspace's web URL (the server's `MULTICA_WEB_URL`, e.g.
 *  `https://multica.example/cheese-work`) as the SPA may link to it: http(s)
 *  only, no trailing slash. Null when unset or not a web URL. */
export function multicaWebBase(raw: unknown): string | null {
  if (typeof raw !== 'string' || !/^https?:\/\//.test(raw)) return null
  return raw.replace(/\/+$/, '')
}
