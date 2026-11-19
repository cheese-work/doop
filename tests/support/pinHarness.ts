import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { expect, vi } from 'vitest'

/* CHE-7063 (G5c of CHE-6078, spec che-6078-g5-lock-pin-r1 section 8): the test infrastructure of the interleaving
   table. A real temporary pglite database for doop, an in-memory Multica fake that keeps its own card rows and
   CAS rules, and a scenario that walks the steps P2..K5 / C1 / C2 one at a time.
     pauseAfter(point)   run the happy path up to a stop point and hand control back
     resume()            run what is left of the happy path
     clock.advance(ms)   the clock for doop's reconcile and for the fake Multica
     crashMultica() / restartMultica()   Multica stops answering, its rows stay
     dropResponse(step)  the step happened, its answer never reached the caller, who retries
     assertInvariants()  reads both databases and checks B1, B2/B3, B5, B6 and the main invariant */

export type Status = 'pending' | 'open' | 'pick_pending' | 'decided' | 'void' | 'missing'
export type Step = 'P2' | 'P3' | 'P4' | 'P5' | 'P6' | 'P7' | 'K1' | 'K2' | 'K4' | 'K5' | 'C1' | 'C2'
export const POINTS = ['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8', 'G9', 'G10', 'V1', 'V2'] as const
export type Point = (typeof POINTS)[number]
export const EVENTS = ['E1', 'E2', 'E3', 'E4', 'E5'] as const
export type Event = (typeof EVENTS)[number]

/** the steps done when a stop point is reached; the last one is the step the stop point follows */
export const PATH: Record<Point, Step[]> = {
  G1: ['P2'],
  G2: ['P2', 'P3'],
  G3: ['P2', 'P3', 'P4'],
  G4: ['P2', 'P3', 'P4', 'P5'],
  G5: ['P2', 'P3', 'P4', 'P5', 'P6'],
  G6: ['P2', 'P3', 'P4', 'P5', 'P6', 'P7'],
  G7: ['P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'K1'],
  G8: ['P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'K1', 'K2'],
  G9: ['P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'K1', 'K2', 'K4'],
  G10: ['P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'K1', 'K2', 'K4', 'K5'],
  V1: ['P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'C1'],
  V2: ['P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'C1', 'C2'],
}
const HAPPY: Step[] = ['P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'K1', 'K2', 'K4', 'K5']

export const SECRET = 'shared-secret'
export const WEEK = 7 * 24 * 3600 * 1000

export async function pinWorld() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doop-pininterleave-'))
  const cwd = process.cwd()
  process.chdir(dir)
  const dbm = await import('../../server/db/index.ts')
  const t = await import('../../server/db/schema.ts')
  const { store } = await import('../../server/store.ts')
  const { setLockOwners, systemContext } = await import('../../server/writePolicy.ts')
  const pins = await import('../../server/framePins.ts')
  const rec = await import('../../server/pinReconcile.ts')
  const state = await import('../../server/pinState.ts')
  await dbm.initDb()
  process.chdir(cwd)
  setLockOwners(['cheese'])
  type Receipt = import('../../server/framePins.ts').Receipt

  const sys = systemContext()
  const agent = { kind: 'agent' as const }
  const cheese = { kind: 'user' as const, userId: 'cheese' }

  /* ---- the clock: real time plus an offset the tests move ---- */
  const clock = {
    offset: 0,
    now: () => Date.now() + clock.offset,
    advance(ms: number) {
      clock.offset += ms
    },
  }

  async function frameRow(frameId: string) {
    const [r] = await dbm.db.select().from(t.frames).where(eq(t.frames.id, frameId))
    return r
  }
  const frameView = async (frameId: string) => {
    const r = await frameRow(frameId)
    return { locked: !!r?.locked, epoch: r?.lockEpoch ?? 0, updatedAt: Number(r?.updatedAt) }
  }

  /* ---- Multica: its own card rows, CAS rules and receipt checks ---- */
  type Card = {
    status: Exclude<Status, 'missing'>
    epochs?: Record<string, number>
    r1?: Receipt
    r2?: Receipt
    pickRequestId?: string
    pickedFrameId?: string
    /** doop's frame rows at the instant the card became `open`, and again at `decided` */
    atOpen?: Awaited<ReturnType<typeof frameView>>[]
    atDecided?: Awaited<ReturnType<typeof frameView>>[]
  }
  const multica = {
    cards: new Map<string, Card>(),
    down: false,
    calls: [] as string[],
    reset() {
      multica.cards.clear()
      multica.down = false
      multica.calls = []
    },
    alive(call: string) {
      multica.calls.push(call)
      if (multica.down) throw new Error('multica down')
    },
    status: (card: string): Status => multica.cards.get(card)?.status ?? 'missing',
    /* the port doop calls */
    async refStatus(card: string): Promise<Status> {
      multica.alive('ref')
      return multica.status(card)
    },
    async abortRef(card: string): Promise<Status> {
      multica.alive('abort')
      const row = multica.cards.get(card)
      if (!row) multica.cards.set(card, { status: 'void' })
      else if (row.status !== 'decided') row.status = 'void'
      return multica.status(card)
    },
    async abortIfPending(card: string): Promise<{ status: Status; notAborted: boolean }> {
      multica.alive('abortIfPending')
      const row = multica.cards.get(card)
      if (!row) {
        multica.cards.set(card, { status: 'void' })
        return { status: 'void', notAborted: false }
      }
      if (row.status === 'pending') {
        row.status = 'void'
        return { status: 'void', notAborted: false }
      }
      return { status: row.status, notAborted: true }
    },
    /* Multica's own steps */
    createPending(card: string) {
      multica.alive('P3')
      if (!multica.cards.has(card)) multica.cards.set(card, { status: 'pending' })
      return { ok: true as const, status: multica.status(card) }
    },
    recordEpoch(card: string, epochs: Record<string, number>) {
      multica.alive('P5')
      const row = multica.cards.get(card)
      if (!row || row.status !== 'pending') return { ok: false as const, error: 'not_pending' }
      row.epochs = epochs
      return { ok: true as const }
    },
    async open(card: string, r1: Receipt | undefined) {
      multica.alive('P7')
      const row = multica.cards.get(card)
      if (!row) return { ok: false as const, error: 'no_card' }
      if (row.status === 'open') return { ok: true as const, status: row.status }
      if (row.status !== 'pending') return { ok: false as const, error: 'not_pending' }
      if (!r1 || r1.kind !== 'R1' || r1.cardRequestId !== card || !pins.verifyReceipt(SECRET, r1))
        return { ok: false as const, error: 'bad_receipt' }
      if (JSON.stringify(r1.epochs) !== JSON.stringify(row.epochs)) return { ok: false as const, error: 'wrong_epoch' }
      row.status = 'open'
      row.r1 = r1
      row.atOpen = await Promise.all(Object.keys(r1.epochs).map(frameView))
      return { ok: true as const, status: row.status }
    },
    pick(card: string, pickRequestId: string, pickedFrameId: string) {
      multica.alive('K1')
      const row = multica.cards.get(card)
      if (!row) return { ok: false as const, error: 'no_card' }
      if (row.status === 'pick_pending' && row.pickRequestId === pickRequestId)
        return { ok: true as const, status: row.status }
      if (row.status !== 'open') return { ok: false as const, error: 'not_open' }
      row.status = 'pick_pending'
      row.pickRequestId = pickRequestId
      row.pickedFrameId = pickedFrameId
      return { ok: true as const, status: row.status }
    },
    async decide(card: string, r2: Receipt | undefined) {
      multica.alive('K4')
      const row = multica.cards.get(card)
      if (!row) return { ok: false as const, error: 'no_card' }
      if (row.status === 'decided' && row.r2?.mac === r2?.mac) return { ok: true as const, status: row.status }
      if (row.status !== 'pick_pending') return { ok: false as const, error: 'not_pick_pending' }
      if (
        !r2 ||
        r2.kind !== 'R2' ||
        r2.cardRequestId !== card ||
        r2.pickRequestId !== row.pickRequestId ||
        !pins.verifyReceipt(SECRET, r2)
      )
        return { ok: false as const, error: 'bad_receipt' }
      row.status = 'decided'
      row.r2 = r2
      row.atDecided = await Promise.all(Object.keys(r2.epochs).map(frameView))
      return { ok: true as const, status: row.status }
    },
    voidCard(card: string) {
      multica.alive('C1')
      const row = multica.cards.get(card)
      if (!row) multica.cards.set(card, { status: 'void' })
      else if (row.status !== 'decided') row.status = 'void'
      return { ok: true as const, status: multica.status(card) }
    },
    /** Multica's `pick_driver`: for a `pick_pending` card, ask doop for R2 (idempotent K2) and commit K4 */
    async pickDriver(card: string) {
      const row = multica.cards.get(card)
      if (!row || row.status !== 'pick_pending') return { ok: false as const, error: 'not_pick_pending' }
      const out = await pins.pinForPick({
        cardRequestId: card,
        pickRequestId: row.pickRequestId!,
        pickedFrameId: row.pickedFrameId!,
      })
      if (!out.ok) return { ok: false as const, error: out.error }
      return multica.decide(card, out.receipt)
    },
  }

  type Result = { ok: boolean; error?: string; raw?: unknown }
  const norm = (raw: unknown): Result => {
    const r = raw as { ok?: boolean; error?: string } | undefined
    return { ok: !!r?.ok, error: r?.error, raw }
  }

  let counter = 0

  /* ---- a scenario: one frame, one card, one walk through the steps ---- */
  async function scenario() {
    counter++
    const canvas = store.createCanvas('Interleave', 'alice')
    await vi.waitFor(async () => {
      const [c] = await dbm.db.select().from(t.canvases).where(eq(t.canvases.id, canvas.id))
      expect(c).toBeTruthy()
    })
    const f = store.createFrame(sys, canvas.id, { name: 'f', html: '<p>x</p>' }, 'x')!
    await vi.waitFor(async () => expect(await frameRow(f.id)).toBeTruthy())
    const st = {
      p2: { updatedAt: f.updatedAt, epoch: 0 },
      r1: undefined as Receipt | undefined,
      r2: undefined as Receipt | undefined,
      done: [] as Step[],
      unlocks: [] as { ok: boolean; pinnedBefore: boolean; error?: string }[],
      epochsSeen: [0],
    }
    const cardRequestId = `card-${counter}`
    const pickRequestId = `pick-${counter}`
    const attestationId = `att-${f.id}`
    const entry = () => ({ frameId: f.id, updatedAt: st.p2.updatedAt, attestationId, epoch: st.p2.epoch })
    const epochs = () => ({ [f.id]: st.p2.epoch })

    /** one step; a thrown error (Multica down) is a refusal, never a crash of the test */
    const step = async (name: Step): Promise<Result> => {
      try {
        let out: Result
        switch (name) {
          case 'P2': {
            const r = await store.lockIfVersionDurable(agent, f.id, st.p2.updatedAt, attestationId)
            out = norm(r)
            break
          }
          case 'P3':
            out = norm(multica.createPending(cardRequestId))
            break
          case 'P4':
            out = norm(await pins.reserveLock({ cardRequestId: cardRequestId, frames: [entry()] }))
            break
          case 'P5':
            out = norm(multica.recordEpoch(cardRequestId, epochs()))
            break
          case 'P6': {
            const r = await pins.confirmPin(cardRequestId)
            if (r.ok) st.r1 = r.receipt
            out = norm(r)
            break
          }
          case 'P7':
            out = norm(await multica.open(cardRequestId, st.r1))
            break
          case 'K1':
            out = norm(multica.pick(cardRequestId, pickRequestId, f.id))
            break
          case 'K2': {
            const r = await pins.pinForPick({
              cardRequestId: cardRequestId,
              pickRequestId: pickRequestId,
              pickedFrameId: f.id,
              versions: [{ frameId: f.id, updatedAt: st.p2.updatedAt, epoch: st.p2.epoch }],
            })
            if (r.ok) st.r2 = r.receipt
            out = norm(r)
            break
          }
          case 'K4':
            out = norm(await multica.decide(cardRequestId, st.r2))
            break
          case 'K5':
          case 'C2':
            out = norm(await pins.releasePin(cardRequestId))
            break
          case 'C1':
            out = norm(multica.voidCard(cardRequestId))
            break
        }
        if (out.ok) st.done.push(name)
        return out
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : 'threw' }
      }
    }

    const s = {
      frameId: f.id,
      cardRequestId,
      pickRequestId,
      attestationId,
      /** the frame as P2 left it: the version and epoch the card is bound to */
      p2: st.p2,
      get r1() {
        return st.r1
      },
      get r2() {
        return st.r2
      },
      done: st.done,
      unlocks: st.unlocks,
      epochsSeen: st.epochsSeen,
      entry,
      epochs,
      step,
      pin: () => state.getPin(cardRequestId),

      /** run the happy path up to `point`, checking every step took; control comes back there */
      async pauseAfter(point: Point): Promise<void> {
        for (const name of PATH[point]) {
          if (st.done.includes(name)) continue
          const r = await step(name)
          expect(r, `${name} on the way to ${point}`).toMatchObject({ ok: true })
        }
      },
      /** the rest of the happy path after the stop point (stops at the first refused step) */
      async resume(from: Step[] = HAPPY) {
        const out: Record<string, Result> = {}
        for (const name of from) {
          if (st.done.includes(name)) continue
          out[name] = await step(name)
          if (!out[name]!.ok) break
        }
        return out
      },
      /** the step happened but its answer never reached the caller */
      dropResponse(step: Step) {
        if (step === 'P6') st.r1 = undefined
        if (step === 'K2') st.r2 = undefined
      },

      /* ---- events ---- */
      async unlock() {
        const pinnedBefore = !!state.pinOf(f.id)
        const r = await store.unlockFrame(cheese, f.id, 'cheese')
        const res = { ok: !!r?.ok, pinnedBefore, error: r && !r.ok ? r.error : undefined }
        st.unlocks.push(res)
        st.epochsSeen.push((await frameView(f.id)).epoch)
        return res
      },
      /** lock the frame again at its current version (a new epoch is then what the pin is checked against) */
      async relock() {
        const row = await frameView(f.id)
        const r = await store.lockIfVersionDurable(agent, f.id, row.updatedAt, attestationId)
        expect(r).toMatchObject({ ok: true })
      },
      force: () => pins.forceRelease({ cardRequestId: cardRequestId, reason: 'owner', userId: 'cheese' }),
      release: () => pins.releasePin(cardRequestId),
      reconcile: async () =>
        (await rec.reconcilePins({ now: clock.now() })).filter((o) => o.cardRequestId === cardRequestId),
      view: () => frameView(f.id),
      async expectFrameUnchanged() {
        expect(await frameView(f.id)).toEqual({ locked: true, epoch: st.p2.epoch, updatedAt: st.p2.updatedAt })
      },
      async expectUnpinnedAfter(expectedEpoch: number) {
        expect(await frameView(f.id)).toMatchObject({ locked: false, epoch: expectedEpoch })
      },
    }
    return s
  }

  async function atPoint(point: Point) {
    const s = await scenario()
    await s.pauseAfter(point)
    return s
  }

  function crashMultica() {
    multica.down = true
  }
  function restartMultica() {
    multica.down = false
  }

  /** B1, B2/B3, B5, B6 and the main invariant, read from both databases; then Multica is left alive to converge. */
  async function assertInvariants(s: Awaited<ReturnType<typeof scenario>>, options: { converge?: boolean } = {}) {
    const rows = await dbm.db.select().from(t.framePins)
    const row = rows.find((r) => r.cardRequestId === s.cardRequestId)
    const card = multica.cards.get(s.cardRequestId)
    const final = (x?: string) => x === 'decided' || x === 'void'
    /* B1: no pin released while Multica's card is not at a final state */
    for (const r of rows)
      if (r.state === 'RELEASED')
        expect(final(multica.cards.get(r.cardRequestId)?.status), 'B1 released early').toBe(true)
    /* B2/B3: every open / decided card has a receipt doop issued, matching its pin */
    if (card && ['open', 'pick_pending', 'decided'].includes(card.status)) {
      expect(card.r1 && pins.verifyReceipt(SECRET, card.r1), 'B2 open without R1').toBe(true)
      expect(card.r1?.pinId).toBe(row?.pinId)
      expect(card.r1?.epochs).toEqual(s.epochs())
    }
    if (card?.status === 'decided') {
      expect(card.r2 && pins.verifyReceipt(SECRET, card.r2), 'B3 decided without R2').toBe(true)
      expect(card.r2?.pinId).toBe(row?.pinId)
    }
    /* B5: no unlock went through while a pin held the frame */
    for (const u of s.unlocks) expect(u.ok && u.pinnedBefore, 'B5 unlock through a pin').toBe(false)
    /* B6: the epoch only goes up */
    const now = (await frameView(s.frameId)).epoch
    expect(s.epochsSeen).toEqual([...s.epochsSeen].sort((a, b) => a - b))
    expect(now).toBeGreaterThanOrEqual(Math.max(...s.epochsSeen))
    /* main: an open card needs the frame as P2 left it, now; an open or decided card had it at that instant */
    const p2 = { locked: true, epoch: s.p2.epoch, updatedAt: s.p2.updatedAt }
    if (card?.status === 'open') expect(await frameView(s.frameId), 'open on a changed frame').toEqual(p2)
    if (card?.atOpen) expect(card.atOpen[0], 'opened on a changed frame').toEqual(p2)
    if (card?.atDecided) expect(card.atDecided[0], 'decided on a changed frame').toEqual(p2)

    /* convergence: with Multica alive, a reconcile a week later leaves no pin behind a final card */
    if (options.converge !== false && !multica.down) {
      clock.advance(WEEK)
      for (const [id, c] of multica.cards) if (c.status === 'pick_pending') await multica.pickDriver(id)
      await rec.reconcilePins({ now: clock.now() })
      for (const r of await dbm.db.select().from(t.framePins)) {
        if (r.state === 'RELEASED') continue
        expect(multica.cards.get(r.cardRequestId)?.status, `orphan pin ${r.cardRequestId}`).toBe('open')
      }
    }
  }

  async function reset() {
    multica.reset()
    clock.offset = 0
    state.pinHooks.beforeWrite = undefined
    rec.reconcileHooks.afterRead = undefined
    await dbm.db.delete(t.framePinFrames)
    await dbm.db.delete(t.framePins)
    state.replacePins([])
    pins.configurePins({ secret: SECRET, multica })
  }
  function cleanup() {
    fs.rmSync(dir, { recursive: true, force: true })
  }

  return {
    dbm,
    t,
    store,
    pins,
    rec,
    state,
    clock,
    multica,
    scenario,
    atPoint,
    crashMultica,
    restartMultica,
    assertInvariants,
    frameView,
    reset,
    cleanup,
    sys,
    agent,
    cheese,
  }
}
export type PinWorld = Awaited<ReturnType<typeof pinWorld>>
export type Scenario = Awaited<ReturnType<PinWorld['scenario']>>
