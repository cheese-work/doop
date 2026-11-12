import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Canvas, Frame, FrameVersion } from '../shared/types.ts'

/**
 * A locked frame is immutable to every writer of its HTML or size, whoever the
 * actor is. The guard lives in the store, which is synchronous and the single
 * owner of frame state, so the lock check and the write happen in one tick.
 * Persistence is mocked; the DB-level guard has its own test.
 */

const mocks = vi.hoisted(() => ({
  saved: [] as string[],
  versions: new Map<string, unknown>(),
  /** runs while restoreFrameVersion awaits its version row */
  duringVersionRead: undefined as (() => void) | undefined,
}))
vi.mock('../server/db/persist.ts', () => ({
  saveTask: () => {},
  saveFeedback: () => {},
  saveComment: () => {},
  saveActivity: () => {},
  saveDecision: () => {},
  saveProposal: () => {},
  saveCanvas: () => {},
  saveFrame: (f: Frame) => {
    mocks.saved.push(f.id)
  },
  saveFrameNow: async () => {},
  saveFrameVersion: () => {},
  deleteFrame: () => {},
  getFrameVersion: async (_frameId: string, versionId: string) => {
    mocks.duringVersionRead?.()
    return mocks.versions.get(versionId)
  },
}))
vi.mock('../server/distill.ts', () => ({ onDecision: () => {} }))

const actions = await import('../server/actions.ts')
const { store } = await import('../server/store.ts')

const AGENT = { name: 'Claude', kind: 'agent' as const, color: '#7c3aed' }
const HUMAN = { name: 'Ada', kind: 'user' as const, color: '#0177d3' }

let frame: Frame

beforeEach(() => {
  mocks.saved.length = 0
  mocks.versions.clear()
  mocks.duringVersionRead = undefined
  const canvas: Canvas = {
    id: 'c1',
    name: 'Lock',
    ownerId: 'o1',
    createdAt: 0,
    updatedAt: 0,
    frames: [
      {
        id: 'f1',
        canvasId: 'c1',
        pageId: 'p1',
        name: 'Hero',
        html: '<h1>Original</h1>',
        x: 0,
        y: 0,
        width: 640,
        height: 480,
        createdAt: 0,
        updatedAt: 1_000,
        updatedBy: 'seed',
        locked: true,
      },
    ],
    pages: [{ id: 'p1', name: 'Page 1' }],
  }
  store.init([canvas])
  actions.wire(
    () => {},
    () => {},
  )
  frame = canvas.frames[0]!
})

const unchanged = () => {
  expect(frame.html).toBe('<h1>Original</h1>')
  expect(frame.width).toBe(640)
  expect(frame.height).toBe(480)
  expect(frame.updatedAt).toBe(1_000)
  expect(mocks.saved).toEqual([])
}

describe('store guard on a locked frame', () => {
  it.each([
    ['html', { html: '<p>x</p>' }],
    ['width', { width: 10 }],
    ['height', { height: 10 }],
    ['an unlock carried with html', { locked: false, html: '<p>x</p>' }],
  ])('refuses a %s write, naming the frame and saying it is locked', (_label, patch) => {
    expect(() => store.updateFrame('f1', patch, 'someone')).toThrow(/Hero.*f1.*locked|locked.*Hero/s)
    unchanged()
  })

  it('refuses from every actor, agent or human, through actions.updateFrame', () => {
    for (const actor of [AGENT, HUMAN]) {
      expect(() => actions.updateFrame('f1', { html: '<p>x</p>' }, actor)).toThrow(/locked/)
      expect(() => actions.updateFrame('f1', { width: 1, height: 1 }, actor)).toThrow(/locked/)
    }
    unchanged()
  })

  it('refuses a streamed append, start chunk or later chunk', () => {
    expect(() => actions.appendFrameHtml('f1', '<p>x</p>', AGENT, { start: true })).toThrow(/locked/)
    expect(() => actions.appendFrameHtml('f1', '<p>x</p>', AGENT)).toThrow(/locked/)
    unchanged()
  })

  it('still renames, moves, hides and unlocks', () => {
    actions.updateFrame('f1', { name: 'Renamed', x: 50, y: 60, hidden: true }, HUMAN)
    expect(frame).toMatchObject({ name: 'Renamed', x: 50, y: 60, hidden: true, locked: true })
    actions.updateFrame('f1', { locked: false }, HUMAN)
    expect(frame.locked).toBe(false)
    /* a human write: an agent's would leave a reveal playback running into the next test */
    actions.updateFrame('f1', { html: '<p>after unlock</p>' }, HUMAN)
    expect(frame.html).toBe('<p>after unlock</p>')
  })

  it('keeps an element-id stamp (annotation write) off a locked frame', async () => {
    const selector = 'body > h1:nth-of-type(1)'
    expect(await actions.ensureElementId('f1', selector, 'Ada')).toBeUndefined()
    unchanged()
    /* control: the same stamp lands once the frame is unlocked */
    frame.locked = false
    expect((await actions.ensureElementId('f1', selector, 'Ada'))?.id).toBeTruthy()
    expect(frame.html).toContain('data-doop-id')
  })

  it('skips a locked frame in the legacy element-id backfill', async () => {
    const counts = await actions.backfillElementIds(new Map())
    expect(counts).toEqual({ stamped: 0, lost: 0, failed: 0 })
    unchanged()
  })
})

describe('restore over a locked frame', () => {
  const version: FrameVersion = {
    id: 'v1',
    frameId: 'f1',
    canvasId: 'c1',
    html: '<h1>Older</h1>',
    width: 320,
    height: 200,
    savedAt: 1,
    savedBy: 'Ada',
    htmlBytes: 14,
  }

  it('is refused and changes neither HTML nor size', async () => {
    mocks.versions.set('v1', version)
    await expect(actions.restoreFrameVersion('f1', 'v1', AGENT)).rejects.toThrow(/locked/)
    unchanged()
  })

  it('is refused when the lock lands while the version row is being read', async () => {
    frame.locked = false
    mocks.versions.set('v1', version)
    mocks.duringVersionRead = () => {
      store.updateFrame('f1', { locked: true }, 'Ada')
      mocks.saved.length = 0
    }
    await expect(actions.restoreFrameVersion('f1', 'v1', AGENT)).rejects.toThrow(/locked/)
    expect(frame).toMatchObject({ html: '<h1>Original</h1>', width: 640, height: 480, locked: true })
    expect(mocks.saved).toEqual([])
  })
})

describe('lock set between writes of one stream', () => {
  it('lets the chunk before the lock land and refuses the one after', () => {
    frame.locked = false
    actions.appendFrameHtml('f1', '<p>one</p>', AGENT, { start: true })
    actions.updateFrame('f1', { locked: true }, HUMAN)
    expect(() => actions.appendFrameHtml('f1', '<p>two</p>', AGENT)).toThrow(/locked/)
    expect(frame.html).toBe('<p>one</p>')
  })
})

describe('conditional writes (expectedUpdatedAt)', () => {
  beforeEach(() => {
    frame.locked = false
  })

  it('refuses a stale expectedUpdatedAt and writes nothing', () => {
    expect(() => store.updateFrame('f1', { html: '<p>x</p>' }, 'a', { expectedUpdatedAt: 999 })).toThrow(
      /changed|stale/i,
    )
    unchanged()
  })

  it('accepts a matching expectedUpdatedAt', () => {
    store.updateFrame('f1', { html: '<p>x</p>' }, 'a', { expectedUpdatedAt: 1_000 })
    expect(frame.html).toBe('<p>x</p>')
  })

  it('lets two clients that read the same version write once, so no update is lost', () => {
    const outcomes = ['<p>A</p>', '<p>B</p>'].map((html) => {
      try {
        actions.updateFrame('f1', { html }, AGENT, { expectedUpdatedAt: 1_000 })
        return 'ok'
      } catch (e) {
        return (e as Error).name
      }
    })
    expect(outcomes).toEqual(['ok', 'FrameStaleError'])
    expect(frame.html).toBe('<p>A</p>')
  })

  it('applies to appendFrameHtml too', () => {
    expect(() => actions.appendFrameHtml('f1', '<p>x</p>', AGENT, { start: true, expectedUpdatedAt: 5 })).toThrow(
      /changed|stale/i,
    )
    unchanged()
  })
})

describe('every writer of frame html, width and height goes through the store guard', () => {
  const SERVER = path.join(process.cwd(), 'server')
  const files = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory()
        ? e.name === 'migrations'
          ? []
          : files(path.join(dir, e.name))
        : e.name.endsWith('.ts')
          ? [path.join(dir, e.name)]
          : [],
    )
  const source = (f: string) => readFileSync(f, 'utf8')
  const rel = (f: string) => path.relative(SERVER, f)

  it('only actions.ts calls store.updateFrame, and nothing assigns a frame column outside store.ts', () => {
    const callers = files(SERVER)
      .filter((f) => /\bstore\.updateFrame\(/.test(source(f)))
      .map(rel)
    expect(callers).toEqual(['actions.ts'])
    const assigners = files(SERVER)
      .filter((f) => rel(f) !== 'store.ts')
      .filter((f) =>
        /\b(?:frame|f|before|current|existing|next)\.(?:html|width|height)\s*(?:\+|-)?=(?!=)/.test(source(f)),
      )
      .map(rel)
    expect(assigners).toEqual([])
  })

  it('only persist.ts writes the frames table, and its upsert guards html, width and height by the lock', () => {
    const writers = files(SERVER)
      .filter((f) => /\b(?:insert|update|delete)\(\s*(?:t|schema)\.frames\b/.test(source(f)))
      .map(rel)
    expect(writers).toEqual(['db/persist.ts'])
    expect(source(path.join(SERVER, 'db/persist.ts'))).toMatch(/locked IS TRUE/)
  })
})
