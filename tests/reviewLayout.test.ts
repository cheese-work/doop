import { describe, expect, it } from 'vitest'

const { reviewLayout } = await import('../src/lib/reviewLayout')

describe('phone review layout', () => {
  it('hides editor rails and panels for a view-only phone', () => {
    expect(reviewLayout({ isMobile: true, role: 'view' })).toEqual({ review: true, toolRail: false, panels: false })
  })

  it('keeps the comment tool for a commenting phone', () => {
    expect(reviewLayout({ isMobile: true, role: 'comment' })).toEqual({ review: true, toolRail: true, panels: false })
  })

  it('leaves the editor on a phone and every desktop role alone', () => {
    const full = { review: false, toolRail: true, panels: true }
    expect(reviewLayout({ isMobile: true, role: 'edit' })).toEqual(full)
    expect(reviewLayout({ isMobile: false, role: 'view' })).toEqual(full)
    expect(reviewLayout({ isMobile: false, role: 'comment' })).toEqual(full)
  })
})
