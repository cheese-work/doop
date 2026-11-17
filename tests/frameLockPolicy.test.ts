import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/* CHE-6626 (G5a of CHE-6078 r5, "Yêu cầu 2 · Chốt = khóa"): a locked frame refuses every write from every
   actor; lock_if_version is a compare-and-set on the attested version; lockEpoch counts unlocks; only a
   configured owner, through a user session, unlocks. Tests (a)-(j) of r5 are labelled below. */
const db = vi.hoisted(() => ({
  saveFrame: vi.fn(),
  saveActivity: vi.fn(),
  getFrameVersion: vi.fn(async () => ({
    id: 'v1',
    frameId: '',
    canvasId: '',
    html: '<p>old</p>',
    width: 10,
    height: 10,
    savedBy: 'x',
    savedAt: 1,
  })),
}))
vi.mock('../server/db/persist.ts', () => {
  const noop = () => undefined
  return {
    deleteCanvas: noop,
    deleteFrame: noop,
    deleteGuideline: noop,
    deleteMember: noop,
    deleteReference: noop,
    saveActivity: db.saveActivity,
    saveCanvas: noop,
    saveCanvasCopy: noop,
    saveFeedback: noop,
    saveFrame: db.saveFrame,
    saveFrameVersion: noop,
    getFrameVersion: db.getFrameVersion,
    saveGuideline: noop,
    saveMember: noop,
    savePageCopy: async () => undefined,
    saveReference: noop,
    saveTask: noop,
  }
})
vi.mock('../server/resident.ts', () => ({ onFeedback: () => {} }))

import * as actions from '../server/actions.ts'
import { buildMcpServer } from '../server/mcp.ts'
import { store } from '../server/store.ts'
import {
  erasureContext,
  PolicyRefused,
  setLockOwners,
  setTaskIdentityVerifier,
  systemContext,
  type WriteContext,
} from '../server/writePolicy.ts'
import { canvasPages } from '../shared/pages.ts'

const sys = systemContext()
const cheese: WriteContext = { kind: 'user', userId: 'cheese' }
const bob: WriteContext = { kind: 'user', userId: 'bob' }
const agent: WriteContext = { kind: 'agent' }
const cheeseActor = actions.resolveActor({ name: 'Cheese', kind: 'user' })
const agentActor = actions.resolveActor({ name: 'Designer', kind: 'agent' })

/** a canvas nobody bound, two pages, a frame `f` on the first (v1 at attestation time) and `g` on the second */
function fixture() {
  const canvas = store.createCanvas('Lock', 'alice')
  const pa = canvasPages(canvas)[0]!.id
  store.setPages(sys, canvas.id, [
    { id: pa, name: 'A' },
    { id: 'pb', name: 'B' },
  ])
  const f = { ...store.createFrame(sys, canvas.id, { name: 'f', pageId: pa, html: '<p>v1</p>' }, 'x')! }
  const g = { ...store.createFrame(sys, canvas.id, { name: 'g', pageId: 'pb', html: '<p>g</p>' }, 'x')! }
  return { canvas, pa, pb: 'pb', f, g }
}

function locked() {
  const fx = fixture()
  const res = store.lockIfVersion(agent, fx.f.id, fx.f.updatedAt, 'att-1')
  expect(res).toMatchObject({ ok: true })
  return fx
}

beforeEach(() => {
  for (const canvas of store.allCanvases()) store.deleteCanvas(erasureContext(), canvas.id)
  setTaskIdentityVerifier(undefined)
  setLockOwners(['cheese'])
  db.saveFrame.mockClear()
  db.saveActivity.mockClear()
})

describe('(a) every write path refuses a locked frame, for every actor', () => {
  const actors: [string, WriteContext][] = [
    ['system', sys],
    ['user (an owner)', cheese],
    ['user', bob],
    ['agent', agent],
  ]
  const paths: [string, (ctx: WriteContext, f: ReturnType<typeof locked>) => unknown][] = [
    ['html', (ctx, f) => store.updateFrame(ctx, f.f.id, { html: '<p>x</p>' }, 'a')],
    ['append stream (html grows)', (ctx, f) => store.updateFrame(ctx, f.f.id, { html: f.f.html + '<i/>' }, 'a')],
    [
      'restore version (html + size)',
      (ctx, f) => store.updateFrame(ctx, f.f.id, { html: 'o', width: 1, height: 1 }, 'a'),
    ],
    ['move', (ctx, f) => store.updateFrame(ctx, f.f.id, { x: 999 }, 'a')],
    ['resize', (ctx, f) => store.updateFrame(ctx, f.f.id, { width: 12 }, 'a')],
    ['rename', (ctx, f) => store.updateFrame(ctx, f.f.id, { name: 'new' }, 'a')],
    ['change page', (ctx, f) => store.updateFrame(ctx, f.f.id, { pageId: f.pb }, 'a')],
    ['hide', (ctx, f) => store.updateFrame(ctx, f.f.id, { hidden: true }, 'a')],
    ['approval', (ctx, f) => store.updateFrame(ctx, f.f.id, { approval: null }, 'a')],
    ['delete frame', (ctx, f) => store.deleteFrame(ctx, f.f.id)],
  ]
  for (const [actorName, ctx] of actors)
    for (const [pathName, run] of paths)
      it(`${actorName}: ${pathName}`, () => {
        const f = locked()
        const before = { ...store.getFrame(f.f.id)! }
        expect(() => run(ctx, f)).toThrow(PolicyRefused)
        expect(store.getFrame(f.f.id)).toEqual(before)
      })

  it('actions: updateFrame, appendFrameHtml, restoreFrameVersion, deleteFrame refuse and leave the frame as it was', async () => {
    const f = locked()
    for (const actor of [cheeseActor, agentActor]) {
      expect(() => actions.updateFrame(f.f.id, { html: '<p>x</p>' }, actor)).toThrow(PolicyRefused)
      expect(() => actions.appendFrameHtml(f.f.id, '<i/>', actor, { start: true })).toThrow(PolicyRefused)
      await expect(actions.restoreFrameVersion(f.f.id, 'v1', actor)).rejects.toBeInstanceOf(PolicyRefused)
      expect(() => actions.deleteFrame(f.f.id, actor)).toThrow(PolicyRefused)
    }
    expect(store.getFrame(f.f.id)?.html).toBe('<p>v1</p>')
  })

  it('MCP: set_frame_html, edit_frame_html, append_frame_html, update_frame, delete_frame all refuse', async () => {
    const f = locked()
    const server = buildMcpServer('Owner', 'alice')
    const client = new Client({ name: 'g5a', version: '1.0.0' })
    const [a, b] = InMemoryTransport.createLinkedPair()
    await server.connect(b)
    await client.connect(a)
    try {
      const calls = [
        { name: 'set_frame_html', arguments: { agent_name: 'D', frame_id: f.f.id, html: '<p>x</p>' } },
        { name: 'edit_frame_html', arguments: { agent_name: 'D', frame_id: f.f.id, old_str: 'v1', new_str: 'v2' } },
        {
          name: 'append_frame_html',
          arguments: { agent_name: 'D', frame_id: f.f.id, html_chunk: '<i/>', start: true },
        },
        { name: 'update_frame', arguments: { agent_name: 'D', frame_id: f.f.id, x: 500 } },
        { name: 'delete_frame', arguments: { agent_name: 'D', frame_id: f.f.id } },
      ]
      for (const call of calls) {
        const res = await client.callTool(call)
        expect(res.isError, call.name).toBe(true)
        expect(JSON.stringify(res.content), call.name).toMatch(/policy_refused/)
      }
      expect(store.getFrame(f.f.id)?.html).toBe('<p>v1</p>')
    } finally {
      await client.close()
      await server.close()
    }
  })

  it('duplicatePage copies a locked frame and the copy is not locked', async () => {
    const f = locked()
    const copy = await store.duplicatePage(sys, f.canvas.id, f.pa, 'x')
    expect(copy?.frames).toHaveLength(1)
    const dup = store.getFrame(copy!.frames[0]!.id)!
    expect(dup.locked).toBeFalsy()
    expect(dup.lockAttestationId).toBeUndefined()
    expect(store.getFrame(f.f.id)?.locked).toBe(true)
  })

  it('setPages: removing a page that still holds a locked frame is refused; renaming it is not', () => {
    const f = locked()
    expect(() => store.setPages(sys, f.canvas.id, [{ id: f.pb, name: 'B' }])).toThrow(PolicyRefused)
    expect(canvasPages(store.getCanvas(f.canvas.id)!)).toHaveLength(2)
    expect(() =>
      store.setPages(sys, f.canvas.id, [
        { id: f.pa, name: 'Renamed' },
        { id: f.pb, name: 'B' },
      ]),
    ).not.toThrow()
  })
})

describe('(b) a canvas with a locked frame cannot be deleted', () => {
  it('refuses for system, user and agent; account erasure is the one way out', () => {
    const f = locked()
    for (const ctx of [sys, cheese, agent]) expect(() => store.deleteCanvas(ctx, f.canvas.id)).toThrow(PolicyRefused)
    expect(store.getCanvas(f.canvas.id)).toBeDefined()
    expect(store.deleteCanvas(erasureContext(), f.canvas.id)).toBeDefined()
  })
})

describe('(c) an agent never unlocks', () => {
  it('store, actions and MCP refuse locked=false; the frame stays locked', async () => {
    const f = locked()
    expect(() => store.updateFrame(agent, f.f.id, { locked: false }, 'a')).toThrow(PolicyRefused)
    expect(() => actions.updateFrame(f.f.id, { locked: false }, agentActor)).toThrow(PolicyRefused)
    const server = buildMcpServer('Owner', 'alice')
    const client = new Client({ name: 'g5a', version: '1.0.0' })
    const [a, b] = InMemoryTransport.createLinkedPair()
    await server.connect(b)
    await client.connect(a)
    try {
      const res = await client.callTool({
        name: 'update_frame',
        arguments: { agent_name: 'D', frame_id: f.f.id, locked: false },
      })
      expect(res.isError).toBe(true)
      expect(JSON.stringify(res.content)).toMatch(/policy_refused/)
    } finally {
      await client.close()
      await server.close()
    }
    expect(store.getFrame(f.f.id)?.locked).toBe(true)
  })

  it('an agent may lock (a lock only narrows access)', () => {
    const f = fixture()
    expect(store.updateFrame(agent, f.f.id, { locked: true }, 'a')?.locked).toBe(true)
  })
})

describe('(d) only an owner, in a user session, unlocks', () => {
  it('a user outside DOOP_LOCK_OWNERS is refused; an owner unlocks and it is logged', () => {
    const f = locked()
    expect(() => store.updateFrame(bob, f.f.id, { locked: false }, 'bob')).toThrow(PolicyRefused)
    expect(() => actions.updateFrame(f.f.id, { locked: false }, cheeseActor)).toThrow(PolicyRefused) // no userId
    expect(store.getFrame(f.f.id)?.locked).toBe(true)

    const frame = actions.updateFrame(f.f.id, { locked: false }, cheeseActor, { userId: 'cheese' })
    expect(frame?.locked).toBe(false)
    expect(db.saveActivity.mock.calls.some(([, item]) => /unlocked/.test((item as { message: string }).message))).toBe(
      true,
    )
  })

  it('with no owners configured nobody unlocks (fail closed); system never unlocks', () => {
    const f = locked()
    setLockOwners(undefined)
    expect(() => store.updateFrame(cheese, f.f.id, { locked: false }, 'c')).toThrow(PolicyRefused)
    setLockOwners(['cheese'])
    expect(() => store.updateFrame(sys, f.f.id, { locked: false }, 's')).toThrow(PolicyRefused)
  })

  it('unlock together with any other change is refused; the other change needs its own call after', () => {
    const f = locked()
    expect(() => store.updateFrame(cheese, f.f.id, { locked: false, name: 'sneaky' }, 'c')).toThrow(PolicyRefused)
    expect(store.getFrame(f.f.id)?.locked).toBe(true)
    store.updateFrame(cheese, f.f.id, { locked: false }, 'c')
    expect(store.updateFrame(cheese, f.f.id, { name: 'ok' }, 'c')?.name).toBe('ok')
  })
})

describe('lock_if_version, lockEpoch, unlock voids the attestation', () => {
  it('locks at the attested version, records the attestation, and leaves updatedAt alone', () => {
    const f = fixture()
    const res = store.lockIfVersion(agent, f.f.id, f.f.updatedAt, 'att-1')
    expect(res).toMatchObject({ ok: true })
    const frame = store.getFrame(f.f.id)!
    expect(frame).toMatchObject({ locked: true, lockAttestationId: 'att-1', updatedAt: f.f.updatedAt })
    expect(frame.lockEpoch ?? 0).toBe(0)
    expect(db.saveFrame).toHaveBeenLastCalledWith(expect.objectContaining({ id: f.f.id, locked: true }), true)
  })

  it('is idempotent for the same attestation: OK, no write, updatedAt and the id untouched', () => {
    const f = locked()
    db.saveFrame.mockClear()
    const again = store.lockIfVersion(agent, f.f.id, f.f.updatedAt, 'att-1')
    expect(again).toMatchObject({ ok: true })
    expect(db.saveFrame).not.toHaveBeenCalled()
    expect(store.getFrame(f.f.id)).toMatchObject({ locked: true, updatedAt: f.f.updatedAt, lockAttestationId: 'att-1' })
  })

  it('a locked frame keeps its attestation: another id is refused, by anyone, until an owner unlocks', () => {
    const f = locked()
    db.saveFrame.mockClear()
    for (const ctx of [agent, sys, bob, cheese]) {
      expect(() => store.lockIfVersion(ctx, f.f.id, f.f.updatedAt, 'att-other')).toThrow(PolicyRefused)
    }
    expect(store.getFrame(f.f.id)?.lockAttestationId).toBe('att-1')
    expect(db.saveFrame).not.toHaveBeenCalled()
    /* after the owner unlocks, the frame is at a new version and may be attested again */
    const unlocked = store.updateFrame(cheese, f.f.id, { locked: false }, 'c')!
    expect(store.lockIfVersion(agent, f.f.id, unlocked.updatedAt, 'att-other')).toMatchObject({ ok: true })
    expect(store.getFrame(f.f.id)?.lockAttestationId).toBe('att-other')
  })

  it('a frame locked by hand has no attestation, and a call cannot attach one to it', () => {
    const f = fixture()
    store.updateFrame(sys, f.f.id, { locked: true }, 'x')
    const lockedAt = store.getFrame(f.f.id)!.updatedAt
    expect(() => store.lockIfVersion(agent, f.f.id, lockedAt, 'att-1')).toThrow(PolicyRefused)
    expect(store.getFrame(f.f.id)?.lockAttestationId).toBeUndefined()
  })

  it('actions and MCP surface the refusal; the publish lifecycle gets no card', async () => {
    const f = locked()
    const retry = actions.lockFramesForPublish(
      [{ frameId: f.f.id, attestedUpdatedAt: f.f.updatedAt, attestationId: 'att-1' }],
      agentActor,
    )
    expect(retry.cardAllowed).toBe(true)
    const other = actions.lockFramesForPublish(
      [{ frameId: f.f.id, attestedUpdatedAt: f.f.updatedAt, attestationId: 'att-other' }],
      agentActor,
    )
    expect(other.cardAllowed).toBe(false)
    expect(other.results[0]).toMatchObject({ ok: false, error: 'policy_refused' })
    expect(store.getFrame(f.f.id)?.lockAttestationId).toBe('att-1')
  })

  it('a stale version is not locked and answers version_changed', () => {
    const f = fixture()
    store.updateFrame(sys, f.f.id, { html: '<p>v2</p>' }, 'x')
    const res = store.lockIfVersion(agent, f.f.id, f.f.updatedAt, 'att-1')
    expect(res).toMatchObject({ ok: false, error: 'version_changed' })
    expect(store.getFrame(f.f.id)?.locked).toBeFalsy()
  })

  it('an unknown frame is undefined, like the other mutators', () => {
    expect(store.lockIfVersion(agent, 'nope', 1, 'a')).toBeUndefined()
  })

  it('unlock raises lockEpoch, drops the attestation, moves updatedAt; epochs are never reused', () => {
    const f = locked()
    const first = store.updateFrame(cheese, f.f.id, { locked: false }, 'c')!
    expect(first.lockEpoch).toBe(1)
    expect(first.lockAttestationId).toBeUndefined()
    expect(first.updatedAt).toBeGreaterThan(f.f.updatedAt)
    /* the attestation of the old version cannot lock the frame again */
    expect(store.lockIfVersion(agent, f.f.id, f.f.updatedAt, 'att-1')).toMatchObject({
      ok: false,
      error: 'version_changed',
    })
    expect(store.lockIfVersion(agent, f.f.id, first.updatedAt, 'att-3')).toMatchObject({ ok: true })
    expect(store.getFrame(f.f.id)?.lockEpoch).toBe(1)
    expect(store.updateFrame(cheese, f.f.id, { locked: false }, 'c')?.lockEpoch).toBe(2)
  })

  it('lock_if_version still passes the G1 binding for a task agent that Multica did not vouch for', () => {
    const f = fixture()
    store.bindProject(sys, f.canvas.id, 'proj-a')
    expect(() => store.lockIfVersion({ kind: 'agent', taskId: 't' }, f.f.id, f.f.updatedAt, 'a')).toThrow(PolicyRefused)
    expect(store.getFrame(f.f.id)?.locked).toBeFalsy()
  })
})

describe('fence: expected_updated_at', () => {
  it('a stale version is an error and writes nothing; the current one writes', () => {
    const f = fixture()
    store.updateFrame(sys, f.f.id, { html: '<p>v2</p>' }, 'x')
    const current = store.getFrame(f.f.id)!.updatedAt
    expect(() => store.updateFrame(agent, f.f.id, { html: '<p>v3</p>' }, 'a', f.f.updatedAt)).toThrow(
      expect.objectContaining({ code: 'version_changed' }),
    )
    expect(store.getFrame(f.f.id)?.html).toBe('<p>v2</p>')
    expect(store.updateFrame(agent, f.f.id, { html: '<p>v3</p>' }, 'a', current)?.html).toBe('<p>v3</p>')
  })

  it('MCP set_frame_html, edit_frame_html, append_frame_html and update_frame take it', async () => {
    const f = fixture()
    const server = buildMcpServer('Owner', 'alice')
    const client = new Client({ name: 'g5a', version: '1.0.0' })
    const [a, b] = InMemoryTransport.createLinkedPair()
    await server.connect(b)
    await client.connect(a)
    try {
      const stale = new Date(f.f.updatedAt - 5).toISOString()
      const calls = [
        {
          name: 'set_frame_html',
          arguments: { agent_name: 'D', frame_id: f.f.id, html: '<p>x</p>', expected_updated_at: stale },
        },
        {
          name: 'edit_frame_html',
          arguments: { agent_name: 'D', frame_id: f.f.id, old_str: 'v1', new_str: 'v2', expected_updated_at: stale },
        },
        {
          name: 'append_frame_html',
          arguments: { agent_name: 'D', frame_id: f.f.id, html_chunk: '<i/>', start: true, expected_updated_at: stale },
        },
        { name: 'update_frame', arguments: { agent_name: 'D', frame_id: f.f.id, x: 5, expected_updated_at: stale } },
      ]
      for (const call of calls) {
        const res = await client.callTool(call)
        expect(res.isError, call.name).toBe(true)
        expect(JSON.stringify(res.content), call.name).toMatch(/version_changed/)
      }
      expect(store.getFrame(f.f.id)?.html).toBe('<p>v1</p>')
      const ok = await client.callTool({
        name: 'update_frame',
        arguments: {
          agent_name: 'D',
          frame_id: f.f.id,
          x: 5,
          expected_updated_at: new Date(f.f.updatedAt).toISOString(),
        },
      })
      expect(ok.isError).toBeFalsy()
    } finally {
      await client.close()
      await server.close()
    }
  })
})

describe('the publish lifecycle: attest -> lock every frame -> card', () => {
  const entry = (frame: { id: string; updatedAt: number }, attestationId = 'att-1') => ({
    frameId: frame.id,
    attestedUpdatedAt: frame.updatedAt,
    attestationId,
  })

  it('(e) frame 1 locks, frame 2 fails: no card; the retry locks the rest and allows the card', () => {
    const f = fixture()
    const attested = [entry(f.f), entry(f.g)]
    /* frame 2 was edited after it was attested */
    store.updateFrame(sys, f.g.id, { html: '<p>g2</p>' }, 'x')
    const first = actions.lockFramesForPublish(attested, agentActor)
    expect(first.cardAllowed).toBe(false)
    expect(first.results.map((r) => r.ok)).toEqual([true, false])
    expect(store.getFrame(f.f.id)?.locked).toBe(true) // the safe side stays locked
    expect(store.getFrame(f.g.id)?.locked).toBeFalsy()

    /* the designer attests the edited frame again and publishes again; the frame that already holds its
       lock is retried with the attestation it holds (a no-op), and the new frame locks with the new one */
    const second = actions.lockFramesForPublish([entry(f.f), entry(store.getFrame(f.g.id)!, 'att-9')], agentActor)
    expect(second.cardAllowed).toBe(true)
    expect(store.getFrame(f.f.id)?.lockAttestationId).toBe('att-1')
    expect(store.getFrame(f.g.id)?.lockAttestationId).toBe('att-9')
  })

  it('(f) an open append stream ends when the frame locks, and a later chunk is refused', () => {
    const f = fixture()
    actions.appendFrameHtml(f.f.id, '<p>v1</p><b>', agentActor, { start: true })
    expect(actions.isFrameStreaming(f.f.id)).toBe(true)
    const v = store.getFrame(f.f.id)!
    const done = actions.lockFramesForPublish([entry(v)], agentActor)
    expect(done.cardAllowed).toBe(true)
    expect(actions.isFrameStreaming(f.f.id)).toBe(false)
    expect(() => actions.appendFrameHtml(f.f.id, '</b>', agentActor, {})).toThrow(PolicyRefused)
  })

  it('(g) two writes at once to a frame that just locked are both refused', async () => {
    const f = locked()
    const results = await Promise.allSettled([
      Promise.resolve().then(() => actions.updateFrame(f.f.id, { html: '<p>a</p>' }, agentActor)),
      Promise.resolve().then(() => actions.updateFrame(f.f.id, { html: '<p>b</p>' }, cheeseActor)),
    ])
    expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected'])
    expect(store.getFrame(f.f.id)?.html).toBe('<p>v1</p>')
  })

  it('(h) a write between attest and lock gives version_changed and no card', () => {
    const f = fixture()
    const attested = entry(f.f)
    store.updateFrame(agent, f.f.id, { html: '<p>sneaked in</p>' }, 'a')
    const out = actions.lockFramesForPublish([attested], agentActor)
    expect(out.cardAllowed).toBe(false)
    expect(out.results[0]).toMatchObject({ ok: false, error: 'version_changed' })
    expect(store.getFrame(f.f.id)?.locked).toBeFalsy()
  })

  it('(i) a write between lock_if_version and the next step is refused and the version does not move', () => {
    const f = fixture()
    const out = actions.lockFramesForPublish([entry(f.f)], agentActor)
    expect(out.cardAllowed).toBe(true)
    expect(() => actions.updateFrame(f.f.id, { html: '<p>late</p>' }, agentActor)).toThrow(PolicyRefused)
    expect(store.getFrame(f.f.id)?.updatedAt).toBe(f.f.updatedAt)
  })

  it('(j) between the first and the last lock, the frames already locked refuse every write', () => {
    const f = fixture()
    const g2 = store.createFrame(sys, f.canvas.id, { name: 'h', pageId: f.pa, html: '<p>h</p>' }, 'x')!
    expect(store.lockIfVersion(agent, f.f.id, f.f.updatedAt, 'att-1')).toMatchObject({ ok: true })
    /* before the card exists, a writer hits the frame that is already locked */
    expect(() => store.updateFrame(agent, f.f.id, { html: '<p>x</p>' }, 'a')).toThrow(PolicyRefused)
    expect(() => store.deleteFrame(cheese, f.f.id)).toThrow(PolicyRefused)
    expect(store.lockIfVersion(agent, g2.id, g2.updatedAt, 'att-1')).toMatchObject({ ok: true })
    expect(store.getFrame(f.f.id)?.updatedAt).toBe(f.f.updatedAt)
  })
})

describe('MCP lock_frame_if_version', () => {
  it('locks at the version, and refuses a stale one with version_changed', async () => {
    const f = fixture()
    const server = buildMcpServer('Owner', 'alice')
    const client = new Client({ name: 'g5a', version: '1.0.0' })
    const [a, b] = InMemoryTransport.createLinkedPair()
    await server.connect(b)
    await client.connect(a)
    try {
      const stale = await client.callTool({
        name: 'lock_frame_if_version',
        arguments: {
          agent_name: 'D',
          frame_id: f.f.id,
          attested_updated_at: new Date(f.f.updatedAt - 1).toISOString(),
          attestation_id: 'a1',
        },
      })
      expect(stale.isError).toBe(true)
      expect(JSON.stringify(stale.content)).toMatch(/version_changed/)
      const ok = await client.callTool({
        name: 'lock_frame_if_version',
        arguments: {
          agent_name: 'D',
          frame_id: f.f.id,
          attested_updated_at: new Date(f.f.updatedAt).toISOString(),
          attestation_id: 'a1',
        },
      })
      expect(ok.isError).toBeFalsy()
      expect(store.getFrame(f.f.id)).toMatchObject({ locked: true, lockAttestationId: 'a1' })
    } finally {
      await client.close()
      await server.close()
    }
  })
})
