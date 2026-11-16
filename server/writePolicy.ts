import { canvasPages } from '../shared/pages.ts'
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

/** What Multica says about a task (run): live or not, which agent, issue and project. */
export type TaskIdentity = { running: boolean; agentId?: string; issueId?: string; projectId?: string }
export type TaskIdentityVerifier = (taskId: string) => Promise<TaskIdentity | undefined>

/** How long one Multica answer is believed. Short: a task that ended stops writing soon after. */
export const TASK_IDENTITY_TTL_MS = 5 * 60_000

let verifier: TaskIdentityVerifier | undefined
const verified = new Map<string, { at: number; identity: TaskIdentity }>()

/** Plug in the Multica lookup (task -> agent, issue, project). None plugged in =
 *  no task can be verified = every Multica-run agent write is refused (fail closed). */
export function setTaskIdentityVerifier(next: TaskIdentityVerifier | undefined): void {
  verifier = next
  verified.clear()
}

/** Ask Multica about a task id the client sent, before the request's writes run.
 *  The store is synchronous, so the answer waits in a cache that writeContextFor reads.
 *  Any failure (no verifier, Multica down, unknown task) leaves the task unverified. */
export async function warmTaskIdentity(taskId: string): Promise<void> {
  const hit = verified.get(taskId)
  if (hit && Date.now() - hit.at < TASK_IDENTITY_TTL_MS) return
  verified.delete(taskId)
  if (!verifier) return
  try {
    const identity = await verifier(taskId)
    if (identity) verified.set(taskId, { at: Date.now(), identity })
  } catch {
    /* unverified */
  }
}

/** The write context for an actor. Only a task Multica vouched for, and still running, yields
 *  `verified` and the ids; the id the client sent is never trusted on its own. */
export function writeContextFor(actor: Actor): WriteContext {
  if (actor.kind !== 'agent') return { kind: 'user' }
  const taskId = actor.multicaTaskId
  if (!taskId) return { kind: 'agent' }
  const hit = verified.get(taskId)
  if (!hit || Date.now() - hit.at >= TASK_IDENTITY_TTL_MS || !hit.identity.running) return { kind: 'agent', taskId }
  const { agentId, issueId, projectId } = hit.identity
  return { kind: 'agent', taskId, agentId, issueId, projectId, verified: true }
}

const OPS: ReadonlySet<string> = new Set<WriteOp>([
  'create_frame',
  'update_frame',
  'delete_frame',
  'delete_canvas',
  'set_pages',
  'copy_page',
  'bind_project',
])

/**
 * Throws PolicyRefused unless `ctx` may do `op` on `target`. Runs inside the store mutator, in the
 * same synchronous tick as the change. Users and the system pass (G5 and its lock rules are a
 * separate issue); an agent is held to the project binding:
 *  - an agent with a Multica task must be verified, and write only to the canvas bound to its
 *    project, on pages bound to its issue;
 *  - an agent with no task is a non-Multica agent: it may write to canvases nobody bound, never to a bound one;
 *  - no agent binds, unbinds or deletes a canvas.
 */
export function assertWritable(ctx: WriteContext, op: WriteOp, target: WriteTarget): void {
  if (ctx.kind !== 'agent') return
  const { canvas } = target
  if (!OPS.has(op)) throw new PolicyRefused(op, 'unknown operation')
  if (op === 'bind_project') throw new PolicyRefused(op, 'an agent cannot bind a canvas to a project')
  if (op === 'delete_canvas') throw new PolicyRefused(op, 'an agent cannot delete a canvas')
  if (!ctx.taskId) {
    if (canvas.projectId) throw new PolicyRefused(op, 'canvas is bound to a project and the agent has no Multica task')
    return
  }
  if (!ctx.verified || !ctx.projectId || !ctx.issueId)
    throw new PolicyRefused(op, 'Multica did not confirm this task (unknown, ended, or unreachable)')
  if (canvas.projectId !== ctx.projectId) throw new PolicyRefused(op, 'canvas is not bound to the task project')
  const pages = canvasPages(canvas)
  for (const pageId of target.pageIds ?? []) {
    const page = pages.find((candidate) => candidate.id === pageId)
    if (page?.issueId !== ctx.issueId) throw new PolicyRefused(op, 'page is not bound to the task issue')
  }
  if (op === 'set_pages') {
    for (const page of pages) {
      if (page.issueId === ctx.issueId) continue
      const next = target.nextPages?.find((candidate) => candidate.id === page.id)
      if (next?.name !== page.name) throw new PolicyRefused(op, 'page belongs to another issue')
    }
  }
}
