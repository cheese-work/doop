import type { Frame } from '../shared/types.ts'

/** A refused write. A separate type: the store's `undefined` means "not found". */
export class PolicyRefused extends Error {
  constructor(
    readonly op: string,
    readonly reason: string,
    /** `policy_refused` unless a subclass names its own refusal (`page_finished`) */
    readonly code: string = 'policy_refused',
  ) {
    super(`${code}: ${op}: ${reason}`)
  }
}

/** A write to a locked frame (CHE-6626): every op from every actor is refused until an owner unlocks it.
 *  A `PolicyRefused`, so the REST (423) and MCP paths that already handle one handle this too. */
export class FrameLockedError extends PolicyRefused {
  override readonly name = 'FrameLockedError'
  /** the wire code of a locked frame (S1); the message keeps the `policy_refused:` text it always had */
  override readonly code = 'frame_locked'
  readonly frameId: string
  readonly frameName: string
  readonly canvasId: string | undefined
  /** who locked it, when (ms) and why; null for a lock made before S1 recorded them */
  readonly lockedBy: string | null
  readonly lockedAt: number | null
  readonly lockReason: string | null
  constructor(
    frame: Pick<Frame, 'id' | 'name'> & Partial<Pick<Frame, 'canvasId' | 'lockedBy' | 'lockedAt' | 'lockReason'>>,
    op = 'update_frame',
    reason = `frame "${frame.name}" (${frame.id}) is locked; only a lock owner can unlock it`,
  ) {
    super(op, reason)
    this.frameId = frame.id
    this.frameName = frame.name
    this.canvasId = frame.canvasId
    this.lockedBy = frame.lockedBy ?? null
    this.lockedAt = frame.lockedAt ?? null
    this.lockReason = frame.lockReason ?? null
  }
}
