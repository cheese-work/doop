import { describe, expect, it } from 'vitest'
import { createTapDetector, isDoubleTap } from '../src/lib/doubleTap.ts'

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

describe('createTapDetector', () => {
  const tapAt = (d: ReturnType<typeof createTapDetector>, id: number, t: number, x = 100, y = 100) => {
    d.down(id, t, x, y, true)
    return d.up(id, t + 50, x, y)
  }

  it('fires on the second completed stationary tap', () => {
    const d = createTapDetector()
    expect(tapAt(d, 1, 0)).toBe(false)
    expect(tapAt(d, 2, 150)).toBe(true)
  })
  it('does not fire when the second press is a pan (moved past 24 px)', () => {
    const d = createTapDetector()
    tapAt(d, 1, 0)
    d.down(2, 150, 100, 100, true)
    d.move(2, 160, 100)
    expect(d.up(2, 250, 160, 100)).toBe(false)
  })
  it('does not fire when a second finger lands (pinch)', () => {
    const d = createTapDetector()
    tapAt(d, 1, 0)
    d.down(2, 150, 100, 100, true)
    d.down(3, 160, 140, 100, true)
    expect(d.up(2, 200, 100, 100)).toBe(false)
    expect(d.up(3, 210, 140, 100)).toBe(false)
  })
  it('does not fire after a cancelled press', () => {
    const d = createTapDetector()
    tapAt(d, 1, 0)
    d.down(2, 150, 100, 100, true)
    d.cancel()
    expect(d.up(2, 200, 100, 100)).toBe(false)
  })
  it('does not fire for a press that is not on empty canvas', () => {
    const d = createTapDetector()
    tapAt(d, 1, 0)
    d.down(2, 150, 100, 100, false)
    expect(d.up(2, 200, 100, 100)).toBe(false)
  })
  it('does not fire for a long press', () => {
    const d = createTapDetector()
    tapAt(d, 1, 0)
    d.down(2, 150, 100, 100, true)
    expect(d.up(2, 700, 100, 100)).toBe(false)
  })
})
