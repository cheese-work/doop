import { safeRelativeTarget } from './safeTarget'

/* The query params better-auth's OAuth callbacks add when a provider round
   trip fails (see redirectOnError in its oauth2 package). */
const ERROR_PARAMS = ['error', 'error_description']

/** The current path + query with a prior round trip's error params removed. */
export function withoutSsoError(pathname: string, search: string): string {
  const params = new URLSearchParams(search)
  for (const key of ERROR_PARAMS) params.delete(key)
  const query = params.toString()
  return query ? `${pathname}?${query}` : pathname
}

/** Where a failed or cancelled provider sign-in lands. The same page the user
 *  started from, not /auth: a home-screen (standalone) web app can lose the
 *  page it started on while the provider sheet is open, and /auth would drop
 *  a canvas share link (/c/<id>?frame=…) the signed-out visitor opened. A
 *  path that isn't same-origin falls back to /auth. */
export function ssoErrorReturnURL(pathname: string, search: string): string {
  return safeRelativeTarget(withoutSsoError(pathname, search)) ?? '/auth'
}
