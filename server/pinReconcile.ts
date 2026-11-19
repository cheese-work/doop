/** Pin reconcile (CHE-7063, G5c of CHE-6078; spec che-6078-g5-lock-pin-r1 section 5). STUB: red phase. */
import type { MulticaStatus } from './framePins.ts'
import type { PinState } from './pinState.ts'

export const T_RECONCILE_MS = 120_000
export type ReconcileOutcome = {
  cardRequestId: string
  state: PinState
  action: 'young' | 'none' | 'released' | 'waiting' | 'unreachable'
  /** A2 changed the card: it was `pending` (or missing) and is now `void` */
  aborted?: boolean
  status?: MulticaStatus
}
export type StuckPin = { cardRequestId: string; state: PinState; ageMs: number }
export const reconcileHooks: { afterRead?: (cardRequestId: string, status: MulticaStatus) => Promise<void> | void } = {}
export function reconcilePins(_options?: { now?: number }): Promise<ReconcileOutcome[]> {
  return Promise.resolve([])
}
export const stuckPins = (): StuckPin[] => []
