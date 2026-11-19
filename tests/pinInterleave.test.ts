import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { EVENTS, pinWorld, POINTS, WEEK, type Event, type Point, type Scenario } from './support/pinHarness.ts'

/* CHE-7063 (G5c of CHE-6078, spec che-6078-g5-lock-pin-r1 sections 5, 6, 8): every cell of the interleaving table
   is one test, `pin/<stop point>/<event>`: 12 stop points x 5 events = 60. A real temporary pglite database for
   doop; Multica is a fake with its own card rows. After each test `assertInvariants` reads both sides. */
const w = await pinWorld()
const { multica, clock, pins, rec, state } = w

afterAll(() => w.cleanup())
beforeEach(() => w.reset())

type Cell = (s: Scenario) => Promise<void>
const day = 24 * 3600 * 1000

/** unlock refused by a pin, frame as P2 left it */
const stillPinned = async (s: Scenario) => {
  expect(await s.unlock()).toMatchObject({ ok: false, error: 'pinned' })
  await s.expectFrameUnchanged()
}
/** `ms` later, then the two orders of "reconcile" and "unlock"; each order is its own scenario at the same stop point */
async function bothOrders(
  s: Scenario,
  point: Point,
  body: (s: Scenario, order: 'unlock-first' | 'reconcile-first') => Promise<void>,
) {
  await body(s, 'unlock-first')
  const other = await w.atPoint(point)
  await body(other, 'reconcile-first')
  await w.assertInvariants(other)
}
const weekThen = async (s: Scenario, order: 'unlock-first' | 'reconcile-first') => {
  clock.advance(WEEK)
  if (order === 'unlock-first') {
    const unlock = await s.unlock()
    return { unlock, rec: await s.reconcile() }
  }
  const r = await s.reconcile()
  return { rec: r, unlock: await s.unlock() }
}

/* ---- shared cells ---- */

/** RESERVED, card `pending`, publisher gone: a pin nothing will ever confirm */
const e2Orphan: (point: Point) => Cell = (point) => (s) =>
  bothOrders(s, point, async (x, order) => {
    const out = await weekThen(x, order)
    if (order === 'unlock-first') {
      expect(out.unlock).toMatchObject({ ok: false, error: 'pinned' })
      expect(out.rec).toMatchObject([{ action: 'released', aborted: true }])
    } else {
      expect(out.rec).toMatchObject([{ action: 'released', aborted: true }])
      expect(out.unlock).toMatchObject({ ok: true })
    }
    expect(multica.status(x.cardRequestId)).toBe('void')
    expect(x.pin()?.state).toBe('RELEASED')
    /* no card is left that a late publisher could open */
    expect(await x.step('P6')).toMatchObject({ ok: false })
    expect(await x.step('P7')).toMatchObject({ ok: false })
    expect(multica.status(x.cardRequestId)).toBe('void')
    if (order === 'unlock-first') expect(await x.unlock()).toMatchObject({ ok: true })
  })

const e3Void: Cell = async (s) => {
  expect(await s.force()).toMatchObject({ ok: true, pin: { state: 'RELEASED' } })
  expect(multica.calls.filter((c) => c === 'abort')).toHaveLength(1)
  expect(multica.status(s.cardRequestId)).toBe('void')
  expect(await s.view()).toMatchObject({ locked: true, epoch: 1 })
  expect(await s.step('P6')).toMatchObject({ ok: false })
  expect(await s.step('P7')).toMatchObject({ ok: false })
  expect(multica.status(s.cardRequestId)).toBe('void')
}

const e4Orphan: Cell = async (s) => {
  w.crashMultica()
  await stillPinned(s)
  clock.advance(WEEK)
  expect(await s.reconcile()).toMatchObject([{ action: 'unreachable' }])
  expect(s.pin()?.state).toBe('RESERVED')
  expect(rec.stuckPins().map((p) => p.cardRequestId)).toContain(s.cardRequestId)
  expect(rec.stuckPins().find((p) => p.cardRequestId === s.cardRequestId)!.ageMs).toBeGreaterThanOrEqual(WEEK)
  expect(await s.release()).toMatchObject({ ok: false, error: 'multica_unreachable' })
  expect(await s.force()).toMatchObject({ ok: false, error: 'multica_unreachable' })
  await stillPinned(s)
  w.restartMultica()
  expect(await s.reconcile()).toMatchObject([{ action: 'released', aborted: true }])
  expect(multica.status(s.cardRequestId)).toBe('void')
  expect(rec.stuckPins().map((p) => p.cardRequestId)).not.toContain(s.cardRequestId)
  expect(await s.unlock()).toMatchObject({ ok: true })
}

const e1Pinned: Cell = stillPinned
const e2Alive: Cell = (s) =>
  bothOrders(s, 'G6', async (x, order) => {
    const out = await weekThen(x, order)
    expect(out.unlock).toMatchObject({ ok: false, error: 'pinned' })
    expect(out.rec).toMatchObject([{ action: 'none' }])
    expect(multica.status(x.cardRequestId)).toBe('open')
    expect(x.pin()?.state).toBe('HELD')
    await stillPinned(x)
  })

/** a retry of the step the stop point follows */
const e5Retry =
  (step: Parameters<Scenario['step']>[0]): Cell =>
  async (s) => {
    const before = await w.dbm.db.select().from(w.t.framePins)
    const again = await s.step(step)
    expect(again).toMatchObject({ ok: true })
    const after = await w.dbm.db.select().from(w.t.framePins)
    expect(after).toEqual(before) // nothing was done a second time
  }

const cells: Record<Point, Record<Event, Cell>> = {
  /* G1: after P2. locked, no pin, no card */
  G1: {
    E1: async (s) => {
      expect(await s.unlock()).toMatchObject({ ok: true })
      await s.expectUnpinnedAfter(1)
      await s.relock()
      expect(await pins.reserveLock({ cardRequestId: s.cardRequestId, frames: [s.entry()] })).toMatchObject({
        ok: false,
        error: 'epoch_changed',
      })
      expect(multica.status(s.cardRequestId)).toBe('missing')
    },
    E2: (s) =>
      bothOrders(s, 'G1', async (x, order) => {
        const out = await weekThen(x, order)
        expect(out.unlock).toMatchObject({ ok: true })
        expect(out.rec).toEqual([])
      }),
    E3: async (s) => {
      expect(await s.force()).toMatchObject({ ok: false, error: 'no_pin' })
      await s.expectFrameUnchanged()
      expect(multica.calls).toEqual([])
    },
    E4: async (s) => {
      w.crashMultica()
      w.restartMultica()
      expect(await s.resume(['P3', 'P4', 'P5', 'P6', 'P7'])).toMatchObject({ P3: { ok: true }, P7: { ok: true } })
      expect(multica.status(s.cardRequestId)).toBe('open')
    },
    E5: async (s) => {
      expect(await s.step('P2')).toMatchObject({ ok: true, raw: { already: true, epoch: 0 } })
      await s.expectFrameUnchanged()
    },
  },
  /* G2: after P3. locked, no pin, card `pending` */
  G2: {
    E1: async (s) => {
      expect(await s.unlock()).toMatchObject({ ok: true })
      await s.relock()
      expect(await s.step('P4')).toMatchObject({ ok: false, error: 'epoch_changed' })
      expect(await s.step('C1')).toMatchObject({ ok: true })
      expect(multica.status(s.cardRequestId)).toBe('void')
    },
    E2: (s) =>
      bothOrders(s, 'G2', async (x, order) => {
        const out = await weekThen(x, order)
        expect(out.unlock).toMatchObject({ ok: true })
        expect(out.rec).toEqual([]) // no pin, nothing to reconcile; the stale card is Multica's own policy
        await x.relock()
        expect(await x.step('P4')).toMatchObject({ ok: false, error: 'epoch_changed' })
      }),
    E3: async (s) => {
      expect(await s.force()).toMatchObject({ ok: false, error: 'no_pin' })
      expect(multica.status(s.cardRequestId)).toBe('pending')
      await s.expectFrameUnchanged()
    },
    E4: async (s) => {
      w.crashMultica()
      w.restartMultica()
      expect(multica.status(s.cardRequestId)).toBe('pending') // the row is durable
      expect(await s.resume(['P4', 'P5', 'P6', 'P7'])).toMatchObject({ P4: { ok: true }, P7: { ok: true } })
      expect(multica.status(s.cardRequestId)).toBe('open')
    },
    E5: async (s) => {
      expect(await s.step('P3')).toMatchObject({ ok: true, raw: { status: 'pending' } })
      expect(multica.cards.size).toBe(1)
    },
  },
  /* G3: after P4. RESERVED, card `pending` */
  G3: {
    E1: e1Pinned,
    E2: e2Orphan('G3'),
    E3: e3Void,
    E4: e4Orphan,
    E5: async (s) => {
      const first = s.pin()!
      expect(await s.step('P4')).toMatchObject({ ok: true, raw: { already: true, pin: { pinId: first.pinId } } })
      expect((await w.dbm.db.select().from(w.t.framePinFrames)).length).toBe(1)
    },
  },
  /* G4: after P5. RESERVED, card `pending` with the epoch */
  G4: {
    E1: e1Pinned,
    E2: e2Orphan('G4'),
    E3: e3Void,
    E4: e4Orphan,
    E5: async (s) => {
      expect(await s.step('P5')).toMatchObject({ ok: true })
      expect(multica.cards.get(s.cardRequestId)?.epochs).toEqual(s.epochs())
    },
  },
  /* G5: after P6. HELD, R1 issued, card still `pending`: the case Terra found in round 3 */
  G5: {
    E1: e1Pinned,
    E2: async (s) => {
      /* unlock first: pinned at any age, the late P7 still opens the card, reconcile then changes nothing */
      clock.advance(WEEK)
      expect(await s.unlock()).toMatchObject({ ok: false, error: 'pinned' })
      expect(await s.step('P7')).toMatchObject({ ok: true })
      expect(await s.reconcile()).toMatchObject([{ action: 'none', status: 'open' }])
      expect(multica.status(s.cardRequestId)).toBe('open')
      expect(s.pin()?.state).toBe('HELD')
      await stillPinned(s)
      /* reconcile first: a pin on a card that never opens is let go by Multica's own answer */
      const reconcileFirst = await w.atPoint('G5')
      clock.advance(WEEK)
      expect(await reconcileFirst.reconcile()).toMatchObject([{ action: 'released', aborted: true }])
      expect(await reconcileFirst.unlock()).toMatchObject({ ok: true })
      expect(await reconcileFirst.step('P7')).toMatchObject({ ok: false })
      expect(multica.status(reconcileFirst.cardRequestId)).toBe('void')
      await w.assertInvariants(reconcileFirst)
    },
    E3: e3Void,
    E4: async (s) => {
      w.crashMultica()
      await stillPinned(s)
      expect(await s.step('P7')).toMatchObject({ ok: false })
      clock.advance(WEEK)
      expect(await s.reconcile()).toMatchObject([{ action: 'unreachable' }])
      expect(s.pin()?.state).toBe('HELD')
      w.restartMultica()
      expect(await s.step('P7')).toMatchObject({ ok: true })
      expect(multica.status(s.cardRequestId)).toBe('open')
      await stillPinned(s)
    },
    E5: async (s) => {
      const first = s.r1!.mac
      s.dropResponse('P6') // the answer to confirm_pin was lost
      expect(s.r1).toBeUndefined()
      expect(await s.step('P6')).toMatchObject({ ok: true })
      expect(s.r1!.mac).toBe(first)
      /* a lost answer to P7 is the same: Multica opened once, however often it is asked */
      expect(await s.step('P7')).toMatchObject({ ok: true })
      expect(await s.step('P7')).toMatchObject({ ok: true })
      expect(multica.status(s.cardRequestId)).toBe('open')
    },
  },
  /* G6: after P7. HELD, card `open` */
  G6: {
    E1: e1Pinned,
    E2: e2Alive,
    E3: async (s) => {
      expect(await s.force()).toMatchObject({ ok: true, pin: { state: 'RELEASED' } })
      expect(multica.status(s.cardRequestId)).toBe('void') // Cheese sees the card void
      expect(await s.view()).toMatchObject({ locked: true, epoch: 1 })
    },
    E4: async (s) => {
      w.crashMultica()
      await stillPinned(s)
      expect(await s.step('K1')).toMatchObject({ ok: false })
      w.restartMultica()
      expect(await s.resume()).toMatchObject({ K1: { ok: true }, K2: { ok: true }, K4: { ok: true }, K5: { ok: true } })
      expect(multica.status(s.cardRequestId)).toBe('decided')
    },
    E5: e5Retry('P7'),
  },
  /* G7: after K1. HELD, card `pick_pending` */
  G7: {
    E1: e1Pinned,
    E2: (s) =>
      bothOrders(s, 'G7', async (x, order) => {
        const out = await weekThen(x, order)
        expect(out.unlock).toMatchObject({ ok: false, error: 'pinned' })
        expect(out.rec).toMatchObject([{ action: 'none', status: 'pick_pending' }])
        /* a week later K2 still succeeds: the frame cannot have changed */
        expect(await x.step('K2')).toMatchObject({ ok: true })
        expect(await x.step('K4')).toMatchObject({ ok: true })
        await x.expectFrameUnchanged()
      }),
    E3: async (s) => {
      expect(await s.force()).toMatchObject({ ok: true })
      expect(multica.status(s.cardRequestId)).toBe('void')
      expect(await s.step('K2')).toMatchObject({ ok: false, error: 'released' }) // the pick is refused
      expect(await s.view()).toMatchObject({ locked: true, epoch: 1 })
    },
    E4: async (s) => {
      w.crashMultica()
      await stillPinned(s)
      w.restartMultica()
      expect(await multica.pickDriver(s.cardRequestId)).toMatchObject({ ok: true }) // K2 then K4, after the restart
      expect(multica.status(s.cardRequestId)).toBe('decided')
      expect(await s.step('K5')).toMatchObject({ ok: true })
    },
    E5: e5Retry('K1'),
  },
  /* G8: after K2. SEALED, R2 issued, card `pick_pending`: the other case Terra found */
  G8: {
    E1: e1Pinned,
    E2: (s) =>
      bothOrders(s, 'G8', async (x, order) => {
        const out = await weekThen(x, order)
        expect(out.unlock).toMatchObject({ ok: false, error: 'pinned' })
        expect(out.rec).toMatchObject([{ action: 'none', status: 'pick_pending' }]) // reconcile never releases it
        expect(x.pin()?.state).toBe('SEALED')
        /* a week on, K4 still succeeds on the frame as it was */
        expect(await x.step('K4')).toMatchObject({ ok: true })
        await x.expectFrameUnchanged()
        expect(await x.step('K5')).toMatchObject({ ok: true })
      }),
    E3: async (s) => {
      /* force wins the CAS: the card is void and the pick never happens */
      const other = await w.atPoint('G8')
      expect(await s.force()).toMatchObject({ ok: true })
      expect(multica.status(s.cardRequestId)).toBe('void')
      expect(await s.step('K4')).toMatchObject({ ok: false })
      expect(await s.view()).toMatchObject({ locked: true, epoch: 1 })
      /* K4 wins: abort_ref answers `decided`, the release is normal and the epoch stays */
      expect(await other.step('K4')).toMatchObject({ ok: true })
      expect(await other.force()).toMatchObject({ ok: true, pin: { state: 'RELEASED' } })
      expect(multica.status(other.cardRequestId)).toBe('decided')
      expect(await other.view()).toMatchObject({ locked: true, epoch: 0 })
      await w.assertInvariants(other)
    },
    E4: async (s) => {
      const first = s.r2!.mac
      w.crashMultica()
      await stillPinned(s)
      expect(await s.step('K4')).toMatchObject({ ok: false })
      expect(await s.release()).toMatchObject({ ok: false, error: 'multica_unreachable' })
      w.restartMultica()
      expect(await multica.pickDriver(s.cardRequestId)).toMatchObject({ ok: true }) // K2 again: the same R2
      expect(multica.cards.get(s.cardRequestId)?.r2?.mac).toBe(first)
      expect(await s.step('K5')).toMatchObject({ ok: true })
    },
    E5: async (s) => {
      const first = s.r2!.mac
      s.dropResponse('K2')
      expect(await s.step('K2')).toMatchObject({ ok: true })
      expect(s.r2!.mac).toBe(first)
      expect(s.pin()?.state).toBe('SEALED')
    },
  },
  /* G9: after K4. SEALED, card `decided` */
  G9: {
    E1: async (s) => {
      await stillPinned(s) // until K5
      expect(await s.step('K5')).toMatchObject({ ok: true })
      expect(await s.unlock()).toMatchObject({ ok: true }) // valid: the card is decided
    },
    E2: (s) =>
      bothOrders(s, 'G9', async (x, order) => {
        const out = await weekThen(x, order)
        expect(out.rec).toMatchObject([{ action: 'released' }]) // K5 by reconcile
        if (order === 'unlock-first') expect(out.unlock).toMatchObject({ ok: false, error: 'pinned' })
        else expect(out.unlock).toMatchObject({ ok: true })
        expect(await x.unlock().then((r: { ok: boolean; error?: string }) => r.ok || r.error === 'not_locked')).toBe(
          true,
        )
        expect(multica.status(x.cardRequestId)).toBe('decided')
      }),
    E3: async (s) => {
      expect(await s.force()).toMatchObject({ ok: true, pin: { state: 'RELEASED' } })
      expect(multica.status(s.cardRequestId)).toBe('decided')
      expect(await s.view()).toMatchObject({ locked: true, epoch: 0 }) // the chosen version keeps its epoch
    },
    E4: async (s) => {
      w.crashMultica()
      await stillPinned(s)
      expect(await s.release()).toMatchObject({ ok: false, error: 'multica_unreachable' })
      clock.advance(WEEK)
      expect(await s.reconcile()).toMatchObject([{ action: 'unreachable' }])
      expect(s.pin()?.state).toBe('SEALED')
      w.restartMultica()
      expect(await s.release()).toMatchObject({ ok: true })
      expect(await s.unlock()).toMatchObject({ ok: true })
    },
    E5: async (s) => {
      /* the answer to K4 never reached doop: nothing tells it, so reconcile asks and releases */
      clock.advance(day)
      expect(await s.reconcile()).toMatchObject([{ action: 'released', status: 'decided' }])
      expect(s.pin()?.state).toBe('RELEASED')
      expect(await s.step('K4')).toMatchObject({ ok: true }) // the retry is a no-op
    },
  },
  /* G10: after K5. RELEASED, card `decided` */
  G10: {
    E1: async (s) => {
      expect(await s.unlock()).toMatchObject({ ok: true })
      /* LOCK.json keeps the version that was chosen */
      expect(multica.cards.get(s.cardRequestId)?.atDecided?.[0]).toEqual({
        locked: true,
        epoch: 0,
        updatedAt: s.p2.updatedAt,
      })
    },
    E2: (s) =>
      bothOrders(s, 'G10', async (x, order) => {
        const out = await weekThen(x, order)
        expect(out.unlock).toMatchObject({ ok: true })
        expect(out.rec).toEqual([]) // a RELEASED pin is not reconciled
      }),
    E3: async (s) => {
      const calls = multica.calls.length
      expect(await s.force()).toMatchObject({ ok: true, pin: { state: 'RELEASED' } })
      expect(multica.calls.length).toBe(calls) // there is no pin to ask Multica about
      expect(await s.view()).toMatchObject({ locked: true, epoch: 0 })
    },
    E4: async (s) => {
      w.crashMultica()
      expect(await s.unlock()).toMatchObject({ ok: true }) // nothing here depends on Multica
    },
    E5: async (s) => {
      expect(await s.step('K5')).toMatchObject({ ok: true, raw: { already: true } })
    },
  },
  /* V1: after C1. a pin still held, card `void` */
  V1: {
    E1: async (s) => {
      await stillPinned(s)
      expect(await s.step('C2')).toMatchObject({ ok: true })
      expect(await s.unlock()).toMatchObject({ ok: true })
    },
    E2: (s) =>
      bothOrders(s, 'V1', async (x, order) => {
        const out = await weekThen(x, order)
        expect(out.rec).toMatchObject([{ action: 'released', status: 'void' }])
        if (order === 'unlock-first') expect(out.unlock).toMatchObject({ ok: false, error: 'pinned' })
        else expect(out.unlock).toMatchObject({ ok: true })
        expect(x.pin()?.state).toBe('RELEASED')
        expect(multica.status(x.cardRequestId)).toBe('void')
      }),
    E3: async (s) => {
      expect(await s.force()).toMatchObject({ ok: true, pin: { state: 'RELEASED' } })
      expect(multica.status(s.cardRequestId)).toBe('void')
      expect(await s.view()).toMatchObject({ locked: true, epoch: 1 })
    },
    E4: async (s) => {
      w.crashMultica()
      await stillPinned(s)
      expect(await s.release()).toMatchObject({ ok: false, error: 'multica_unreachable' })
      w.restartMultica()
      clock.advance(WEEK)
      expect(await s.reconcile()).toMatchObject([{ action: 'released' }])
      expect(await s.unlock()).toMatchObject({ ok: true })
    },
    E5: async (s) => {
      /* the answer to C1 was lost: the publisher need not retry, reconcile converges */
      clock.advance(day)
      expect(await s.reconcile()).toMatchObject([{ action: 'released', status: 'void' }])
      expect(await s.step('C1')).toMatchObject({ ok: true })
      expect(s.pin()?.state).toBe('RELEASED')
    },
  },
  /* V2: after C2. RELEASED, card `void` */
  V2: {
    E1: async (s) => {
      expect(await s.unlock()).toMatchObject({ ok: true })
    },
    E2: (s) =>
      bothOrders(s, 'V2', async (x, order) => {
        const out = await weekThen(x, order)
        expect(out.unlock).toMatchObject({ ok: true })
        expect(out.rec).toEqual([]) // a RELEASED pin is not reconciled
      }),
    E3: async (s) => {
      const calls = multica.calls.length
      expect(await s.force()).toMatchObject({ ok: true, pin: { state: 'RELEASED' } })
      expect(multica.calls.length).toBe(calls)
      expect(await s.view()).toMatchObject({ locked: true, epoch: 0 })
    },
    E4: async (s) => {
      w.crashMultica()
      expect(await s.unlock()).toMatchObject({ ok: true })
    },
    E5: async (s) => {
      expect(await s.step('C2')).toMatchObject({ ok: true, raw: { already: true } })
    },
  },
}

describe('interleaving table (spec section 6): one test per cell', () => {
  for (const point of POINTS)
    for (const event of EVENTS)
      it(`pin/${point}/${event}`, async () => {
        const s = await w.atPoint(point)
        await cells[point][event](s)
        await w.assertInvariants(s)
      })
})

describe('the two cases Terra found, told as they happened (reconcile off)', () => {
  it('pin/terra/G5/E2: after confirm_pin, past the old ttl, unlock is refused, then P7 opens the card', async () => {
    const s = await w.atPoint('G5')
    clock.advance(WEEK)
    await stillPinned(s)
    expect(await s.step('P7')).toMatchObject({ ok: true })
    expect(multica.status(s.cardRequestId)).toBe('open')
    expect(s.pin()?.state).toBe('HELD')
    await stillPinned(s)
    await w.assertInvariants(s, { converge: false })
  })

  it('pin/terra/G8/E2: after K2, past 24 hours, unlock is refused, then K4 decides on the unchanged frame', async () => {
    const s = await w.atPoint('G8')
    clock.advance(day + 3600 * 1000)
    await stillPinned(s)
    expect(await s.step('K4')).toMatchObject({ ok: true })
    expect(multica.status(s.cardRequestId)).toBe('decided')
    expect(s.pin()?.state).toBe('SEALED') // released only by K5, which asks Multica
    expect(multica.cards.get(s.cardRequestId)?.atDecided?.[0]).toEqual({
      locked: true,
      epoch: s.p2.epoch,
      updatedAt: s.p2.updatedAt,
    })
    await w.assertInvariants(s, { converge: false })
  })
})
void state
