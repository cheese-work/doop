import { beforeEach, describe, expect, it, vi } from 'vitest'
import { systemContext } from '../server/writePolicy.ts'

const sys = systemContext()

/* persistence is not under test: the in-memory order is */
vi.mock('../server/db/persist.ts', () => ({
  saveCanvas: () => {},
  saveFrame: () => {},
  savePageCopy: () => Promise.resolve(),
  saveCanvasCopy: () => Promise.resolve(),
}))

const { store } = await import('../server/store.ts')
const { canvasPages, pageFrames } = await import('../shared/pages.ts')

let canvasId: string
const order = (pageId?: string) => {
  const canvas = store.getCanvas(canvasId)!
  return pageFrames(canvas, pageId ?? canvasPages(canvas)[0]!.id).map((f) => f.name)
}

beforeEach(() => {
  canvasId = store.createCanvas('stack', 'kevin').id
})

describe('server frame stacking', () => {
  it('creates each frame in front of the page', () => {
    const a = store.createFrame(sys, canvasId, { name: 'a' }, 'kevin')!
    const b = store.createFrame(sys, canvasId, { name: 'b' }, 'kevin')!
    expect(b.z).toBeGreaterThan(a.z!)
    expect(order()).toEqual(['a', 'b'])
  })

  it('keeps the frames in stack order after a z change', () => {
    store.createFrame(sys, canvasId, { name: 'a' }, 'kevin')
    store.createFrame(sys, canvasId, { name: 'b' }, 'kevin')
    const c = store.createFrame(sys, canvasId, { name: 'c' }, 'kevin')!
    store.updateFrame(sys, c.id, { z: -1 }, 'kevin')
    expect(order()).toEqual(['c', 'a', 'b'])
  })

  it('brings a deleted frame back to the place it is given', () => {
    store.createFrame(sys, canvasId, { name: 'a' }, 'kevin')
    store.createFrame(sys, canvasId, { name: 'b' }, 'kevin')
    store.createFrame(sys, canvasId, { name: 'back', z: -5 }, 'kevin')
    expect(order()).toEqual(['back', 'a', 'b'])
  })

  it('puts a frame moved to another page in front there', () => {
    const canvas = store.getCanvas(canvasId)!
    const [first] = canvasPages(canvas)
    store.setPages(sys, canvasId, [first!, { id: 'p2', name: 'Page 2' }])
    store.createFrame(sys, canvasId, { name: 'there', pageId: 'p2', z: 100 }, 'kevin')
    const moving = store.createFrame(sys, canvasId, { name: 'moving', z: -100 }, 'kevin')!
    store.updateFrame(sys, moving.id, { pageId: 'p2' }, 'kevin')
    expect(order('p2')).toEqual(['there', 'moving'])
  })

  it('keeps the order in a copied canvas', async () => {
    store.createFrame(sys, canvasId, { name: 'a' }, 'kevin')
    const b = store.createFrame(sys, canvasId, { name: 'b' }, 'kevin')!
    store.updateFrame(sys, b.id, { z: -1 }, 'kevin')
    const copy = await store.duplicateCanvas(canvasId, 'kevin', 'kevin')
    expect(copy!.frames.map((f) => f.name)).toEqual(['b', 'a'])
  })
})
