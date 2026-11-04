import { describe, expect, it } from 'vitest'
import { isDoubleTap } from '../src/lib/doubleTap.ts'

const tap = (t: number, x = 100, y = 100) => ({ t, x, y })

describe('isDoubleTap', () => {
  it('accepts two taps close in time and space', () => {
    expect(isDoubleTap(tap(0), tap(200, 110, 105))).toBe(true)
  })
  it('rejects a second tap after 300 ms', () => {
    expect(isDoubleTap(tap(0), tap(301))).toBe(false)
  })
  it('rejects a second tap more than 24 px away', () => {
    expect(isDoubleTap(tap(0), tap(100, 125, 100))).toBe(false)
  })
  it('rejects a first tap that does not exist', () => {
    expect(isDoubleTap(null, tap(100))).toBe(false)
  })
})
