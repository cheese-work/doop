/** Lock pins (CHE-7062, G5b): STUB, behaviour lands in the next commit. */
import type { Pin, PinFrame } from './pinState.ts'

export type MulticaStatus = 'pending' | 'open' | 'pick_pending' | 'decided' | 'void' | 'missing'
export interface MulticaPort {
  refStatus(cardRequestId: string): Promise<MulticaStatus>
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
const notYet = async (): Promise<Fail> => ({ ok: false, error: 'not_implemented' })

export function configurePins(_: { secret?: string; multica?: MulticaPort }): void {}
export async function loadPins(): Promise<void> {}
export const reserveLock = (_: {
  cardRequestId: string
  frames: PinFrame[]
}): Promise<{ ok: true; pin: Pin; already?: true } | Fail> => notYet()
export const confirmPin = (_: string): Promise<{ ok: true; pin: Pin; receipt: Receipt } | Fail> => notYet()
export const pinForPick = (_: {
  cardRequestId: string
  pickRequestId: string
  pickedFrameId: string
  versions?: { frameId: string; updatedAt: number; epoch: number }[]
}): Promise<{ ok: true; pin: Pin; receipt: Receipt } | Fail> => notYet()
export const releasePin = (_: string): Promise<{ ok: true; pin: Pin; already?: true } | Fail> => notYet()
export const forceRelease = (_: {
  cardRequestId: string
  reason: string
  userId?: string
}): Promise<{ ok: true; pin: Pin } | Fail> => notYet()
export const verifyReceipt = (_secret: string, _receipt: Receipt): boolean => true
