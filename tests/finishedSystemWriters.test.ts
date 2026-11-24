import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Actor, ElementComment } from '../shared/types.ts'

/**
 * CHE-9398 L4: the system writers (`systemContext()` callers in `server/actions.ts`) respect a
 * Finished page. A frame on one is byte-equal (HTML and `updatedAt`) after a token value edit, a
 * component main edit, an element comment and a backfill; a token rename that would change it is
 * refused whole; the same edits on an open page still apply; a locked frame still refuses first.
 * No route sets `finished` yet, so the tests flip the flag on the page row the way L3's do.
 */

const fake = vi.hoisted(() => ({ comments: new Map<string, unknown>() }))
vi.mock('../server/db/persist.ts', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  const noop = () => {}
  return {
    ...Object.fromEntries(Object.keys(actual).map((key) => [key, noop])),
    saveFrameNow: async () => {},
    saveNewComment: async () => {},
    saveCommentNow: async () => {},
    findCommentRow: async (id: string) => fake.comments.get(id),
    componentsBehind: async () => [],
  }
})
vi.mock('../server/fonts.ts', () => ({ fontsForCanvas: () => [] }))
vi.mock('../server/resident.ts', () => ({ onFeedback: () => {} }))
vi.mock('../server/distill.ts', () => ({ onDecision: () => {} }))

const actions = await import('../server/actions.ts')
const propagation = await import('../server/propagation.ts')
const { createComponentFromHtml } = await import('../server/componentActions.ts')
const { store, FrameLockedError } = await import('../server/store.ts')
const { PageFinishedError } = await import('../server/pageState.ts')
const { setLockOwners, systemContext } = await import('../server/writePolicy.ts')

const human: Actor = { name: 'Kevin', kind: 'user', color: '#2743ee' }
setLockOwners(['kevin-id'])
actions.wire(
  () => {},
  () => {},
)

const body = (inner: string, style = '') => `<html><head></head><body style="${style}">${inner}</body></html>`

/** A canvas with an open page and a page that is Finished once `finish()` runs. */
function setup() {
  const canvas = store.createCanvas('finished writers', 'kevin')
  canvas.pages = [
    { id: 'open', name: 'Open' },
    { id: 'fin', name: 'Done' },
  ]
  const make = (name: string, html: string, pageId: string) =>
    actions.createFrame(canvas.id, { name, html, pageId }, human)!
  const finish = () => {
    canvas.pages = canvas.pages!.map((page) =>
      page.id === 'fin' ? { ...page, finished: { at: 1, by: 'Cheese' } } : page,
    )
  }
  return { canvasId: canvas.id, make, finish }
}

/** HTML and updatedAt: what "byte-equal" means for a frame the system must not touch */
const snap = (id: string) => {
  const frame = store.getFrame(id)!
  return { html: frame.html, updatedAt: frame.updatedAt }
}

describe('token value edit', () => {
  it('leaves a Finished frame byte-equal and still restyles the open page', () => {
    const s = setup()
    actions.createTokens(s.canvasId, [{ name: '--ink', type: 'color', value: '#111' }], human)
    const open = s.make('open', body('<p>o</p>', 'color:var(--ink)'), 'open')
    const done = s.make('done', body('<p>d</p>', 'color:var(--ink)'), 'fin')
    s.finish()
    const before = snap(done.id)
    actions.setTokens(s.canvasId, [{ name: '--ink', value: '#222' }], human)
    expect(store.getTokens(s.canvasId).find((t) => t.name === '--ink')!.value).toBe('#222')
    expect(snap(done.id)).toEqual(before)
    expect(store.getFrame(open.id)!.html).toContain('#222')
  })

  it('restyles the same frame once its page is open', () => {
    const s = setup()
    actions.createTokens(s.canvasId, [{ name: '--ink', type: 'color', value: '#111' }], human)
    const done = s.make('done', body('<p>d</p>', 'color:var(--ink)'), 'fin')
    actions.setTokens(s.canvasId, [{ name: '--ink', value: '#222' }], human)
    expect(store.getFrame(done.id)!.html).toContain('#222')
  })

  it('still refuses whole when a locked frame on a Finished page would change', () => {
    const s = setup()
    actions.createTokens(s.canvasId, [{ name: '--ink', type: 'color', value: '#111' }], human)
    const open = s.make('open', body('<p>o</p>', 'color:var(--ink)'), 'open')
    const locked = s.make('locked', body('<p>l</p>', 'color:var(--ink)'), 'fin')
    actions.updateFrame(locked.id, { locked: true }, human)
    s.finish()
    const openBefore = snap(open.id)
    const lockedBefore = snap(locked.id)
    expect(() => actions.setTokens(s.canvasId, [{ name: '--ink', value: '#222' }], human)).toThrow(FrameLockedError)
    expect(store.getTokens(s.canvasId).find((t) => t.name === '--ink')!.value).toBe('#111')
    expect(snap(open.id)).toEqual(openBefore)
    expect(snap(locked.id)).toEqual(lockedBefore)
  })
})

describe('token rename', () => {
  it('is refused whole when a Finished frame uses the old name, and the token list is unchanged', () => {
    const s = setup()
    actions.createTokens(s.canvasId, [{ name: '--ink', type: 'color', value: '#111' }], human)
    const open = s.make('open', body('<p>o</p>', 'color:var(--ink)'), 'open')
    const done = s.make('done', body('<p>d</p>', 'color:var(--ink)'), 'fin')
    s.finish()
    const tokensBefore = store.getTokens(s.canvasId).map((t) => [t.name, t.value])
    const openBefore = snap(open.id)
    const doneBefore = snap(done.id)
    expect(() => actions.setTokens(s.canvasId, [{ name: '--ink', newName: '--text' }], human)).toThrow(
      PageFinishedError,
    )
    expect(store.getTokens(s.canvasId).map((t) => [t.name, t.value])).toEqual(tokensBefore)
    expect(snap(open.id)).toEqual(openBefore)
    expect(snap(done.id)).toEqual(doneBefore)
  })

  it('applies on the open page when no Finished frame uses the name', () => {
    const s = setup()
    actions.createTokens(s.canvasId, [{ name: '--ink', type: 'color', value: '#111' }], human)
    const open = s.make('open', body('<p>o</p>', 'color:var(--ink)'), 'open')
    s.make('done', body('<p>d</p>'), 'fin')
    s.finish()
    actions.setTokens(s.canvasId, [{ name: '--ink', newName: '--text' }], human)
    expect(store.getTokens(s.canvasId).map((t) => t.name)).toEqual(['--text'])
    expect(store.getFrame(open.id)!.html).toContain('var(--text')
  })
})

describe('component propagation', () => {
  it('skips an instance on a Finished page and still reaches the open page', async () => {
    const s = setup()
    const def = createComponentFromHtml(
      s.canvasId,
      { name: 'Badge', html: '<span class="b">New</span>' },
      human,
    ).component
    const use = body('<doop-use component="Badge"></doop-use>')
    const open = s.make('open', use, 'open')
    const done = s.make('done', use, 'fin')
    s.finish()
    await propagation.whenIdle()
    const before = snap(done.id)
    const main = store.getFrame(def.mainFrameId!)!
    actions.updateFrame(main.id, { html: main.html.replace('>New<', '>Fresh<') }, human)
    await propagation.whenIdle()
    expect(snap(done.id)).toEqual(before)
    expect(store.getFrame(done.id)!.html).toContain('New')
    expect(store.getFrame(open.id)!.html).toContain('Fresh')
  })
})

describe('element id stamp', () => {
  it('falls back to the frame on a Finished page and stamps on an open one', async () => {
    const s = setup()
    const open = s.make('open', '<p>One</p>', 'open')
    const done = s.make('done', '<p>One</p>', 'fin')
    s.finish()
    const before = snap(done.id)
    expect(await actions.ensureElementId(done.id, 'body > p:nth-of-type(1)', 'Kevin')).toBeUndefined()
    expect(snap(done.id)).toEqual(before)
    const stamped = await actions.ensureElementId(open.id, 'body > p:nth-of-type(1)', 'Kevin')
    expect(stamped?.id).toMatch(/^[a-z0-9]{6}$/)
    expect(store.getFrame(open.id)!.html).toContain('data-doop-id')
  })
})

describe('element id backfill', () => {
  const comment = (id: string, frameId: string, canvasId: string): ElementComment => ({
    id,
    canvasId,
    frameId,
    snippet: '<p>',
    from: 'alice',
    text: id,
    at: 1,
  })

  beforeEach(() => fake.comments.clear())

  it('leaves a Finished frame and its legacy row alone, and stamps the open page', async () => {
    const s = setup()
    const open = s.make('open', '<p>One</p>', 'open')
    const done = s.make('done', '<p>One</p>', 'fin')
    s.finish()
    actions.hydrateLogs({
      tasks: new Map(),
      feedback: new Map(),
      comments: new Map([
        [s.canvasId, [comment('k-open', open.id, s.canvasId), comment('k-done', done.id, s.canvasId)]],
      ]),
      activity: new Map(),
      decisions: new Map(),
      proposals: new Map(),
    })
    const before = snap(done.id)
    const counts = await actions.backfillElementIds(
      new Map([
        ['k-open', 'body > p:nth-of-type(1)'],
        ['k-done', 'body > p:nth-of-type(1)'],
      ]),
    )
    expect(counts).toEqual({ stamped: 1, lost: 0, failed: 0 })
    expect(snap(done.id)).toEqual(before)
    expect((await actions.findComment('k-done'))!.elementId).toBeUndefined()
    expect((await actions.findComment('k-open'))!.elementId).toMatch(/^[a-z0-9]{6}$/)
    expect(store.getFrame(open.id)!.html).toContain('data-doop-id')
  })
})

describe('heal from main', () => {
  it('writes no frame on a Finished page', async () => {
    const s = setup()
    const def = createComponentFromHtml(
      s.canvasId,
      { name: 'Btn', html: '<button class="b">Buy</button>' },
      human,
    ).component
    const main = store.getFrame(def.mainFrameId!)!
    /* the main moves to the Finished page; the definition goes hollow, as a boot after a lost write loads it */
    store.updateFrame(systemContext(), main.id, { pageId: 'fin' }, 'Kevin', { annotation: true })
    s.finish()
    const filled = store.getComponents(s.canvasId).find((d) => d.id === def.id)!
    store.saveComponent(s.canvasId, {
      ...filled,
      template: '',
      css: '',
      rawCss: '',
      props: [],
      slots: [],
      rev: 0,
      mainFrameId: null,
      history: [],
    })
    const before = snap(main.id)
    await actions.healHollowComponents()
    expect(snap(main.id)).toEqual(before)
  })
})
