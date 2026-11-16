import type { Actor, Canvas, CanvasPageInfo, Frame } from '../shared/types.ts'

/**
 * Who is writing, and what Multica has vouched for. Every store mutator takes
 * one as its first parameter (no default), so a caller that forgets it fails
 * `typecheck`. `projectId`/`issueId`/`agentId` come only from a verified task
 * (see `verifyTask`), never from anything the client sent.
 */
export type WriteContext = {
  kind: 'user' | 'agent' | 'system'
  userId?: string
  /** the X-Multica-Task-Id the client CLAIMED; trusted only when `verified` */
  taskId?: string
  agentId?: string
  issueId?: string
  projectId?: string
  sessionId?: string
  /** Multica confirmed `taskId` is a live task, and the three ids above are its */
  verified?: boolean
}

export type WriteOp =
  'create_frame' | 'update_frame' | 'delete_frame' | 'delete_canvas' | 'set_pages' | 'copy_page' | 'bind_project'

export type WriteTarget = {
  canvas: Canvas
  frame?: Frame
  /** the page the write lands on (frame page, destination page, source page) */
  pageIds?: string[]
  /** set_pages: the list being saved */
  nextPages?: CanvasPageInfo[]
}

/** A refused write. A separate type: the store's `undefined` means "not found". */
export class PolicyRefused extends Error {
  readonly code = 'policy_refused'
  constructor(
    readonly op: string,
    readonly reason: string,
  ) {
    super(`policy_refused: ${op}: ${reason}`)
  }
}

export const systemContext = (): WriteContext => ({ kind: 'system' })
export const userContext = (userId?: string): WriteContext => ({ kind: 'user', userId })

export function writeContextFor(actor: Actor): WriteContext {
  if (actor.kind === 'user') return { kind: 'user' }
  return { kind: 'agent', taskId: actor.multicaTaskId }
}

export function assertWritable(_ctx: WriteContext, _op: WriteOp, _target: WriteTarget): void {}

export type TaskIdentity = { running: boolean; agentId?: string; issueId?: string; projectId?: string }
export function setTaskIdentityVerifier(
  _verify: ((taskId: string) => Promise<TaskIdentity | undefined>) | undefined,
): void {}
export async function warmTaskIdentity(_taskId: string): Promise<void> {}
