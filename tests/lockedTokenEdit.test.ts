import { describe, expect, it, vi } from 'vitest'
import type { Actor } from '../shared/types'

/* What the token writes persist, as a name -> value map per canvas, so a test
   can compare the store with what would reach Postgres. */
const persisted = new Map<string, string>()
vi.mock('../server/db/persist.ts', () => ({
  saveTask: () => {},
  saveFeedback: () => {},
  saveComment: () => {},
  saveActivity: () => {},
  saveDecision: () => {},
  saveProposal: () => {},
  saveCanvas: () => {},
  saveFrame: () => {},
  saveToken: (canvasId: string, token: { name: string; value: string }) =>
    persisted.set(`${canvasId}:${token.name}`, token.value),
  deleteToken: (canvasId: string, name: string) => persisted.delete(`${canvasId}:${name}`),
  saveCanvasCopy: async () => {},
  saveFrameVersion: () => {},
}))
vi.mock('../server/fonts.ts', () => ({ fontsForCanvas: () => [] }))

const actions = await import('../server/actions.ts')
const { store, FrameLockedError } = await import('../server/store.ts')
const { setLockOwners } = await import('../server/writePolicy.ts')

/**
 * A token edit that would rewrite a locked frame is refused as a whole: the
 * lock guard throws inside the restyle, after the token was already written,
 * so without a rollback the canvas keeps a renamed token next to a frame that
 * still names the old one (review of CHE-5733, doop#40).
 */

const human: Actor = { name: 'Kevin', kind: 'user', color: '#2743ee' }
/* CHE-6626: only a signed-in lock owner unlocks */
const OWNER = { userId: 'kevin-id' }
setLockOwners([OWNER.userId])
actions.wire(
  () => {},
  () => {},
)

const body = (css: string) => `<html><head></head><body style="${css}"></body></html>`

/** A canvas with one token, an unlocked frame (listed first, so the restyle reaches it first) and a locked one. */
function setup() {
  const canvasId = store.createCanvas('locked tokens', 'kevin').id
  actions.createTokens(canvasId, [{ name: '--ink', type: 'color', value: '#111' }], human)
  const open = actions.createFrame(canvasId, { name: 'open', html: body('color:var(--ink)') }, human)!
  const locked = actions.createFrame(canvasId, { name: 'locked', html: body('color:var(--ink)') }, human)!
  actions.updateFrame(locked.id, { locked: true }, human)
  return {
    canvasId,
    open,
    locked,
    lockedHtml: store.getFrame(locked.id)!.html,
    openHtml: store.getFrame(open.id)!.html,
  }
}

function expectUntouched(s: ReturnType<typeof setup>) {
  expect(store.getTokens(s.canvasId).map((t) => [t.name, t.value])).toEqual([['--ink', '#111']])
  expect(persisted.get(`${s.canvasId}:--ink`)).toBe('#111')
  expect([...persisted.keys()].filter((k) => k.startsWith(s.canvasId))).toEqual([`${s.canvasId}:--ink`])
  expect(store.getFrame(s.locked.id)!.html).toBe(s.lockedHtml)
  expect(store.getFrame(s.open.id)!.html).toBe(s.openHtml)
}

describe('token edits against a locked frame', () => {
  it('refuses a rename and leaves tokens, persistence and every frame as they were', () => {
    const s = setup()
    expect(() => actions.setTokens(s.canvasId, [{ name: '--ink', newName: '--text' }], human)).toThrow(FrameLockedError)
    expectUntouched(s)
  })

  it('refuses a value edit the same way', () => {
    const s = setup()
    expect(() => actions.setTokens(s.canvasId, [{ name: '--ink', value: '#222' }], human)).toThrow(FrameLockedError)
    expectUntouched(s)
  })

  it('refuses a whole batch when a later edit reaches the locked frame', () => {
    const s = setup()
    actions.createTokens(s.canvasId, [{ name: '--gap', type: 'spacing', value: '4px' }], human)
    const gap = actions.createFrame(s.canvasId, { name: 'gap', html: body('gap:var(--gap)') }, human)!
    const gapHtml = store.getFrame(gap.id)!.html
    expect(() =>
      actions.setTokens(
        s.canvasId,
        [
          { name: '--gap', value: '8px' },
          { name: '--ink', value: '#222' },
        ],
        human,
      ),
    ).toThrow(FrameLockedError)
    expect(store.getTokens(s.canvasId).find((t) => t.name === '--gap')!.value).toBe('4px')
    expect(store.getFrame(gap.id)!.html).toBe(gapHtml)
    expect(store.getFrame(s.locked.id)!.html).toBe(s.lockedHtml)
  })

  it('refuses a delete the locked frame still names', () => {
    const s = setup()
    expect(() => actions.setTokens(s.canvasId, [{ name: '--ink', delete: true }], human)).toThrow(FrameLockedError)
    expectUntouched(s)
  })

  it('refuses a create that a locked frame already names', () => {
    const s = setup()
    const locked = actions.createFrame(s.canvasId, { name: 'early', html: body('color:var(--new)') }, human)!
    actions.updateFrame(locked.id, { locked: true }, human)
    expect(() => actions.createTokens(s.canvasId, [{ name: '--new', type: 'color', value: '#abc' }], human)).toThrow(
      FrameLockedError,
    )
    expect(store.getTokens(s.canvasId).map((t) => t.name)).toEqual(['--ink'])
    expect(persisted.has(`${s.canvasId}:--new`)).toBe(false)
  })

  it('refuses a theme rename that rewrites a locked frame', () => {
    const s = setup()
    // theme the tokens while the frame is still open, so its block carries the dark value, then lock it
    actions.updateFrame(s.locked.id, { locked: false }, human, OWNER)
    actions.setTokenThemes(s.canvasId, ['dark'], human)
    actions.setTokens(s.canvasId, [{ name: '--ink', themes: { dark: '#eee' } }], human)
    actions.updateFrame(s.locked.id, { locked: true }, human)
    const before = store.getFrame(s.locked.id)!.html
    expect(() => actions.setTokenThemes(s.canvasId, ['dark'], human, [{ from: 'dark', to: 'night' }])).toThrow(
      FrameLockedError,
    )
    expect(store.getTokenThemes(s.canvasId)).toEqual(['dark'])
    expect(store.getTokens(s.canvasId)[0]!.themes).toEqual({ dark: '#eee' })
    expect(store.getFrame(s.locked.id)!.html).toBe(before)
  })

  it('still edits freely once the frame is unlocked', () => {
    const s = setup()
    actions.updateFrame(s.locked.id, { locked: false }, human, OWNER)
    actions.setTokens(s.canvasId, [{ name: '--ink', newName: '--text' }], human)
    expect(store.getTokens(s.canvasId).map((t) => t.name)).toEqual(['--text'])
    expect(store.getFrame(s.locked.id)!.html).toContain('var(--text)')
  })
})
