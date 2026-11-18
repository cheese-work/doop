import { describe, expect, it } from 'vitest'
import { framesToMount } from '../src/lib/frameCulling.ts'

const stage = { width: 400, height: 800 }
const frame = (id: string, x: number, y = 0, width = 2200, height = 5500) => ({ id, x, y, width, height })

describe('framesToMount', () => {
  it('mounts a frame that overlaps the stage and skips one far off-screen', () => {
    const frames = [frame('near', 0), frame('far', 100_000)]
    const ids = framesToMount(frames, { x: 0, y: 0, zoom: 1 }, stage, new Set())
    expect([...ids]).toEqual(['near'])
  })

  it('mounts a frame within one stage of the edge, so a pan does not reveal a blank frame', () => {
    const frames = [frame('beside', 600, 0, 200, 100), frame('beyond', 1300, 0, 200, 100)]
    const ids = framesToMount(frames, { x: 0, y: 0, zoom: 1 }, stage, new Set())
    expect([...ids]).toEqual(['beside'])
  })

  it('follows the camera: pan and zoom move the screen rect', () => {
    const frames = [frame('a', 0), frame('b', 5000)]
    const panned = framesToMount(frames, { x: -5000, y: 0, zoom: 1 }, stage, new Set())
    expect([...panned]).toEqual(['b'])
    const zoomedIn = framesToMount(frames, { x: 0, y: 0, zoom: 0.5 }, stage, new Set())
    expect([...zoomedIn]).toEqual(['a'])
  })

  it('always keeps the listed frames, e.g. the selection', () => {
    const frames = [frame('far', 100_000)]
    expect([...framesToMount(frames, { x: 0, y: 0, zoom: 1 }, stage, new Set(['far']))]).toEqual(['far'])
  })

  it('mounts everything before the stage has a size', () => {
    const frames = [frame('far', 100_000)]
    expect([...framesToMount(frames, { x: 0, y: 0, zoom: 1 }, { width: 0, height: 0 }, new Set())]).toEqual(['far'])
  })

  it('mounts no frame that is narrower than 160 px on screen, so a zoomed-out file holds no live iframes', () => {
    const frames = Array.from({ length: 50 }, (_, i) => frame(`f${i}`, i * 40, 0, 390, 844))
    // 390 × 0.4 = 156 px wide: too small to read
    expect(framesToMount(frames, { x: 0, y: 0, zoom: 0.4 }, stage, new Set()).size).toBe(0)
    // 390 × 0.5 = 195 px wide: readable
    expect(framesToMount(frames, { x: 0, y: 0, zoom: 0.5 }, stage, new Set()).size).toBeGreaterThan(0)
  })

  it('mounts at most 24 frames, the ones nearest the stage centre first', () => {
    const frames = Array.from({ length: 100 }, (_, i) => frame(`f${i}`, i * 10, 0, 400, 400))
    const ids = framesToMount(frames, { x: 0, y: 0, zoom: 1 }, { width: 1000, height: 800 }, new Set())
    expect(ids.size).toBe(24)
    // stage centre is x=500: frame centres at 200 + 10i, so i=30 is nearest
    expect(ids.has('f30')).toBe(true)
    expect(ids.has('f0')).toBe(false)
    expect(ids.has('f99')).toBe(false)
  })

  it('keeps selected frames live on top of the cap, even when small or far', () => {
    const frames = [
      ...Array.from({ length: 30 }, (_, i) => frame(`f${i}`, i * 10, 0, 400, 400)),
      frame('tiny', 100_000, 0, 10, 10),
    ]
    const ids = framesToMount(frames, { x: 0, y: 0, zoom: 1 }, { width: 1000, height: 800 }, new Set(['tiny']))
    expect(ids.has('tiny')).toBe(true)
    expect(ids.size).toBe(25)
  })

  it('on the erus mix at fit-all zoom mounts 24 or fewer', () => {
    const sizes = [
      [390, 844],
      [1440, 900],
      [390, 867],
      [1440, 1800],
    ]
    const frames = Array.from({ length: 645 }, (_, i) => {
      const [w, h] = sizes[i % 4] as [number, number]
      return frame(`e${i}`, (i % 40) * 1500, Math.floor(i / 40) * 1900, w, h)
    })
    const ids = framesToMount(frames, { x: 0, y: 0, zoom: 0.025 }, { width: 1600, height: 900 }, new Set())
    expect(ids.size).toBeLessThanOrEqual(24)
  })
})
