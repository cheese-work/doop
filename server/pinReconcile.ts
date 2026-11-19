/** Pin reconcile (CHE-7063, G5c of CHE-6078; spec che-6078-g5-lock-pin-r1 section 5).
 *
 *  The clock only lets doop ASK. After `T_RECONCILE_MS` without a state change a pin that is not RELEASED is checked
 *  against Multica, and nothing here ever releases on time alone (B4): a pin goes only on Multica's own final answer
 *  (B1). The one abort reconcile may make is A2 `abortIfPending`, a conditional CAS: a card a slow publisher has
 *  already opened is left exactly as it is, and so is its pin. */
import { getMulticaPort, releasePin, type MulticaStatus } from './framePins.ts'
import { allPins, type Pin, type PinState } from './pinState.ts'

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

/** Test seam: runs between the `ref_status` read and the A2 call, where a slow publisher can still open the card. */
export const reconcileHooks: { afterRead?: (cardRequestId: string, status: MulticaStatus) => Promise<void> | void } = {}

const stuck = new Map<string, StuckPin>()
/** The "ghim treo" list: pins Multica could not be asked about, with their age. Not a timeout; it never releases. */
export const stuckPins = (): StuckPin[] => [...stuck.values()]

const final = (s: MulticaStatus): boolean => s === 'decided' || s === 'void'

async function reconcileOne(pin: Pin, ageMs: number): Promise<ReconcileOutcome> {
  const { cardRequestId, state } = pin
  const unreachable = (): ReconcileOutcome => {
    stuck.set(cardRequestId, { cardRequestId, state, ageMs })
    return { cardRequestId, state, action: 'unreachable' }
  }
  const port = getMulticaPort()
  if (!port) return unreachable()
  let status: MulticaStatus
  try {
    status = await port.refStatus(cardRequestId)
    await reconcileHooks.afterRead?.(cardRequestId, status)
  } catch {
    return unreachable()
  }
  let aborted = false
  /* a card Multica has no row for, or still holds `pending`: the publisher may be dead. A2 closes it only if it is
     still `pending` at the instant of the CAS. */
  if (status === 'pending' || status === 'missing') {
    try {
      const out = await port.abortIfPending(cardRequestId)
      status = out.status
      aborted = !out.notAborted
    } catch {
      return unreachable()
    }
  }
  if (final(status)) {
    const out = await releasePin(cardRequestId) // asks Multica again (B1), so a stale answer here cannot release
    if (out.ok) {
      stuck.delete(cardRequestId)
      return { cardRequestId, state, action: 'released', status, aborted }
    }
    return out.error === 'multica_unreachable' || out.error === 'persist_failed'
      ? unreachable()
      : { cardRequestId, state, action: 'waiting', status }
  }
  stuck.delete(cardRequestId)
  /* `open` and `pick_pending` are a live card. A `pick_pending` card on a SEALED pin is finished by Multica's own
     `pick_driver`, which asks doop for R2 again; doop does not release it. */
  return { cardRequestId, state, action: 'none', status, aborted }
}

let running: Promise<ReconcileOutcome[]> | undefined

/** One pass over every pin that is not RELEASED. `now` is a test seam (the fake clock). Passes never overlap. */
export function reconcilePins(options: { now?: number } = {}): Promise<ReconcileOutcome[]> {
  const run = async (): Promise<ReconcileOutcome[]> => {
    const now = options.now ?? Date.now()
    const out: ReconcileOutcome[] = []
    const live = new Set<string>()
    for (const pin of allPins()) {
      if (pin.state === 'RELEASED') continue
      live.add(pin.cardRequestId)
      const ageMs = now - pin.stateChangedAt
      if (ageMs < T_RECONCILE_MS) {
        out.push({ cardRequestId: pin.cardRequestId, state: pin.state, action: 'young' })
        continue
      }
      out.push(await reconcileOne(pin, ageMs))
    }
    for (const id of stuck.keys()) if (!live.has(id)) stuck.delete(id)
    for (const p of stuck.values())
      console.warn(
        `[pin_reconcile] stuck pin ${p.cardRequestId} (${p.state}), Multica silent for ${Math.round(p.ageMs / 1000)}s`,
      )
    return out
  }
  const next = (running ?? Promise.resolve([])).then(run, run)
  running = next.catch(() => [])
  return next
}

/** The periodic job. Returns a stop function. The interval is not a pin timeout: it only decides how often doop asks. */
export function startPinReconcile(intervalMs = 30_000): () => void {
  const timer = setInterval(
    () => void reconcilePins().catch((e) => console.warn('[pin_reconcile] pass failed', e)),
    intervalMs,
  )
  timer.unref()
  return () => clearInterval(timer)
}
