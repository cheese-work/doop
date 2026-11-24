import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Actor } from '../shared/types'

/* persistence is not under test: the lock's own line in the activity feed is */
vi.mock('../server/db/persist.ts', () => ({
  saveTask: () => {},
  saveFeedback: () => {},
  saveComment: () => {},
  saveNewComment: async () => {},
  findCommentRow: async () => undefined,
  loadCommentThread: async () => [],
  saveActivity: () => {},
  saveDecision: () => {},
  saveProposal: () => {},
  saveCanvas: () => {},
  saveFrame: () => {},
  savePageCopy: async () => undefined,
}))

const actions = await import('../server/actions.ts')
const { store } = await import('../server/store.ts')
const { setLockOwners, systemContext } = await import('../server/writePolicy.ts')

const user: Actor = { name: 'kevin', kind: 'user', color: '#000' }
const agent: Actor = { name: 'Claude', kind: 'agent', color: '#e5533c' }
let canvasId: string

function messages(): string[] {
  return actions.getActivity(canvasId).map((item) => item.message)
}

beforeEach(() => {
  setLockOwners(['kevin'])
  actions.wire(
    () => {},
    () => {},
  )
  actions.hydrateLogs({
    tasks: new Map(),
    feedback: new Map(),
    comments: new Map(),
    activity: new Map(),
    decisions: new Map(),
    proposals: new Map(),
  })
  canvasId = store.createCanvas('locks', 'kevin').id
})

describe('frame lock activity', () => {
  it('logs a lock and an unlock', () => {
    const frame = actions.createFrame(canvasId, { name: 'Hero' }, user)!
    actions.updateFrame(frame.id, { locked: true }, user)
    expect(messages()).toContain('locked “Hero”')
    actions.updateFrame(frame.id, { locked: false }, user, { userId: 'kevin' }) // CHE-6626: owners only
    expect(messages()).toContain('unlocked “Hero”')
  })

  it('keeps the lock line when the same update also renames the frame', () => {
    const frame = actions.createFrame(canvasId, { name: 'Hero' }, user)!
    /* an agent's update_frame may carry name and locked together */
    actions.updateFrame(frame.id, { name: 'Hero v2', locked: true }, agent)
    expect(messages()).toContain('renamed “Hero” to “Hero v2”')
    expect(messages()).toContain('locked “Hero v2”')

    /* an unlock carries nothing else (CHE-6626); the redesign follows as its own update */
    actions.updateFrame(frame.id, { locked: false }, user, { userId: 'kevin' })
    expect(messages()).toContain('unlocked “Hero v2”')
    actions.updateFrame(frame.id, { html: '<h1>Hi</h1>' }, user)
    expect(messages()).toContain('updated the design of “Hero v2”')
  })

  it('stays quiet when the lock does not change', () => {
    const frame = actions.createFrame(canvasId, { name: 'Hero' }, user)!
    actions.updateFrame(frame.id, { locked: false }, user)
    actions.updateFrame(frame.id, { x: 10, locked: false }, user)
    expect(messages().filter((m) => m.includes('locked'))).toEqual([])
  })
})

describe('frame lock metadata (S1)', () => {
  const lockedFrame = () => {
    const frame = actions.createFrame(canvasId, { name: 'Hero' }, user)!
    actions.updateFrame(frame.id, { locked: true, lockReason: 'ready for dev' }, user)
    return frame
  }

  it('a lock records the actor, the time and the reason', () => {
    const before = Date.now()
    const frame = lockedFrame()
    expect(store.getFrame(frame.id)).toMatchObject({ locked: true, lockedBy: 'kevin', lockReason: 'ready for dev' })
    expect(store.getFrame(frame.id)!.lockedAt).toBeGreaterThanOrEqual(before)
  })

  it('a second lock keeps the first locked_by and locked_at, and logs nothing new', () => {
    const frame = lockedFrame()
    const first = { ...store.getFrame(frame.id)! }
    const logged = messages().length
    actions.updateFrame(frame.id, { locked: true, lockReason: 'later' }, agent)
    expect(store.getFrame(frame.id)).toMatchObject({
      lockedBy: 'kevin',
      lockedAt: first.lockedAt,
      lockReason: 'ready for dev',
      updatedAt: first.updatedAt,
    })
    expect(messages()).toHaveLength(logged)
  })

  it('an unlock clears all three and leaves lockEpoch to the lock-port rules', () => {
    const frame = lockedFrame()
    actions.updateFrame(frame.id, { locked: false }, user, { userId: 'kevin' })
    const after = store.getFrame(frame.id)!
    expect(after.locked).toBeFalsy()
    expect(after.lockedBy).toBeUndefined()
    expect(after.lockedAt).toBeUndefined()
    expect(after.lockReason).toBeUndefined()
    expect(after.lockEpoch).toBe(1)
  })

  it('logs one "edit refused" line with the actor for each refused write, and changes nothing', () => {
    const frame = lockedFrame()
    const before = { ...store.getFrame(frame.id)! }
    const refusals = () => messages().filter((m) => m.startsWith('edit refused'))
    expect(() => actions.updateFrame(frame.id, { name: 'Renamed' }, agent)).toThrow(/locked/)
    expect(refusals()).toEqual(['edit refused on “Hero”: locked by kevin'])
    const item = actions.getActivity(canvasId).find((a) => a.message.startsWith('edit refused'))!
    expect(item).toMatchObject({ actorName: 'Claude', frameId: frame.id })

    expect(() => actions.updateFrame(frame.id, { html: '<p>x</p>' }, user)).toThrow(/locked/)
    expect(() => actions.appendFrameHtml(frame.id, '<p>x</p>', user, { start: true })).toThrow(/locked/)
    expect(refusals()).toHaveLength(3)
    expect(store.getFrame(frame.id)).toEqual(before)
  })

  it('logs no "edit refused" line for a write that is not refused', () => {
    const frame = actions.createFrame(canvasId, { name: 'Free' }, user)!
    actions.updateFrame(frame.id, { name: 'Free 2' }, agent)
    expect(messages().filter((m) => m.startsWith('edit refused'))).toEqual([])
  })

  it('a copy of a locked frame starts with every lock field empty', async () => {
    const frame = lockedFrame()
    const copy = await store.duplicatePage(systemContext(), canvasId, store.getFrame(frame.id)!.pageId!, 'kevin')
    const dup = store.getFrame(copy!.frames[0]!.id)!
    expect(dup.locked).toBeFalsy()
    expect(dup.lockedBy).toBeUndefined()
    expect(dup.lockedAt).toBeUndefined()
    expect(dup.lockReason).toBeUndefined()
  })
})
