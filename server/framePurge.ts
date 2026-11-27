import { finishCommitted } from './actions.ts'
import * as persist from './db/persist.ts'
import { purgeTrashedFrame, resolvePurgeOutcome, type ProbeOptions, type PurgeReceipt } from './db/purge.ts'
import type { Actor } from '../shared/types.ts'
import type { PurgeLease } from './store.ts'

/**
 * Steps 8 to 10 of "delete forever" (CHE-9399 step 4): once the route holds a lease on a Trash frame, settle the
 * frame's writers, run the purge transaction and end the lease on a KNOWN outcome only. This file is the only
 * caller of `purgeTrashedFrame` and `resolvePurgeOutcome`; no MCP tool or resident path reaches it.
 *
 * The route's request is a write boundary that undoes the lease when the handler throws, so nothing here throws:
 * every path returns a reply. An outcome that is not known keeps the lease (the frame stays held in the Trash) and
 * a probe, owned by the lease, ends it later.
 */

/** Knobs a test turns down; the defaults are the plan's (30 s settle, 10 s wait for the probe). */
export const purgeTiming: { settleTimeoutMs: number; outcomeWaitMs: number; probe: ProbeOptions } = {
  settleTimeoutMs: 30_000,
  outcomeWaitMs: 10_000,
  probe: {},
}

export type PurgeReply = { status: 200 | 403 | 409 | 500 | 503; body: Record<string, unknown> }

export type PurgeRun = {
  lease: PurgeLease
  /** the `deletedAt` the caller confirmed */
  deletedAt: number
  /** the frame's current `deletedAt` in the Trash, for a stale answer */
  currentDeletedAt: () => number | undefined
  /** called inside the transaction right before COMMIT: may this caller still purge, and is the frame still free of comments */
  stillMayPurge: () => boolean | 'has_comments'
  /** credited with the activity line when the purge is finished */
  actor: Actor
}

type NoReceipt = PurgeReceipt & { noReceipt: true }

export async function runFramePurge(run: PurgeRun): Promise<PurgeReply> {
  const { lease, deletedAt, actor } = run
  try {
    await persist.settleFrameWrites(lease.frameId, { timeoutMs: purgeTiming.settleTimeoutMs })
  } catch (error) {
    lease.release()
    if (error instanceof persist.SettleTimeout) {
      return {
        status: 503,
        body: { error: 'frame writes are still in flight; nothing was deleted', code: 'purge_timeout' },
      }
    }
    console.error('[purge] settle failed', lease.frameId, error)
    return { status: 500, body: { error: 'purge failed; nothing was deleted' } }
  }

  let result: Awaited<ReturnType<typeof purgeTrashedFrame>>
  try {
    result = await purgeTrashedFrame({
      frameId: lease.frameId,
      canvasId: lease.canvasId,
      deletedAt,
      stillMayPurge: run.stillMayPurge,
      onCommitRequested: (receipt) => {
        lease.receipt = receipt
      },
    })
  } catch (error) {
    result = { outcome: 'unknown', error }
  }

  if (result.outcome === 'committed') {
    finishCommitted(lease, result.receipt, actor)
    return { status: 200, body: { ok: true } }
  }
  if (result.outcome === 'refused') {
    lease.release()
    if (result.reason === 'access_lost')
      return {
        status: 403,
        body: { error: 'you can no longer edit this canvas; nothing was deleted', code: 'access_lost' },
      }
    if (result.reason === 'has_comments')
      return { status: 409, body: { error: 'the frame has comments; nothing was deleted', code: 'has_comments' } }
    return {
      status: 409,
      body: {
        error: 'the frame changed; nothing was deleted',
        code: 'stale_confirmation',
        deletedAt: run.currentDeletedAt(),
      },
    }
  }
  return resolveUnknown(run, result.error)
}

/** The COMMIT reply is lost: keep the lease and ask the database what happened. */
async function resolveUnknown(run: PurgeRun, error: unknown): Promise<PurgeReply> {
  const { lease, deletedAt, actor } = run
  console.error('[purge] outcome unknown, probing', lease.frameId, error)
  const probe = resolvePurgeOutcome(lease.frameId, purgeTiming.probe).then(
    (answer) => {
      try {
        if (answer === 'committed') {
          console.error('[purge] ALARM: the acknowledgement was lost but the purge committed', lease.frameId)
          const receipt: PurgeReceipt | NoReceipt = lease.receipt ?? {
            frameId: lease.frameId,
            canvasId: lease.canvasId,
            deletedAt,
            versionIds: [],
            writeKeyIds: [],
            assetRefIds: [],
            noReceipt: true,
          }
          finishCommitted(lease, receipt, actor)
        } else {
          lease.release()
        }
      } catch (finishError) {
        console.error('[purge] could not end the lease after the probe', lease.frameId, finishError)
      }
      return answer
    },
    (probeError) => {
      /* the probe never rejects (it retries); keep the lease if it somehow does */
      console.error('[purge] probe failed', lease.frameId, probeError)
      return 'unknown' as const
    },
  )
  let timer: NodeJS.Timeout | undefined
  const waited = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), purgeTiming.outcomeWaitMs)
  })
  const answer = await Promise.race([probe, waited])
  clearTimeout(timer)
  if (answer === 'committed') return { status: 200, body: { ok: true } }
  if (answer === 'rolled_back')
    return {
      status: 409,
      body: { error: 'the purge did not happen; the frame is still in the Trash', code: 'purge_not_applied' },
    }
  return {
    status: 503,
    body: {
      error: 'the purge is still being confirmed; the frame stays in the Trash until it is',
      code: 'purge_outcome_unknown',
    },
  }
}
