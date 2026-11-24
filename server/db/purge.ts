import { and, eq, sql } from 'drizzle-orm'
import { db } from './index.ts'
import { assetRefs, comments, frames, frameVersions, frameWriteKeys } from './schema.ts'

/**
 * "Delete forever" for one trashed frame (CHE-9399 step 3). This file holds the only code that removes a frame's
 * rows: one bounded transaction, and a probe that answers what happened to it when the COMMIT reply is lost.
 * Nothing calls it yet; the route and the realtime fan-out come in later steps.
 *
 * Kept on purpose: comments and their events, page snapshots and blobs, activity, decisions, memory references,
 * automation approvals, tasks and components. A frame with a comment is refused, not purged.
 */

export type PurgeReceipt = {
  frameId: string
  canvasId: string
  deletedAt: number
  versionIds: string[]
  writeKeyIds: string[]
  assetRefIds: string[]
}

export type PurgeRefusal = 'conflict' | 'access_lost' | 'has_comments'

export type PurgeResult =
  | { outcome: 'committed'; receipt: PurgeReceipt }
  | { outcome: 'refused'; reason: PurgeRefusal }
  /** nothing says whether COMMIT landed; `receipt` is set once the transaction had asked for it */
  | { outcome: 'unknown'; receipt?: PurgeReceipt; error: unknown }

export type PurgeArgs = {
  frameId: string
  canvasId: string
  /** the `deleted_at` the caller read from the Trash; a different value means the frame changed since */
  deletedAt: number
  /** Called inside the transaction, after the deletes and before COMMIT, so the caller's last check (the
   *  caller may still purge; its in-memory comment state) is ordered with the commit. `false` refuses as
   *  `access_lost`, `'has_comments'` as `has_comments`; the transaction rolls back. */
  stillMayPurge: () => boolean | 'has_comments'
  /** Called with the receipt right before COMMIT is sent, so a caller that loses the reply still knows what the
   *  purge removed. Must not throw: a throw here rolls the purge back and answers `unknown`. */
  onCommitRequested: (receipt: PurgeReceipt) => void
}

/** Thrown inside the transaction, before COMMIT, to roll back with a known reason. */
class Refusal extends Error {
  constructor(readonly reason: PurgeRefusal) {
    super(`purge refused: ${reason}`)
  }
}

/** The caller's limits for one purge, set per transaction so they never outlive it. */
const LIMITS = ['statement_timeout = 10000', 'lock_timeout = 5000', 'idle_in_transaction_session_timeout = 30000']

export async function purgeTrashedFrame(args: PurgeArgs): Promise<PurgeResult> {
  const { frameId, canvasId, deletedAt } = args
  let receipt: PurgeReceipt | undefined
  let refusal: PurgeRefusal | undefined
  try {
    await db.transaction(async (tx) => {
      for (const limit of LIMITS) await tx.execute(sql.raw(`set local ${limit}`))
      /* SHARE conflicts with the ROW EXCLUSIVE of a comment insert: this waits for comment writes that are
         still open and holds new ones back until we end, so "no comment for this frame" stays true */
      await tx.execute(sql`lock table comments in share mode`)

      const [row] = await tx
        .select({ deletedAt: frames.deletedAt })
        .from(frames)
        .where(and(eq(frames.id, frameId), eq(frames.canvasId, canvasId)))
        .for('update')
      if (!row || row.deletedAt !== deletedAt) throw new Refusal('conflict')

      const [comment] = await tx
        .select({ id: comments.id })
        .from(comments)
        .where(eq(comments.frameId, frameId))
        .limit(1)
      if (comment) throw new Refusal('has_comments')

      const writeKeys = await tx
        .delete(frameWriteKeys)
        .where(eq(frameWriteKeys.frameId, frameId))
        .returning({ key: frameWriteKeys.key })
      const refs = await tx.delete(assetRefs).where(eq(assetRefs.frameId, frameId)).returning({ id: assetRefs.assetId })
      const versions = await tx
        .delete(frameVersions)
        .where(eq(frameVersions.frameId, frameId))
        .returning({ id: frameVersions.id })
      await tx.delete(frames).where(and(eq(frames.id, frameId), eq(frames.canvasId, canvasId)))

      const verdict = args.stillMayPurge()
      if (verdict === false) throw new Refusal('access_lost')
      if (verdict === 'has_comments') throw new Refusal('has_comments')

      receipt = {
        frameId,
        canvasId,
        deletedAt,
        versionIds: versions.map((v) => v.id),
        writeKeyIds: writeKeys.map((k) => k.key),
        assetRefIds: refs.map((r) => r.id),
      }
      args.onCommitRequested(receipt)
    })
    return { outcome: 'committed', receipt: receipt! }
  } catch (error) {
    if (error instanceof Refusal) refusal = error.reason
    /* a refusal was decided before COMMIT: even if the rollback then failed and replaced the error, the
       session ended without a commit, so the refusal still stands */
    if (refusal && !receipt) return { outcome: 'refused', reason: refusal }
    return { outcome: 'unknown', ...(receipt ? { receipt } : {}), error }
  }
}

export type ProbeOptions = {
  /** how long one attempt waits on the frame row before it tries again (default 5000) */
  lockTimeoutMs?: number
  /** pauses before the next attempts after a failed one (default 100, 250, 500, 1000) */
  delaysMs?: number[]
  /** the pause after those are used up (default 2000) */
  repeatMs?: number
}

/**
 * Says what a purge whose acknowledgement was lost did to a frame: `committed` (the row is gone) or `rolled_back`
 * (it is still there). `SELECT … FOR UPDATE` on the frame row waits for a purge transaction that is still open, so
 * the answer is only read after it ended. A failed attempt (lock timeout, lost connection) is tried again; the
 * probe never answers "unknown".
 */
export async function resolvePurgeOutcome(
  frameId: string,
  opts: ProbeOptions = {},
): Promise<'committed' | 'rolled_back'> {
  const lockTimeoutMs = Math.max(1, Math.trunc(opts.lockTimeoutMs ?? 5000))
  const delays = opts.delaysMs ?? [100, 250, 500, 1000]
  const repeatMs = opts.repeatMs ?? 2000
  for (let attempt = 0; ; attempt++) {
    try {
      return await db.transaction(async (tx) => {
        await tx.execute(sql.raw(`set local lock_timeout = ${lockTimeoutMs}`))
        const rows = await tx.select({ id: frames.id }).from(frames).where(eq(frames.id, frameId)).for('update')
        return rows.length === 0 ? 'committed' : 'rolled_back'
      })
    } catch {
      await new Promise((resolve) => setTimeout(resolve, delays[attempt] ?? repeatMs))
    }
  }
}
