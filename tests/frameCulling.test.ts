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
    const frames = [frame('beside', 600, 0, 100, 100), frame('beyond', 1300, 0, 100, 100)]
    const ids = framesToMount(frames, { x: 0, y: 0, zoom: 1 }, stage, new Set())
    expect([...ids]).toEqual(['beside'])
  })

  it('follows the camera: pan and zoom move the screen rect', () => {
    const frames = [frame('a', 0), frame('b', 5000)]
    const panned = framesToMount(frames, { x: -5000, y: 0, zoom: 1 }, stage, new Set())
    expect([...panned]).toEqual(['b'])
    const zoomedOut = framesToMount(frames, { x: 0, y: 0, zoom: 0.01 }, stage, new Set())
    expect([...zoomedOut].sort()).toEqual(['a', 'b'])
  })

  it('always keeps the listed frames, e.g. the selection', () => {
    const frames = [frame('far', 100_000)]
    expect([...framesToMount(frames, { x: 0, y: 0, zoom: 1 }, stage, new Set(['far']))]).toEqual(['far'])
  })

  it('mounts everything before the stage has a size', () => {
    const frames = [frame('far', 100_000)]
    expect([...framesToMount(frames, { x: 0, y: 0, zoom: 1 }, { width: 0, height: 0 }, new Set())]).toEqual(['far'])
  })
})
