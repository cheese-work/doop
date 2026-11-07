import { describe, expect, it } from 'vitest'
import { safeRelativeTarget } from '../src/lib/safeTarget'
import { ssoErrorReturnURL, withoutSsoError } from '../src/lib/ssoReturn'

describe('provider sign-in return path', () => {
  it('sends a failed round trip back to the canvas link, not /auth', () => {
    expect(ssoErrorReturnURL('/c/abc', '?frame=f1')).toBe('/c/abc?frame=f1')
    expect(ssoErrorReturnURL('/c/abc', '')).toBe('/c/abc')
  })

  it('drops a stale error from the return path so errors do not stack', () => {
    expect(ssoErrorReturnURL('/c/abc', '?frame=f1&error=access_denied')).toBe('/c/abc?frame=f1')
  })

  it('keeps ?frame= when clearing the error from the address bar', () => {
    expect(withoutSsoError('/c/abc', '?frame=f1&error=access_denied&error_description=x')).toBe('/c/abc?frame=f1')
    expect(withoutSsoError('/auth', '?error=access_denied')).toBe('/auth')
  })

  it('only ever returns a same-origin path', () => {
    expect(safeRelativeTarget(ssoErrorReturnURL('/c/abc', '?frame=f1'))).toBe('/c/abc?frame=f1')
    expect(ssoErrorReturnURL('//evil.com', '')).toBe('/auth')
    expect(ssoErrorReturnURL('/\\evil.com', '')).toBe('/auth')
  })
})
