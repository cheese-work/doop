/** In-memory half of the lock pins (CHE-7062, G5b). Kept apart from framePins.ts so the store can ask
 *  "is this frame pinned?" without importing the store back. The database (`frame_pins`) is the truth;
 *  this is its mirror, reloaded at boot. */

export type PinState = 'RESERVED' | 'HELD' | 'SEALED' | 'RELEASED'
export type PinFrame = { frameId: string; updatedAt: number; attestationId: string; epoch: number }
export type Pin = {
  cardRequestId: string
  pinId: string
  state: PinState
  frames: PinFrame[]
  pickRequestId?: string
  pickedFrameId?: string
  r1?: string
  r2?: string
  releaseReason?: string
  stateChangedAt: number
  createdAt: number
}

const pins = new Map<string, Pin>()
const byFrame = new Map<string, string>() // frameId -> cardRequestId of its active pin

export const getPin = (cardRequestId: string): Pin | undefined => pins.get(cardRequestId)
export const pinOf = (frameId: string): Pin | undefined => {
  const card = byFrame.get(frameId)
  return card ? pins.get(card) : undefined
}
export const isPinned = (frameId: string): boolean => byFrame.has(frameId)

/** Mirror one row. A RELEASED pin stays (a retry of the release answers from it) but covers no frame. */
export function setPin(pin: Pin): void {
  pins.set(pin.cardRequestId, pin)
  for (const f of pin.frames) {
    if (pin.state === 'RELEASED') {
      if (byFrame.get(f.frameId) === pin.cardRequestId) byFrame.delete(f.frameId)
    } else byFrame.set(f.frameId, pin.cardRequestId)
  }
}

export function dropPin(cardRequestId: string): void {
  const pin = pins.get(cardRequestId)
  if (!pin) return
  for (const f of pin.frames) if (byFrame.get(f.frameId) === cardRequestId) byFrame.delete(f.frameId)
  pins.delete(cardRequestId)
}

export function replacePins(all: Pin[]): void {
  pins.clear()
  byFrame.clear()
  for (const pin of all) setPin(pin)
}

export const allPins = (): Pin[] => [...pins.values()]

/** One async queue for every pin, lock and unlock write: they are rare, and a single lane is the per-frame mutex of
 *  the spec at its simplest. A failed job does not stall the next. */
let tail: Promise<unknown> = Promise.resolve()
export function exclusive<T>(job: () => Promise<T>): Promise<T> {
  const run = tail.then(job, job)
  tail = run.catch(() => undefined)
  return run
}

/** Test seam: called before every durable write of a pin, a lock or an unlock. A hook may pause the write or
 *  throw to stand in for a failed database write. */
export const pinHooks: {
  beforeWrite?: (op: 'reserve' | 'confirm' | 'pick' | 'release' | 'unlock' | 'lock') => Promise<void> | void
} = {}
