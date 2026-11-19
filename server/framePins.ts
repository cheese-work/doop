/** Lock pins (CHE-7062, G5b of CHE-6078; spec che-6078-g5-lock-pin-r1, sections 2, 3, 4, 7).
 *
 *  A decision card holds the frames it shows. States RESERVED -> HELD -> SEALED -> RELEASED, and NO clock moves a
 *  pin (B4): only Multica's own answer (`decided` / `void`, B1) or an owner's force_release (F1, which asks Multica
 *  first) releases one. Each step is one database transaction that is durable before the caller hears of it (B7).
 *  Multica is reached through `MulticaPort`; this file never decides for it. */
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import * as persist from './db/persist.ts'
import {
  exclusive,
  getPin,
  dropPin,
  pinHooks,
  pinOf,
  replacePins,
  setPin,
  type Pin,
  type PinFrame,
} from './pinState.ts'
import { store } from './store.ts'
import { isLockOwner } from './writePolicy.ts'

export type MulticaStatus = 'pending' | 'open' | 'pick_pending' | 'decided' | 'void' | 'missing'
export interface MulticaPort {
  /** A1's read half: where the card stands, asked of Multica itself */
  refStatus(cardRequestId: string): Promise<MulticaStatus>
  /** A1: close the card as void unless it is already decided; answers the final status */
  abortRef(cardRequestId: string, reason: string): Promise<MulticaStatus>
}
export type Receipt = {
  kind: 'R1' | 'R2'
  cardRequestId: string
  pinId: string
  state: 'HELD' | 'SEALED'
  epochs: Record<string, number>
  pickRequestId?: string
  pickedFrameId?: string
  mac: string
}
type Fail = { ok: false; error: string; status?: MulticaStatus }
type Versions = { frameId: string; updatedAt: number; epoch: number }[]

let secret: string | undefined
let multica: MulticaPort | undefined
export function configurePins(options: { secret?: string; multica?: MulticaPort }): void {
  secret = options.secret || undefined
  multica = options.multica
}

/** Boot: the database is the truth, so every pin is read back before the first unlock can be answered. */
export async function loadPins(): Promise<void> {
  replacePins(await persist.loadPins())
}

/* ---- receipts ---- */

const macOf = (key: string, r: Omit<Receipt, 'mac'>): string =>
  createHmac('sha256', key)
    .update(
      JSON.stringify([
        r.kind,
        r.cardRequestId,
        r.pinId,
        r.state,
        Object.entries(r.epochs).sort(([a], [b]) => (a < b ? -1 : 1)),
        r.pickRequestId ?? null,
        r.pickedFrameId ?? null,
      ]),
    )
    .digest('hex')

const epochsOf = (frames: PinFrame[]): Record<string, number> =>
  Object.fromEntries(frames.map((f) => [f.frameId, f.epoch]))

const receiptOf = (pin: Pin, kind: 'R1' | 'R2'): Receipt | undefined => {
  const mac = kind === 'R1' ? pin.r1 : pin.r2
  if (!mac) return undefined
  return kind === 'R1'
    ? { kind, cardRequestId: pin.cardRequestId, pinId: pin.pinId, state: 'HELD', epochs: epochsOf(pin.frames), mac }
    : {
        kind,
        cardRequestId: pin.cardRequestId,
        pinId: pin.pinId,
        state: 'SEALED',
        epochs: epochsOf(pin.frames),
        pickRequestId: pin.pickRequestId,
        pickedFrameId: pin.pickedFrameId,
        mac,
      }
}

/** True only for a receipt this secret signed, field for field. */
export function verifyReceipt(key: string, receipt: Receipt): boolean {
  if (!key || typeof receipt?.mac !== 'string') return false
  const { mac, ...fields } = receipt
  const want = Buffer.from(macOf(key, fields), 'hex')
  const got = Buffer.from(mac, 'hex')
  return want.length === got.length && timingSafeEqual(want, got)
}

/* ---- steps ---- */

/** One durable step: the hook (a test seam), then the transaction. */
async function write(
  op: Parameters<NonNullable<typeof pinHooks.beforeWrite>>[0],
  pin: Pin,
  mode: 'insert' | 'update',
  epochs?: { frameId: string; epoch: number }[],
): Promise<boolean> {
  try {
    await pinHooks.beforeWrite?.(op)
    await persist.writePin(pin, mode, epochs)
    return true
  } catch {
    return false
  }
}

const sameFrames = (a: PinFrame[], b: PinFrame[]): boolean => {
  const key = (f: PinFrame) => `${f.frameId}|${f.updatedAt}|${f.attestationId}|${f.epoch}`
  return a.length === b.length && JSON.stringify(a.map(key).sort()) === JSON.stringify(b.map(key).sort())
}

const validFrame = (f: unknown): f is PinFrame =>
  !!f &&
  typeof (f as PinFrame).frameId === 'string' &&
  !!(f as PinFrame).frameId &&
  typeof (f as PinFrame).attestationId === 'string' &&
  !!(f as PinFrame).attestationId &&
  Number.isFinite((f as PinFrame).updatedAt) &&
  Number.isInteger((f as PinFrame).epoch)

/** P4: pin every frame of a card, all or none. Idempotent on `cardRequestId`. The pin is visible to every unlock at
 *  once (narrowing) and is taken back if its row cannot be written. */
export function reserveLock(input: {
  cardRequestId: string
  frames: PinFrame[]
}): Promise<{ ok: true; pin: Pin; already?: true } | Fail> {
  const { cardRequestId, frames } = input
  const ids = new Set(Array.isArray(frames) ? frames.map((f) => f?.frameId) : [])
  if (
    typeof cardRequestId !== 'string' ||
    !cardRequestId ||
    !Array.isArray(frames) ||
    !frames.length ||
    !frames.every(validFrame) ||
    ids.size !== frames.length
  )
    return Promise.resolve({ ok: false, error: 'invalid' })
  return exclusive(async (): Promise<{ ok: true; pin: Pin; already?: true } | Fail> => {
    const existing = getPin(cardRequestId)
    if (existing) {
      if (existing.state === 'RELEASED') return { ok: false, error: 'released' }
      return sameFrames(existing.frames, frames)
        ? { ok: true, pin: existing, already: true }
        : { ok: false, error: 'invalid' }
    }
    for (const entry of frames) {
      const frame = store.getFrame(entry.frameId)
      if (!frame) return { ok: false, error: 'not_found' }
      if (!frame.locked) return { ok: false, error: 'not_locked' }
      if (pinOf(entry.frameId)) return { ok: false, error: 'pinned_by_other' }
      if (frame.lockAttestationId !== entry.attestationId) return { ok: false, error: 'attestation_invalid' }
      /* the epoch first: an unlock and re-lock between P2 and now is the sharper news */
      if ((frame.lockEpoch ?? 0) !== entry.epoch) return { ok: false, error: 'epoch_changed' }
      if (frame.updatedAt !== entry.updatedAt) return { ok: false, error: 'version_changed' }
    }
    const now = Date.now()
    const pin: Pin = {
      cardRequestId,
      pinId: randomUUID(),
      state: 'RESERVED',
      frames: frames.map(({ frameId, updatedAt, attestationId, epoch }) => ({
        frameId,
        updatedAt,
        attestationId,
        epoch,
      })),
      stateChangedAt: now,
      createdAt: now,
    }
    setPin(pin)
    if (!(await write('reserve', pin, 'insert'))) {
      dropPin(cardRequestId)
      return { ok: false, error: 'persist_failed' }
    }
    return { ok: true, pin }
  })
}

/** P6: RESERVED -> HELD, and R1. A retry (or a later state) answers the same R1. */
export function confirmPin(cardRequestId: string): Promise<{ ok: true; pin: Pin; receipt: Receipt } | Fail> {
  return exclusive(async (): Promise<{ ok: true; pin: Pin; receipt: Receipt } | Fail> => {
    const pin = getPin(cardRequestId)
    if (!pin) return { ok: false, error: 'no_pin' }
    if (pin.state === 'RELEASED') return { ok: false, error: 'released' }
    if (pin.state !== 'RESERVED') {
      const receipt = receiptOf(pin, 'R1')
      return receipt ? { ok: true, pin, receipt } : { ok: false, error: 'no_pin' }
    }
    if (!secret) return { ok: false, error: 'no_secret' }
    const base = {
      kind: 'R1' as const,
      cardRequestId,
      pinId: pin.pinId,
      state: 'HELD' as const,
      epochs: epochsOf(pin.frames),
    }
    const next: Pin = { ...pin, state: 'HELD', r1: macOf(secret, base), stateChangedAt: Date.now() }
    if (!(await write('confirm', next, 'update'))) return { ok: false, error: 'persist_failed' }
    setPin(next)
    return { ok: true, pin: next, receipt: receiptOf(next, 'R1')! }
  })
}

/** K2: HELD -> SEALED with the pick, and R2, in one transaction. The pin is HELD until that commits and covers
 *  every frame throughout, so there is no instant without one (no-gap). */
export function pinForPick(input: {
  cardRequestId: string
  pickRequestId: string
  pickedFrameId: string
  versions?: Versions
}): Promise<{ ok: true; pin: Pin; receipt: Receipt } | Fail> {
  const { cardRequestId, pickRequestId, pickedFrameId, versions } = input
  if (!cardRequestId || !pickRequestId || !pickedFrameId) return Promise.resolve({ ok: false, error: 'invalid' })
  return exclusive(async (): Promise<{ ok: true; pin: Pin; receipt: Receipt } | Fail> => {
    const pin = getPin(cardRequestId)
    if (!pin) return { ok: false, error: 'no_pin' }
    if (pin.state === 'RELEASED') return { ok: false, error: 'released' }
    if (pin.state === 'RESERVED') return { ok: false, error: 'no_pin' }
    if (pin.state === 'SEALED') {
      const receipt = receiptOf(pin, 'R2')
      return pin.pickRequestId === pickRequestId && pin.pickedFrameId === pickedFrameId && receipt
        ? { ok: true, pin, receipt }
        : { ok: false, error: 'pick_conflict' }
    }
    if (!pin.frames.some((f) => f.frameId === pickedFrameId)) return { ok: false, error: 'bad_pick' }
    for (const v of versions ?? []) {
      const held = pin.frames.find((f) => f.frameId === v.frameId)
      if (!held) return { ok: false, error: 'bad_pick' }
      if (held.epoch !== v.epoch) return { ok: false, error: 'epoch_changed' }
      if (held.updatedAt !== v.updatedAt) return { ok: false, error: 'version_changed' }
    }
    if (!secret) return { ok: false, error: 'no_secret' }
    const base = {
      kind: 'R2' as const,
      cardRequestId,
      pinId: pin.pinId,
      state: 'SEALED' as const,
      epochs: epochsOf(pin.frames),
      pickRequestId,
      pickedFrameId,
    }
    const next: Pin = {
      ...pin,
      state: 'SEALED',
      pickRequestId,
      pickedFrameId,
      r2: macOf(secret, base),
      stateChangedAt: Date.now(),
    }
    if (!(await write('pick', next, 'update'))) return { ok: false, error: 'persist_failed' }
    setPin(next)
    return { ok: true, pin: next, receipt: receiptOf(next, 'R2')! }
  })
}

/** A loosening write: the row first, memory after. `bump` raises the epoch of every frame in the same commit. */
async function releaseNow(
  cardRequestId: string,
  reason: string,
  bump: boolean,
): Promise<{ ok: true; pin: Pin; already?: true } | Fail> {
  return exclusive(async (): Promise<{ ok: true; pin: Pin; already?: true } | Fail> => {
    const pin = getPin(cardRequestId)
    if (!pin) return { ok: false, error: 'no_pin' }
    if (pin.state === 'RELEASED') return { ok: true, pin, already: true }
    const next: Pin = { ...pin, state: 'RELEASED', releaseReason: reason, stateChangedAt: Date.now() }
    const epochs = bump
      ? pin.frames.map((f) => ({ frameId: f.frameId, epoch: (store.getFrame(f.frameId)?.lockEpoch ?? f.epoch) + 1 }))
      : undefined
    if (!(await write('release', next, 'update', epochs))) return { ok: false, error: 'persist_failed' }
    if (epochs) store.setLockEpochs(epochs)
    setPin(next)
    return { ok: true, pin: next }
  })
}

/** Release decisions queue behind each other (not behind unlocks): the Multica answer and the write that acts on it
 *  are one step, so a normal release can never slip between a force_release's `void` and its epoch bump. */
let releaseTail: Promise<unknown> = Promise.resolve()
function releaseLane<T>(job: () => Promise<T>): Promise<T> {
  const run = releaseTail.then(job, job)
  releaseTail = run.catch(() => undefined)
  return run
}

const final = (s: MulticaStatus): s is 'decided' | 'void' => s === 'decided' || s === 'void'

/** K5 / C2: doop asks Multica itself (B1) and releases only on `decided` or `void`. The frames stay locked. */
export function releasePin(cardRequestId: string): Promise<{ ok: true; pin: Pin; already?: true } | Fail> {
  return releaseLane(async () => {
    const pin = getPin(cardRequestId)
    if (!pin) return { ok: false, error: 'no_pin' }
    if (pin.state === 'RELEASED') return { ok: true, pin, already: true }
    let status: MulticaStatus
    try {
      if (!multica) throw new Error('no multica port')
      status = await multica.refStatus(cardRequestId)
    } catch {
      return { ok: false, error: 'multica_unreachable' }
    }
    if (!final(status)) return { ok: false, error: 'not_final', status }
    return releaseNow(cardRequestId, status, false)
  })
}

/** F1: a lock owner's way out of a pin. A1 (abort_ref) goes first; the pin is released only on the final answer it
 *  gives. On `void` the frames' epoch goes up (a lock decision made on the voided card can never be replayed); on
 *  `decided` it does not (the chosen version keeps its epoch). */
export function forceRelease(input: {
  cardRequestId: string
  reason: string
  userId?: string
}): Promise<{ ok: true; pin: Pin } | Fail> {
  const { cardRequestId, reason, userId } = input
  if (!isLockOwner(userId)) return Promise.resolve({ ok: false, error: 'forbidden' })
  return releaseLane(async (): Promise<{ ok: true; pin: Pin } | Fail> => {
    const pin = getPin(cardRequestId)
    if (!pin) return { ok: false, error: 'no_pin' }
    if (pin.state === 'RELEASED') return { ok: true, pin }
    let status: MulticaStatus
    try {
      if (!multica) throw new Error('no multica port')
      status = await multica.abortRef(cardRequestId, reason)
    } catch {
      return { ok: false, error: 'multica_unreachable' }
    }
    if (!final(status)) return { ok: false, error: 'not_final', status }
    const out = await releaseNow(cardRequestId, reason, status === 'void')
    return out.ok ? { ok: true, pin: out.pin } : out
  })
}
