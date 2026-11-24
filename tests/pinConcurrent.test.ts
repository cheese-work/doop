import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { pinWorld, WEEK } from './support/pinHarness.ts'

/* CHE-7063 (G5c of CHE-6078, spec che-6078-g5-lock-pin-r1 sections 6 and 8): the six concurrent cases,
   `pin/concurrent/*`. Same world as the interleaving table: a real pglite database, a fake Multica with its own CAS. */
const w = await pinWorld()
const { multica, clock, pins, rec, state } = w

afterAll(() => w.cleanup())
beforeEach(() => w.reset())

const activeRows = async () => (await w.dbm.db.select().from(w.t.framePinFrames)).length
const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((r) => (resolve = r))
  return { promise, resolve }
}

describe('pin/concurrent', () => {
  it('pin/concurrent/two-publishers: two cards on one frame, one pin wins, the other is pinned_by_other and voided', async () => {
    const s = await w.atPoint('G2')
    const other = 'card-second'
    multica.createPending(other)
    const [a, b] = await Promise.all([
      pins.reserveLock({ cardRequestId: s.cardRequestId, frames: [s.entry()] }),
      pins.reserveLock({ cardRequestId: other, frames: [s.entry()] }),
    ])
    const results = [a, b]
    expect(results.filter((r) => r.ok)).toHaveLength(1)
    expect(results.find((r) => !r.ok)).toMatchObject({ ok: false, error: 'pinned_by_other' })
    expect(await activeRows()).toBe(1) // not a broken pin: one row, one owner
    const loser = a.ok ? other : s.cardRequestId
    expect(multica.voidCard(loser)).toMatchObject({ status: 'void' })
    expect(state.pinOf(s.frameId)?.cardRequestId).toBe(a.ok ? s.cardRequestId : other)
    await w.assertInvariants(s)
  })

  it('pin/concurrent/two-unlocks: with a pin both are pinned; without one a single unlock wins and the other finds it open', async () => {
    const pinned = await w.atPoint('G4')
    const both = await Promise.all([pinned.unlock(), pinned.unlock()])
    expect(both).toMatchObject([
      { ok: false, error: 'pinned' },
      { ok: false, error: 'pinned' },
    ])
    await pinned.expectFrameUnchanged()
    await w.assertInvariants(pinned)

    const free = await w.atPoint('G1')
    const results = await Promise.all([free.unlock(), free.unlock()])
    expect(results.filter((r) => r.ok)).toHaveLength(1)
    expect(results.find((r) => !r.ok)).toMatchObject({ error: 'not_locked' }) // a no-op: the frame is already open
    expect(await free.view()).toMatchObject({ locked: false, epoch: 1 }) // the epoch went up once
    await w.assertInvariants(free)
  })

  it('pin/concurrent/unlock-vs-reserve: whichever commits first decides, in both orders and across a paused write', async () => {
    /* unlock queued first: P4 fails, no pin */
    const a = await w.atPoint('G2')
    const [ua, ra] = await Promise.all([a.unlock(), a.step('P4')])
    expect(ua).toMatchObject({ ok: true })
    expect(ra.ok).toBe(false)
    expect(state.pinOf(a.frameId)).toBeUndefined()
    expect(await a.view()).toMatchObject({ locked: false, epoch: 1 })
    await w.assertInvariants(a)

    /* P4 queued first: the unlock is pinned */
    const b = await w.atPoint('G2')
    const [rb, ub] = await Promise.all([b.step('P4'), b.unlock()])
    expect(rb).toMatchObject({ ok: true })
    expect(ub).toMatchObject({ ok: false, error: 'pinned' })
    await b.expectFrameUnchanged()
    await w.assertInvariants(b)

    /* the unlock arrives while the P4 row is being written: still pinned, because the pin shows before it is durable */
    const c = await w.atPoint('G2')
    const reached = deferred()
    const go = deferred()
    state.pinHooks.beforeWrite = async (op) => {
      if (op !== 'reserve') return
      reached.resolve()
      await go.promise
    }
    const reserve = c.step('P4')
    await reached.promise
    const unlock = c.unlock()
    go.resolve()
    expect(await reserve).toMatchObject({ ok: true })
    expect(await unlock).toMatchObject({ ok: false, error: 'pinned' })
    await c.expectFrameUnchanged()
    await w.assertInvariants(c)
  })

  it('pin/concurrent/force-vs-decided: force_release against K4, run both ways round and in parallel, ends safe each time', async () => {
    /* force wins the CAS on the card */
    const a = await w.atPoint('G8')
    const forced = a.force()
    await vi.waitFor(() => expect(multica.status(a.cardRequestId)).toBe('void'))
    expect(await a.step('K4')).toMatchObject({ ok: false })
    expect(await forced).toMatchObject({ ok: true, pin: { state: 'RELEASED' } })
    expect(await a.view()).toMatchObject({ locked: true, epoch: 1 })
    await w.assertInvariants(a)

    /* K4 wins: force_release learns `decided` and does not raise the epoch */
    const b = await w.atPoint('G8')
    expect(await b.step('K4')).toMatchObject({ ok: true })
    expect(await b.force()).toMatchObject({ ok: true, pin: { state: 'RELEASED' } })
    expect(multica.status(b.cardRequestId)).toBe('decided')
    expect(await b.view()).toMatchObject({ locked: true, epoch: 0 })
    await w.assertInvariants(b)

    /* truly parallel: either result is a consistent one */
    const c = await w.atPoint('G8')
    const [f, k4] = await Promise.all([c.force(), c.step('K4')])
    expect(f).toMatchObject({ ok: true, pin: { state: 'RELEASED' } })
    const status = multica.status(c.cardRequestId)
    if (status === 'decided') {
      expect(k4.ok).toBe(true)
      expect(await c.view()).toMatchObject({ locked: true, epoch: 0 })
    } else {
      expect(status).toBe('void')
      expect(k4.ok).toBe(false)
      expect(await c.view()).toMatchObject({ locked: true, epoch: 1 })
    }
    await w.assertInvariants(c)
  })

  it('pin/concurrent/reconcile-vs-open: stopped between the read of `pending` and A2, the card either survives open with its pin, or is voided', async () => {
    /* outcome 1: the slow publisher's P7 lands between the read and A2; A2 changes nothing */
    const a = await w.atPoint('G5')
    clock.advance(WEEK)
    const read = deferred()
    const go = deferred()
    rec.reconcileHooks.afterRead = async (card, status) => {
      if (card !== a.cardRequestId) return
      expect(status).toBe('pending')
      read.resolve()
      await go.promise
    }
    const pass = a.reconcile()
    await read.promise
    expect(await a.step('P7')).toMatchObject({ ok: true })
    go.resolve()
    expect(await pass).toMatchObject([{ action: 'none', status: 'open', aborted: false }])
    expect(multica.status(a.cardRequestId)).toBe('open') // the published card is never cancelled by a slow publisher
    expect(a.pin()?.state).toBe('HELD')
    expect(multica.calls).toContain('abortIfPending')
    expect(multica.calls).not.toContain('abort') // A1 is for force_release only
    expect(await a.unlock()).toMatchObject({ ok: false, error: 'pinned' })
    await w.assertInvariants(a)

    /* outcome 2: A2 gets there first; the card is void, the pin goes, P7 fails */
    await w.reset()
    rec.reconcileHooks.afterRead = undefined
    const b = await w.atPoint('G5')
    clock.advance(WEEK)
    const read2 = deferred()
    rec.reconcileHooks.afterRead = async () => {
      read2.resolve()
    }
    const pass2 = b.reconcile()
    await read2.promise
    expect(await pass2).toMatchObject([{ action: 'released', aborted: true }])
    expect(await b.step('P7')).toMatchObject({ ok: false })
    expect(multica.status(b.cardRequestId)).toBe('void')
    expect(b.pin()?.state).toBe('RELEASED')
    await w.assertInvariants(b)
  })

  it('pin/concurrent/doop-restart: doop restarted between any two steps reads its pin back and never has a pinless moment', async () => {
    const s = await w.atPoint('G2')
    const restart = async () => {
      const before = s.pin()
      state.replacePins([]) // the process dies: memory goes, the database stays
      expect(state.isPinned(s.frameId)).toBe(false)
      await pins.loadPins()
      pins.configurePins({ secret: 'shared-secret', multica })
      expect(s.pin()).toEqual(before)
    }
    for (const step of ['P4', 'P5', 'P6', 'P7', 'K1', 'K2', 'K4'] as const) {
      expect(await s.step(step), step).toMatchObject({ ok: true })
      await restart()
      expect(state.isPinned(s.frameId), `after ${step}`).toBe(true)
      expect(await s.unlock(), `after ${step}`).toMatchObject({ ok: false, error: 'pinned' })
      await s.expectFrameUnchanged()
    }
    expect(await s.step('K5')).toMatchObject({ ok: true })
    await restart()
    expect(s.pin()?.state).toBe('RELEASED')
    expect(await s.unlock()).toMatchObject({ ok: true })
    await w.assertInvariants(s)
  })
})
