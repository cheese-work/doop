import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Canvas } from '../shared/types.ts'

/**
 * A thread move racing a reply. A reply is stored before it joins the log, so
 * a move that lands in between must not leave the reply on the old anchor.
 * Persistence is stubbed with a gate that holds the reply's save open.
 */

const gate = vi.hoisted(() => {
  const state = { entered: undefined as (() => void) | undefined, release: undefined as Promise<void> | undefined }
  return state
})

vi.mock('../server/db/persist.ts', () => ({
  saveFrame: () => {},
  saveFrameNow: async () => {},
  saveCanvas: () => {},
  saveTask: () => {},
  saveFeedback: () => {},
  saveComment: () => {},
  saveNewComment: async () => {
    gate.entered?.()
    await gate.release
  },
  findCommentRow: async () => undefined,
  loadCommentThread: async () => [],
  saveActivity: () => {},
  saveDecision: () => {},
  saveProposal: () => {},
}))
vi.mock('../server/distill.ts', () => ({ onDecision: () => {} }))

const actions = await import('../server/actions.ts')
const { store } = await import('../server/store.ts')

const CANVAS: Canvas = {
  id: 'c1',
  name: 'Landing',
  ownerId: 'alice',
  createdAt: 0,
  updatedAt: 0,
  pages: [
    { id: 'p1', name: 'Home' },
    { id: 'p2', name: 'Checkout' },
  ],
  frames: [],
}

beforeEach(() => {
  gate.entered = undefined
  gate.release = undefined
  actions.wire(
    () => {},
    () => {},
  )
  actions.hydrateLogs({
    tasks: new Map(),
    feedback: new Map(),
    comments: new Map([[CANVAS.id, []]]),
    activity: new Map([[CANVAS.id, []]]),
    decisions: new Map([[CANVAS.id, []]]),
    proposals: new Map(),
  })
  vi.spyOn(store, 'getCanvas').mockImplementation((id) => (id === CANVAS.id ? CANVAS : undefined))
})

afterEach(() => vi.restoreAllMocks())

describe('moveComment racing replyToComment', () => {
  it('leaves the root and a reply that was mid-save on the same anchor', async () => {
    const root = (await actions.addCanvasComment(CANVAS.id, { pageId: 'p1', x: 10, y: 10, text: 'note' }, 'alice'))!
    let open!: () => void
    gate.release = new Promise<void>((resolve) => (open = resolve))
    const saving = new Promise<void>((resolve) => (gate.entered = resolve))

    const reply = actions.replyToComment(root.id, 'racing reply', 'bob')
    await saving
    const move = actions.moveComment(root.id, { pageId: 'p2', x: 50, y: 60 }, 'bob', { canEdit: true })
    await new Promise((resolve) => setTimeout(resolve, 20))
    open()
    await Promise.all([reply, move])

    const thread = actions.getComments(CANVAS.id)
    expect(thread).toHaveLength(2)
    for (const c of thread) expect(c).toMatchObject({ pageId: 'p2', x: 50, y: 60 })
  })
})
