import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

/* CHE-7062 (G5b of CHE-6078, spec che-6078-g5-lock-pin-r1 sections 2, 3, 4, 7, 8): the lock pin core.
   A real temporary pglite database, nothing mocked in the persistence layer; Multica is a fake port.
   Groups: pin/durable/*, pin/no-clock/*, pin/transfer/no-gap, pin/receipt/*, plus the state machine. */
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doop-framepins-'))
const cwd = process.cwd()
process.chdir(dir)
const dbm = await import('../server/db/index.ts')
const t = await import('../server/db/schema.ts')
const { store } = await import('../server/store.ts')
const { PolicyRefused, setLockOwners, systemContext } = await import('../server/writePolicy.ts')
const pins = await import('../server/framePins.ts')
const state = await import('../server/pinState.ts')
const actions = await import('../server/actions.ts')
await dbm.initDb()
process.chdir(cwd)

const sys = systemContext()
const agent = { kind: 'agent' as const }
const cheese = { kind: 'user' as const, userId: 'cheese' }
const bob = { kind: 'user' as const, userId: 'bob' }
const SECRET = 'shared-secret'

type Status = 'pending' | 'open' | 'pick_pending' | 'decided' | 'void' | 'missing'
const multica = {
  status: new Map<string, Status>(),
  down: false,
  /** a call to abort_ref that has already made the card void waits here before it answers */
  abortGate: undefined as Promise<void> | undefined,
  calls: [] as string[],
  async refStatus(card: string): Promise<Status> {
    this.calls.push('ref')
    if (this.down) throw new Error('multica down')
    return this.status.get(card) ?? 'missing'
  },
  async abortRef(card: string): Promise<Status> {
    this.calls.push('abort')
    if (this.down) throw new Error('multica down')
    const now = this.status.get(card) ?? 'missing'
    const final: Status = now === 'decided' || now === 'void' ? now : 'void'
    this.status.set(card, final)
    await this.abortGate
    return final
  },
}

beforeAll(() => setLockOwners(['cheese']))
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))
beforeEach(async () => {
  multica.status.clear()
  multica.down = false
  multica.abortGate = undefined
  multica.calls = []
  state.pinHooks.beforeWrite = undefined
  await dbm.db.delete(t.framePinFrames)
  await dbm.db.delete(t.framePins)
  state.replacePins([])
  pins.configurePins({ secret: SECRET, multica })
})
afterEach(() => vi.useRealTimers())

let n = 0
const card = () => `card-${++n}`

async function frameRow(frameId: string) {
  const [r] = await dbm.db.select().from(t.frames).where(eq(t.frames.id, frameId))
  return r
}
async function pinRow(cardRequestId: string) {
  const [r] = await dbm.db.select().from(t.framePins).where(eq(t.framePins.cardRequestId, cardRequestId))
  return r
}
const activeRows = async () => (await dbm.db.select().from(t.framePinFrames)).length

/** `count` frames, each locked at its current version with its own attestation id (P1, P2) */
async function lockedFrames(count = 1) {
  const canvas = store.createCanvas('Pins', 'alice')
  await vi.waitFor(async () => {
    const [c] = await dbm.db.select().from(t.canvases).where(eq(t.canvases.id, canvas.id))
    expect(c).toBeTruthy()
  })
  const frames = Array.from({ length: count }, (_, i) =>
    store.createFrame(sys, canvas.id, { name: `f${i}`, html: `<p>${i}</p>` }, 'x')!,
  )
  for (const f of frames) store.lockIfVersion(agent, f.id, f.updatedAt, `att-${f.id}`)
  await vi.waitFor(async () => {
    for (const f of frames) expect((await frameRow(f.id))?.locked).toBe(true)
  })
  return frames.map((f) => ({
    frameId: f.id,
    updatedAt: f.updatedAt,
    attestationId: `att-${f.id}`,
    epoch: f.lockEpoch ?? 0,
  }))
}

/** P4 then P6: a pin at HELD */
async function held(count = 1) {
  const entries = await lockedFrames(count)
  const cardRequestId = card()
  const reserved = await pins.reserveLock({ cardRequestId, frames: entries })
  expect(reserved).toMatchObject({ ok: true })
  const confirmed = await pins.confirmPin(cardRequestId)
  expect(confirmed).toMatchObject({ ok: true })
  return {
    entries,
    cardRequestId,
    receipt: (confirmed as { receipt: import('../server/framePins.ts').Receipt }).receipt,
  }
}
async function sealed(count = 1) {
  const h = await held(count)
  const pickRequestId = `pick-${h.cardRequestId}`
  const out = await pins.pinForPick({
    cardRequestId: h.cardRequestId,
    pickRequestId,
    pickedFrameId: h.entries[0]!.frameId,
  })
  expect(out).toMatchObject({ ok: true })
  return { ...h, pickRequestId, r2: (out as { receipt: import('../server/framePins.ts').Receipt }).receipt }
}

describe('P4 reserve_lock', () => {
  it('reserves one pin over every frame of the card, durably, and returns the pin', async () => {
    const entries = await lockedFrames(2)
    const cardRequestId = card()
    const out = await pins.reserveLock({ cardRequestId, frames: entries })
    expect(out).toMatchObject({ ok: true, pin: { state: 'RESERVED', cardRequestId } })
    expect(await pinRow(cardRequestId)).toMatchObject({ state: 'RESERVED' })
    expect(await activeRows()).toBe(2)
    expect(entries.every((e) => state.isPinned(e.frameId))).toBe(true)
  })

  it('is idempotent on cardRequestId: the same call again is the same pin, no second row', async () => {
    const entries = await lockedFrames()
    const cardRequestId = card()
    const first = (await pins.reserveLock({ cardRequestId, frames: entries })) as { pin: { pinId: string } }
    const again = await pins.reserveLock({ cardRequestId, frames: entries })
    expect(again).toMatchObject({ ok: true, already: true, pin: { pinId: first.pin.pinId } })
    expect(await activeRows()).toBe(1)
  })

  it('refuses a frame another pin holds, and pins nothing of the card (all or none)', async () => {
    const [a, b] = await lockedFrames(2)
    await pins.reserveLock({ cardRequestId: card(), frames: [a!] })
    const second = card()
    expect(await pins.reserveLock({ cardRequestId: second, frames: [b!, a!] })).toMatchObject({
      ok: false,
      error: 'pinned_by_other',
    })
    expect(state.isPinned(b!.frameId)).toBe(false)
    expect(await pinRow(second)).toBeUndefined()
  })

  it('epoch_changed when an unlock came between P2 and P4 (B6)', async () => {
    const [e] = await lockedFrames()
    const out = await store.unlockFrame(cheese, e!.frameId, 'cheese')
    expect(out).toMatchObject({ ok: true })
    const relocked = store.getFrame(e!.frameId)!
    store.lockIfVersion(agent, relocked.id, relocked.updatedAt, e!.attestationId)
    expect(await pins.reserveLock({ cardRequestId: card(), frames: [e!] })).toMatchObject({
      ok: false,
      error: 'epoch_changed',
    })
  })

  it('version_changed when the frame was edited after P2', async () => {
    const [e] = await lockedFrames()
    expect(
      await pins.reserveLock({ cardRequestId: card(), frames: [{ ...e!, updatedAt: e!.updatedAt - 1 }] }),
    ).toMatchObject({ ok: false, error: 'version_changed' })
  })
})

describe('P6 confirm_pin and K2 pin_for_pick', () => {
  it('confirm_pin turns RESERVED into HELD and issues R1; a retry returns the same R1', async () => {
    const entries = await lockedFrames()
    const cardRequestId = card()
    await pins.reserveLock({ cardRequestId, frames: entries })
    const first = (await pins.confirmPin(cardRequestId)) as { ok: true; receipt: { kind: string; mac: string } }
    expect(first).toMatchObject({ ok: true, pin: { state: 'HELD' }, receipt: { kind: 'R1' } })
    expect(await pinRow(cardRequestId)).toMatchObject({ state: 'HELD' })
    const again = (await pins.confirmPin(cardRequestId)) as { receipt: { mac: string } }
    expect(again.receipt.mac).toBe(first.receipt.mac)
  })

  it('confirm_pin without a pin is no_pin', async () => {
    expect(await pins.confirmPin('nobody')).toMatchObject({ ok: false, error: 'no_pin' })
  })

  it('K2 turns HELD into SEALED in one step and issues R2; the same pickRequestId again returns the same R2', async () => {
    const h = await held()
    const pickRequestId = 'pick-1'
    const first = (await pins.pinForPick({
      cardRequestId: h.cardRequestId,
      pickRequestId,
      pickedFrameId: h.entries[0]!.frameId,
    })) as { ok: true; receipt: { kind: string; mac: string } }
    expect(first).toMatchObject({ ok: true, pin: { state: 'SEALED', pickRequestId }, receipt: { kind: 'R2' } })
    expect(await pinRow(h.cardRequestId)).toMatchObject({ state: 'SEALED', pickRequestId })
    const again = (await pins.pinForPick({
      cardRequestId: h.cardRequestId,
      pickRequestId,
      pickedFrameId: h.entries[0]!.frameId,
    })) as { receipt: { mac: string } }
    expect(again.receipt.mac).toBe(first.receipt.mac)
  })

  it('K2 with another pickRequestId on a SEALED pin is pick_conflict; from RESERVED it is no_pin', async () => {
    const s = await sealed()
    expect(
      await pins.pinForPick({
        cardRequestId: s.cardRequestId,
        pickRequestId: 'pick-other',
        pickedFrameId: s.entries[0]!.frameId,
      }),
    ).toMatchObject({ ok: false, error: 'pick_conflict' })
    const entries = await lockedFrames()
    const cardRequestId = card()
    await pins.reserveLock({ cardRequestId, frames: entries })
    expect(
      await pins.pinForPick({ cardRequestId, pickRequestId: 'p', pickedFrameId: entries[0]!.frameId }),
    ).toMatchObject({ ok: false, error: 'no_pin' })
  })

  it('K2 refuses a picked frame the card does not cover and a version the card did not pin', async () => {
    const h = await held()
    expect(
      await pins.pinForPick({ cardRequestId: h.cardRequestId, pickRequestId: 'p', pickedFrameId: 'stranger' }),
    ).toMatchObject({ ok: false, error: 'bad_pick' })
    expect(
      await pins.pinForPick({
        cardRequestId: h.cardRequestId,
        pickRequestId: 'p',
        pickedFrameId: h.entries[0]!.frameId,
        versions: [{ frameId: h.entries[0]!.frameId, updatedAt: h.entries[0]!.updatedAt, epoch: 9 }],
      }),
    ).toMatchObject({ ok: false, error: 'epoch_changed' })
    expect(state.getPin(h.cardRequestId)?.state).toBe('HELD')
  })
})

describe('K5/C2 release_pin and F1 force_release (B1)', () => {
  it('asks Multica itself and refuses while the card is not decided or void', async () => {
    const h = await held()
    for (const s of ['pending', 'open', 'pick_pending'] as const) {
      multica.status.set(h.cardRequestId, s)
      expect(await pins.releasePin(h.cardRequestId)).toMatchObject({ ok: false, error: 'not_final', status: s })
    }
    expect(state.getPin(h.cardRequestId)?.state).toBe('HELD')
    expect(await activeRows()).toBe(1)
  })

  it('Multica down: multica_unreachable, the pin stays (fail closed)', async () => {
    const h = await held()
    multica.down = true
    expect(await pins.releasePin(h.cardRequestId)).toMatchObject({ ok: false, error: 'multica_unreachable' })
    expect(state.getPin(h.cardRequestId)?.state).toBe('HELD')
  })

  it('decided: RELEASED, the frame stays locked, its active row is gone, unlock now works, a retry is OK', async () => {
    const s = await sealed()
    multica.status.set(s.cardRequestId, 'decided')
    expect(await pins.releasePin(s.cardRequestId)).toMatchObject({ ok: true, pin: { state: 'RELEASED' } })
    expect(await pinRow(s.cardRequestId)).toMatchObject({ state: 'RELEASED' })
    expect(await activeRows()).toBe(0)
    const id = s.entries[0]!.frameId
    expect(store.getFrame(id)?.locked).toBe(true)
    expect(await pins.releasePin(s.cardRequestId)).toMatchObject({ ok: true, already: true })
    expect(await store.unlockFrame(cheese, id, 'cheese')).toMatchObject({ ok: true })
  })

  it('void releases a RESERVED pin too (C2), and the frame can be pinned again by a new card', async () => {
    const entries = await lockedFrames()
    const cardRequestId = card()
    await pins.reserveLock({ cardRequestId, frames: entries })
    multica.status.set(cardRequestId, 'void')
    expect(await pins.releasePin(cardRequestId)).toMatchObject({ ok: true })
    expect(await pins.reserveLock({ cardRequestId: card(), frames: entries })).toMatchObject({ ok: true })
  })

  it('force_release: only a lock owner; calls abort_ref first; void releases and raises the epoch', async () => {
    const h = await held()
    expect(await pins.forceRelease({ cardRequestId: h.cardRequestId, reason: 'x', userId: 'bob' })).toMatchObject({
      ok: false,
      error: 'forbidden',
    })
    expect(await pins.forceRelease({ cardRequestId: h.cardRequestId, reason: 'x' })).toMatchObject({
      ok: false,
      error: 'forbidden',
    })
    expect(state.getPin(h.cardRequestId)?.state).toBe('HELD')
    multica.status.set(h.cardRequestId, 'open')
    const out = await pins.forceRelease({ cardRequestId: h.cardRequestId, reason: 'owner decision', userId: 'cheese' })
    expect(out).toMatchObject({ ok: true, pin: { state: 'RELEASED', releaseReason: 'owner decision' } })
    expect(multica.calls[0]).toBe('abort')
    const id = h.entries[0]!.frameId
    expect(store.getFrame(id)).toMatchObject({ locked: true, lockEpoch: 1 })
    expect(await frameRow(id)).toMatchObject({ locked: true, lockEpoch: 1 })
  })

  it('force_release with Multica down does not release and does not touch the epoch', async () => {
    const h = await held()
    multica.down = true
    expect(await pins.forceRelease({ cardRequestId: h.cardRequestId, reason: 'x', userId: 'cheese' })).toMatchObject({
      ok: false,
      error: 'multica_unreachable',
    })
    expect(state.getPin(h.cardRequestId)?.state).toBe('HELD')
    expect(store.getFrame(h.entries[0]!.frameId)?.lockEpoch ?? 0).toBe(0)
  })

  it('force_release after decided releases without raising the epoch (the chosen version keeps its epoch)', async () => {
    const s = await sealed()
    multica.status.set(s.cardRequestId, 'decided')
    expect(await pins.forceRelease({ cardRequestId: s.cardRequestId, reason: 'x', userId: 'cheese' })).toMatchObject({
      ok: true,
    })
    expect(store.getFrame(s.entries[0]!.frameId)?.lockEpoch ?? 0).toBe(0)
  })
})

describe('U1 unlock (B5)', () => {
  it('returns pinned in RESERVED, HELD and SEALED, changes nothing, even for a lock owner', async () => {
    const entries = await lockedFrames()
    const cardRequestId = card()
    await pins.reserveLock({ cardRequestId, frames: entries })
    const id = entries[0]!.frameId
    expect(await store.unlockFrame(cheese, id, 'cheese')).toMatchObject({ ok: false, error: 'pinned' })
    await pins.confirmPin(cardRequestId)
    expect(await store.unlockFrame(cheese, id, 'cheese')).toMatchObject({ ok: false, error: 'pinned' })
    await pins.pinForPick({ cardRequestId, pickRequestId: 'p', pickedFrameId: id })
    expect(await store.unlockFrame(cheese, id, 'cheese')).toMatchObject({ ok: false, error: 'pinned' })
    expect(store.getFrame(id)).toMatchObject({ locked: true })
    expect(await frameRow(id)).toMatchObject({ locked: true, lockEpoch: null })
  })

  it('the synchronous update path refuses to unlock a pinned frame too', async () => {
    const h = await held()
    expect(() => store.updateFrame(cheese, h.entries[0]!.frameId, { locked: false }, 'cheese')).toThrow(PolicyRefused)
    expect(store.getFrame(h.entries[0]!.frameId)?.locked).toBe(true)
  })

  it('a non-owner is refused by policy before the pin is looked at', async () => {
    const h = await held()
    await expect(store.unlockFrame(bob, h.entries[0]!.frameId, 'bob')).rejects.toThrow(PolicyRefused)
  })
})

describe('pin/durable (B7)', () => {
  it('pin/durable/crash-after-ack: a pin answered by P4 is still there after a restart', async () => {
    const entries = await lockedFrames()
    const cardRequestId = card()
    await pins.reserveLock({ cardRequestId, frames: entries })
    state.replacePins([]) // the process dies: memory is gone, the database is not
    expect(state.isPinned(entries[0]!.frameId)).toBe(false)
    await pins.loadPins()
    expect(state.getPin(cardRequestId)).toMatchObject({ state: 'RESERVED', frames: entries })
    expect(await store.unlockFrame(cheese, entries[0]!.frameId, 'cheese')).toMatchObject({ error: 'pinned' })
  })

  it('pin/durable/persist-fail-reserve: a failed write leaves no pin and no row', async () => {
    const entries = await lockedFrames()
    const cardRequestId = card()
    state.pinHooks.beforeWrite = (op) => {
      if (op === 'reserve') throw new Error('disk full')
    }
    expect(await pins.reserveLock({ cardRequestId, frames: entries })).toMatchObject({
      ok: false,
      error: 'persist_failed',
    })
    expect(state.isPinned(entries[0]!.frameId)).toBe(false)
    expect(await pinRow(cardRequestId)).toBeUndefined()
    expect(await activeRows()).toBe(0)
  })

  it('pin/durable/persist-fail-release: a failed write leaves the pin where it was', async () => {
    const h = await held()
    multica.status.set(h.cardRequestId, 'void')
    state.pinHooks.beforeWrite = (op) => {
      if (op === 'release') throw new Error('disk full')
    }
    expect(await pins.releasePin(h.cardRequestId)).toMatchObject({ ok: false, error: 'persist_failed' })
    expect(state.getPin(h.cardRequestId)?.state).toBe('HELD')
    expect(await pinRow(h.cardRequestId)).toMatchObject({ state: 'HELD' })
    expect(await activeRows()).toBe(1)
  })

  it('pin/durable/persist-fail-unlock: a failed write keeps the frame locked, in memory and in the database', async () => {
    const [e] = await lockedFrames()
    state.pinHooks.beforeWrite = (op) => {
      if (op === 'unlock') throw new Error('disk full')
    }
    expect(await store.unlockFrame(cheese, e!.frameId, 'cheese')).toMatchObject({ ok: false, error: 'persist_failed' })
    expect(store.getFrame(e!.frameId)).toMatchObject({ locked: true, lockAttestationId: e!.attestationId })
    expect(store.getFrame(e!.frameId)?.lockEpoch).toBeUndefined()
    expect(await frameRow(e!.frameId)).toMatchObject({ locked: true, lockEpoch: null })
  })

  it('pin/durable/restart-reload-pins: every state, and its receipt, comes back unchanged', async () => {
    const h = await held()
    const s = await sealed()
    const r = await lockedFrames()
    const reservedCard = card()
    await pins.reserveLock({ cardRequestId: reservedCard, frames: r })
    const before = [h.cardRequestId, s.cardRequestId, reservedCard].map((c) => state.getPin(c))
    state.replacePins([])
    await pins.loadPins()
    expect([h.cardRequestId, s.cardRequestId, reservedCard].map((c) => state.getPin(c))).toEqual(before)
    const again = (await pins.confirmPin(h.cardRequestId)) as { receipt: { mac: string } }
    expect(again.receipt.mac).toBe(h.receipt.mac)
  })

  it('unlock writes the row before it answers: epoch and cleared attestation are in the database at once', async () => {
    const [e] = await lockedFrames()
    expect(await store.unlockFrame(cheese, e!.frameId, 'cheese')).toMatchObject({ ok: true })
    expect(await frameRow(e!.frameId)).toMatchObject({ locked: false, lockEpoch: 1, lockAttestationId: null })
    expect(store.getFrame(e!.frameId)).toMatchObject({ lockEpoch: 1 })
  })

  it('lock_if_version writes the row before it answers, and a failed write leaves the frame unlocked', async () => {
    const canvas = store.createCanvas('Durable lock', 'alice')
    await vi.waitFor(async () => {
      const [c] = await dbm.db.select().from(t.canvases).where(eq(t.canvases.id, canvas.id))
      expect(c).toBeTruthy()
    })
    const f = store.createFrame(sys, canvas.id, { name: 'f', html: '<p>x</p>' }, 'x')!
    const g = store.createFrame(sys, canvas.id, { name: 'g', html: '<p>y</p>' }, 'x')!
    await vi.waitFor(async () => expect(await frameRow(g.id)).toBeTruthy())
    const ok = await store.lockIfVersionDurable(agent, f.id, f.updatedAt, 'att-a')
    expect(ok).toMatchObject({ ok: true, epoch: 0 })
    expect(await frameRow(f.id)).toMatchObject({ locked: true, lockAttestationId: 'att-a' })

    state.pinHooks.beforeWrite = (op) => {
      if (op === 'lock') throw new Error('disk full')
    }
    expect(await store.lockIfVersionDurable(agent, g.id, g.updatedAt, 'att-b')).toMatchObject({
      ok: false,
      error: 'persist_failed',
    })
    expect(store.getFrame(g.id)?.locked).toBeFalsy()
    expect(store.getFrame(g.id)?.lockAttestationId).toBeUndefined()
    expect(await frameRow(g.id)).toMatchObject({ locked: null })
  })
})

describe('pin/no-clock (B4)', () => {
  const week = 7 * 24 * 3600 * 1000
  for (const name of ['RESERVED', 'HELD', 'SEALED'] as const) {
    it(`pin/no-clock/${name}: +7 days with reconcile off changes nothing; unlock stays pinned`, async () => {
      let cardRequestId: string
      let id: string
      if (name === 'SEALED') {
        const s = await sealed()
        cardRequestId = s.cardRequestId
        id = s.entries[0]!.frameId
      } else if (name === 'HELD') {
        const h = await held()
        cardRequestId = h.cardRequestId
        id = h.entries[0]!.frameId
      } else {
        const entries = await lockedFrames()
        cardRequestId = card()
        await pins.reserveLock({ cardRequestId, frames: entries })
        id = entries[0]!.frameId
      }
      const before = await pinRow(cardRequestId)
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'setInterval'], now: Date.now() })
      vi.setSystemTime(Date.now() + week)
      vi.advanceTimersByTime(week)
      vi.useRealTimers()
      expect(state.getPin(cardRequestId)?.state).toBe(name)
      expect(await pinRow(cardRequestId)).toEqual(before)
      expect(await store.unlockFrame(cheese, id, 'cheese')).toMatchObject({ ok: false, error: 'pinned' })
      expect(await pins.releasePin(cardRequestId)).toMatchObject({ ok: false, error: 'not_final' }) // multica says missing
      expect(state.getPin(cardRequestId)?.state).toBe(name)
    })
  }
})

describe('pin/transfer/no-gap (K2)', () => {
  it('no reader sees "no pin" at any point of the HELD to SEALED write, and a parallel unlock never gets through', async () => {
    const h = await held()
    const id = h.entries[0]!.frameId
    let release!: () => void
    const paused = new Promise<void>((r) => (release = r))
    let reachedWrite!: () => void
    const reached = new Promise<void>((r) => (reachedWrite = r))
    state.pinHooks.beforeWrite = async (op) => {
      if (op !== 'pick') return
      reachedWrite()
      await paused
    }
    const pick = pins.pinForPick({ cardRequestId: h.cardRequestId, pickRequestId: 'p', pickedFrameId: id })
    await reached
    /* inside the K2 transaction: still pinned, still HELD, and every unlock refuses */
    expect(state.isPinned(id)).toBe(true)
    expect(state.getPin(h.cardRequestId)?.state).toBe('HELD')
    expect(() => store.updateFrame(cheese, id, { locked: false }, 'cheese')).toThrow(PolicyRefused)
    const racing = store.unlockFrame(cheese, id, 'cheese')
    release()
    expect(await pick).toMatchObject({ ok: true, pin: { state: 'SEALED' } })
    expect(await racing).toMatchObject({ ok: false, error: 'pinned' })
    expect(state.isPinned(id)).toBe(true)
    expect(store.getFrame(id)?.locked).toBe(true)
  })

  it('pin/transfer/force-release-race: a normal release racing a force_release on a void card never skips the epoch raise', async () => {
    const h = await held()
    const id = h.entries[0]!.frameId
    multica.status.set(h.cardRequestId, 'open')
    let open!: () => void
    multica.abortGate = new Promise<void>((r) => (open = r))
    /* force_release aborts: the card is void in Multica, its answer is still on the way */
    const force = pins.forceRelease({ cardRequestId: h.cardRequestId, reason: 'owner decision', userId: 'cheese' })
    await vi.waitFor(() => expect(multica.status.get(h.cardRequestId)).toBe('void'))
    /* the normal release now sees void and must not get in front of the force's epoch raise */
    const normal = pins.releasePin(h.cardRequestId)
    await new Promise((r) => setTimeout(r, 20))
    expect(state.getPin(h.cardRequestId)?.state).toBe('HELD')
    open()
    const [f, nrm] = await Promise.all([force, normal])
    expect(f).toMatchObject({ ok: true, pin: { state: 'RELEASED', releaseReason: 'owner decision' } })
    expect(nrm).toMatchObject({ ok: true, already: true })
    expect(store.getFrame(id)).toMatchObject({ locked: true, lockEpoch: 1 })
    expect(await frameRow(id)).toMatchObject({ locked: true, lockEpoch: 1 })
    expect(await pinRow(h.cardRequestId)).toMatchObject({ state: 'RELEASED', releaseReason: 'owner decision' })
  })

  it('pin/transfer/release-race-order: the other way round the void release still raises the epoch once', async () => {
    const h = await held()
    const id = h.entries[0]!.frameId
    multica.status.set(h.cardRequestId, 'open')
    const results = await Promise.all([
      pins.releasePin(h.cardRequestId),
      pins.forceRelease({ cardRequestId: h.cardRequestId, reason: 'owner decision', userId: 'cheese' }),
      pins.releasePin(h.cardRequestId),
    ])
    expect(results[0]).toMatchObject({ ok: false, error: 'not_final' })
    expect(results[1]).toMatchObject({ ok: true })
    expect(results[2]).toMatchObject({ ok: true, already: true })
    expect(store.getFrame(id)?.lockEpoch).toBe(1)
  })
})

describe('pin/receipt (R1, R2)', () => {
  const epochsOf = (entries: { frameId: string; epoch: number }[]) =>
    Object.fromEntries(entries.map((e) => [e.frameId, e.epoch]))

  it('a receipt doop issued verifies, and carries the card, the pin and the epochs', async () => {
    const h = await held()
    expect(h.receipt).toMatchObject({
      kind: 'R1',
      cardRequestId: h.cardRequestId,
      state: 'HELD',
      epochs: epochsOf(h.entries),
    })
    expect(pins.verifyReceipt(SECRET, h.receipt)).toBe(true)
    const s = await sealed()
    expect(s.r2).toMatchObject({ kind: 'R2', state: 'SEALED', pickRequestId: s.pickRequestId })
    expect(pins.verifyReceipt(SECRET, s.r2)).toBe(true)
  })

  it('pin/receipt/forged-r1: a changed field, a wrong secret or a swapped kind does not verify', async () => {
    const h = await held()
    expect(pins.verifyReceipt(SECRET, { ...h.receipt, cardRequestId: 'other' })).toBe(false)
    expect(pins.verifyReceipt(SECRET, { ...h.receipt, mac: '0'.repeat(h.receipt.mac.length) })).toBe(false)
    expect(pins.verifyReceipt('not-the-secret', h.receipt)).toBe(false)
    expect(pins.verifyReceipt(SECRET, { ...h.receipt, kind: 'R2' })).toBe(false)
  })

  it('pin/receipt/forged-r2: an R2 with another pick, another frame or an R1 as R2 does not verify', async () => {
    const s = await sealed()
    expect(pins.verifyReceipt(SECRET, { ...s.r2, pickRequestId: 'other-pick' })).toBe(false)
    expect(pins.verifyReceipt(SECRET, { ...s.r2, pickedFrameId: 'other-frame' })).toBe(false)
    expect(pins.verifyReceipt(SECRET, { ...s.r2, state: 'HELD' })).toBe(false)
    expect(pins.verifyReceipt(SECRET, { ...s.receipt, kind: 'R2' })).toBe(false)
  })

  it('pin/receipt/wrong-epoch: an epoch changed after signing does not verify', async () => {
    const h = await held()
    const frameId = h.entries[0]!.frameId
    expect(pins.verifyReceipt(SECRET, { ...h.receipt, epochs: { [frameId]: 5 } })).toBe(false)
    expect(pins.verifyReceipt(SECRET, { ...h.receipt, epochs: {} })).toBe(false)
  })

  it('without a shared secret doop issues no receipt (fail closed) and the pin stays RESERVED', async () => {
    pins.configurePins({ secret: undefined, multica })
    const entries = await lockedFrames()
    const cardRequestId = card()
    await pins.reserveLock({ cardRequestId, frames: entries })
    expect(await pins.confirmPin(cardRequestId)).toMatchObject({ ok: false, error: 'no_secret' })
    expect(state.getPin(cardRequestId)?.state).toBe('RESERVED')
  })
})

describe('lock_if_version at publish (B7)', () => {
  const entry = (f: { id: string; updatedAt: number }, attestationId: string) => ({
    frameId: f.id,
    attestedUpdatedAt: f.updatedAt,
    attestationId,
  })
  async function twoFrames() {
    const canvas = store.createCanvas('Publish', 'alice')
    await vi.waitFor(async () => {
      const [c] = await dbm.db.select().from(t.canvases).where(eq(t.canvases.id, canvas.id))
      expect(c).toBeTruthy()
    })
    const f = store.createFrame(sys, canvas.id, { name: 'f', html: '<p>x</p>' }, 'x')!
    const g = store.createFrame(sys, canvas.id, { name: 'g', html: '<p>y</p>' }, 'x')!
    await vi.waitFor(async () => expect(await frameRow(g.id)).toBeTruthy())
    return { f, g }
  }
  const actor = { name: 'agent', kind: 'agent' as const, color: '#000000' }

  it('answers only after every row is written', async () => {
    const { f, g } = await twoFrames()
    let release!: () => void
    state.pinHooks.beforeWrite = async (op) => {
      if (op === 'lock') await new Promise<void>((r) => (release = r))
    }
    let done = false
    const out = actions.lockFramesForPublish([entry(f, 'att-f')], actor).then((r) => ((done = true), r))
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    await new Promise((r) => setTimeout(r, 20))
    expect(done).toBe(false)
    expect(await frameRow(f.id)).toMatchObject({ locked: null })
    state.pinHooks.beforeWrite = undefined
    release()
    expect(await out).toMatchObject({ cardAllowed: true })
    expect(await frameRow(f.id)).toMatchObject({ locked: true, lockAttestationId: 'att-f' })
    expect(g.id).toBeTruthy()
  })

  it('a failed write withholds the card, leaves that frame unlocked and the one before it locked', async () => {
    const { f, g } = await twoFrames()
    let calls = 0
    state.pinHooks.beforeWrite = (op) => {
      if (op === 'lock' && ++calls === 2) throw new Error('disk full')
    }
    const out = await actions.lockFramesForPublish([entry(f, 'att-f'), entry(g, 'att-g')], actor)
    expect(out.cardAllowed).toBe(false)
    expect(out.results.map((r) => ('error' in r ? r.error : 'ok'))).toEqual(['ok', 'persist_failed'])
    expect(await frameRow(f.id)).toMatchObject({ locked: true })
    expect(store.getFrame(g.id)?.locked).toBeFalsy()
    expect(await frameRow(g.id)).toMatchObject({ locked: null })
  })
})
