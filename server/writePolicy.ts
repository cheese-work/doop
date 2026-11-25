import { canvasPages, framePageId } from '../shared/pages.ts'
import { checkReconGate, isReconHtml, reconRefusal } from './reconGuard.ts'
import { isLandingProof, type LandingProof } from './landingProof.ts'
import { assertPageRules } from './pageState.ts'
import { FrameLockedError, PolicyRefused } from './policyRefused.ts'
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
  /** an MCP client with a user key, or a design-sync key: not a task run, not the server itself */
  origin?: 'mcp' | 'sync'
  /** account erasure only (`erasureContext`): may delete a canvas that still holds a locked frame */
  erasure?: boolean
  /** `land_proposal` only: the proof `verifyLanding` made. A server-side value, never parsed from input. */
  landing?: LandingProof
}

export type WriteOp =
  | 'create_frame'
  | 'update_frame'
  | 'delete_frame'
  | 'delete_canvas'
  | 'set_pages'
  | 'copy_page'
  | 'bind_project'
  | 'lock_frame'
  | 'unlock_frame'
  | 'set_page_state'
  | 'land_proposal'

export type WriteTarget = {
  canvas: Canvas
  frame?: Frame
  /** the page the write lands on (frame page, destination page, source page) */
  pageIds?: string[]
  /** land_proposal: the page the proposal comes from (its Finished state is not checked; `pageIds` is the destination) */
  sourcePageId?: string
  /** set_pages: the list being saved */
  nextPages?: CanvasPageInfo[]
  /** create_frame: the HTML the new frame starts with (the recon frame itself is exempt from G2) */
  html?: string
  /** update_frame: the patch is nothing but `locked: true` on an unlocked frame (the one write a Finished page allows) */
  lockOnly?: boolean
}

export { FrameLockedError, PolicyRefused }

let lockOwners: ReadonlySet<string> = new Set()
/** Who may unlock a frame (Cheese). Empty or unset = nobody: unlock fails closed. */
export function setLockOwners(ids: readonly string[] | undefined): void {
  lockOwners = new Set(ids ?? [])
}

export const isLockOwner = (userId: string | undefined): boolean => !!userId && lockOwners.has(userId)

/** Account erasure: the one caller allowed to delete a canvas that still holds a locked frame. */
export const erasureContext = (): WriteContext => ({ kind: 'system', erasure: true })

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
export function writeContextFor(actor: Actor, userId?: string): WriteContext {
  /* a sync key is a snippet on a foreign origin, not a person: it is held to the canvas binding like an agent */
  if (actor.origin === 'sync') return { kind: 'agent', origin: 'sync' }
  /* `userId` is the signed-in account id, passed only by a session route; a display name proves nothing */
  if (actor.kind !== 'agent') return userId ? { kind: 'user', userId } : { kind: 'user' }
  const taskId = actor.multicaTaskId
  if (!taskId) return actor.origin === 'mcp' ? { kind: 'agent', origin: 'mcp' } : { kind: 'agent' }
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
  'lock_frame',
  'unlock_frame',
  'set_page_state',
  'land_proposal',
])

function assertLockRules(ctx: WriteContext, op: WriteOp, target: WriteTarget): void {
  const { canvas, frame } = target
  if (op === 'unlock_frame') {
    if (ctx.kind !== 'user' || !ctx.userId || !lockOwners.has(ctx.userId))
      throw new PolicyRefused(op, 'only a lock owner, signed in, may unlock a frame')
    return
  }
  if (op === 'lock_frame') return /* narrows access: any writer allowed past here may lock */
  if (frame?.locked) throw new FrameLockedError(frame, op, `frame ${frame.id} is locked`)
  if (op === 'delete_canvas' && !ctx.erasure && canvas.frames.some((f) => f.locked))
    throw new PolicyRefused(op, 'canvas holds a locked frame')
  if (op === 'set_pages' && target.nextPages) {
    const kept = new Set(target.nextPages.map((page) => page.id))
    const lockedOn = new Set(canvas.frames.filter((f) => f.locked).map((f) => framePageId(canvas, f)))
    for (const pageId of lockedOn)
      if (!kept.has(pageId)) throw new PolicyRefused(op, `page ${pageId} holds a locked frame`)
  }
}

/**
 * Throws PolicyRefused unless `ctx` may do `op` on `target`. Runs inside the store mutator, in the
 * same synchronous tick as the change.
 *
 * Frame lock (CHE-6626): a `locked` frame refuses every write from every actor, system included
 * (a lock the server's own code can bypass is a flag). Exceptions: `unlock_frame` by a user session
 * whose account id is in `setLockOwners`; account erasure (`erasureContext`) deleting the canvas.
 * A canvas holding a locked frame cannot be deleted, and `set_pages` cannot drop its page.
 * Next the page rules (`assertPageRules`): a Finished page refuses every frame write from every actor,
 * except a lock-only patch. Past those, users and the system pass; an agent is held to the project binding:
 *  - an agent with a Multica task must be verified, and write only to the canvas bound to its
 *    project, on pages bound to its issue;
 *  - an agent with no task may write to canvases nobody bound, never to a bound one; once a Multica
 *    verifier is plugged in, an MCP agent without a task is refused everywhere (omitting the header is no bypass);
 *  - no agent binds, unbinds or deletes a canvas.
 */
export function assertWritable(ctx: WriteContext, op: WriteOp, target: WriteTarget): void {
  if (!OPS.has(op)) throw new PolicyRefused(op, 'unknown operation')
  assertLockRules(ctx, op, target)
  assertPageRules(op, target)
  if (op === 'land_proposal') return assertLanding(ctx, target)
  if (ctx.kind !== 'agent') return
  assertBinding(ctx, op, target)
  if (op === 'create_frame') assertRecon(ctx, target)
}

/**
 * A landing (CHE-9672): the one write a taskless agent may make on a bound canvas, and only with a
 * `LandingProof` from `verifyLanding`. The proof, not the actor, is the authority, so every kind of context
 * needs it and `assertBinding` is not asked. It must be for this canvas and project, the source page must be
 * the proof's topic (bound to its issue when bound at all), and the destination is the ledger page alone.
 */
function assertLanding(ctx: WriteContext, target: WriteTarget): void {
  const op = 'land_proposal'
  const proof = ctx.landing
  if (!isLandingProof(proof)) throw new PolicyRefused(op, 'a landing needs a proof from verifyLanding')
  const { canvas } = target
  if (!canvas.projectId || canvas.projectId !== proof.projectId)
    throw new PolicyRefused(op, 'canvas is not bound to the proof project')
  if (canvas.id !== proof.canvasId) throw new PolicyRefused(op, 'the proof is for another canvas')
  const pages = canvasPages(canvas)
  const source = pages.find((page) => page.id === target.sourcePageId)
  if (!source || source.id !== proof.sourcePageId || source.name !== proof.sourcePageName)
    throw new PolicyRefused(op, 'source page is not the proof topic')
  if (source.issueId && source.issueId !== proof.issueId)
    throw new PolicyRefused(op, 'source page is bound to another issue')
  const ledger = pages.find((page) => page.ledger)
  if (!ledger || target.pageIds?.length !== 1 || target.pageIds[0] !== ledger.id)
    throw new PolicyRefused(op, 'a landing goes to the ledger page only')
}

/**
 * G2: a design frame on a page bound to an issue waits for a complete, confirmed, locked recon. The
 * recon frame is exempt, so it can be made first. Fail closed: a throw anywhere inside is a refusal.
 */
function assertRecon(ctx: WriteContext, target: WriteTarget): void {
  if (target.html !== undefined && isReconHtml(target.html)) return
  for (const pageId of target.pageIds ?? []) {
    if (!canvasPages(target.canvas).find((page) => page.id === pageId)?.issueId) continue
    let reasons: string[]
    try {
      reasons = checkReconGate(target.canvas, pageId, ctx, Date.now())
    } catch {
      reasons = ['the recon check failed']
    }
    if (reasons.length) throw new PolicyRefused('create_frame', reconRefusal(reasons))
  }
}

/** G1: the project and issue binding. */
function assertBinding(ctx: WriteContext, op: WriteOp, target: WriteTarget): void {
  const { canvas } = target
  if (op === 'bind_project') throw new PolicyRefused(op, 'an agent cannot bind a canvas to a project')
  if (op === 'delete_canvas') throw new PolicyRefused(op, 'an agent cannot delete a canvas')
  if (!ctx.taskId) {
    if (canvas.projectId) throw new PolicyRefused(op, 'canvas is bound to a project and the agent has no Multica task')
    /* Multica identity is on (a verifier is plugged in): the missing header is no way around it */
    if (verifier && ctx.origin === 'mcp') throw new PolicyRefused(op, 'an MCP agent must present a Multica task')
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
