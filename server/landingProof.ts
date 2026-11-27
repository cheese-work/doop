import { createHash } from 'node:crypto'
import { PolicyRefused } from './policyRefused.ts'

/**
 * CHE-9672 (A5 landing S3c): the close proof. `verifyLanding` rebuilds, from Multica and from the bytes the
 * caller sent, the facts that make a landing legitimate, and returns a `LandingProof` only when all of them
 * hold. `assertWritable`'s `land_proposal` rule accepts nothing else. Inert: no route calls it yet (S3b).
 *
 * The Multica reads sit behind `LandingMultica`, so this file guesses no REST path and imports nothing from
 * the checklist module (S3a). The proof is a server-side value: `isLandingProof` knows only objects this
 * module made, so a proof-shaped object from input, a spread or a JSON round trip is not one.
 */

/** What S3a's `trustedChecklist` returns: the record the watcher keeps on the topic issue. */
export type TrustedChecklist = {
  link: { canvas: string; topic: string }
  decisionId: string
  /** the `Lock pin: …` line */
  pin: string
  recordCommentId: string
}

export interface LandingMultica {
  /** `DOOP_LANDING_WATCHER_ID`; unset means no proof can be made */
  readonly watcherId: string | undefined
  /** S3a. Its refusals carry a `code`, which passes through. */
  trustedChecklist(issueId: string): Promise<TrustedChecklist>
  /** `GET /api/decisions/:id` */
  decision(id: string): Promise<unknown>
  /** the workspace member list: `{ user_id, role }[]` */
  members(workspaceId: string): Promise<unknown>
}

export type LandingFrame = { frameId: string; html: string; contentSha256: string }

export type LandingRequest = {
  canvasId: string
  topicIssueId: string
  sourcePageId: string
  /** the source page's name, as the server resolved it (the checklist link names the topic) */
  sourcePageName: string
  closeDecisionId: string
  /** the `Lock pin: …` line */
  pin: string
  /** the exact bytes of LOCK.json */
  lockJson: string
  frames: LandingFrame[]
}

declare const landingBrand: unique symbol

export type LandingProof = Readonly<{
  projectId: string
  issueId: string
  canvasId: string
  sourcePageId: string
  sourcePageName: string
  decisionId: string
  recordCommentId: string
  pin: string
  watcherId: string
  frames: readonly { frameId: string; contentSha256: string }[]
}> & { readonly [landingBrand]: true }

const issued = new WeakSet<object>()

/** Whether `value` was returned by `verifyLanding` in this process. */
export const isLandingProof = (value: unknown): value is LandingProof =>
  typeof value === 'object' && value !== null && issued.has(value)

const OP = 'land_proposal'
const refuse = (code: string, reason: string): never => {
  throw new PolicyRefused(OP, reason, code)
}
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const text = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined)

/** A Multica read that failed or came back malformed: nothing is proven. */
const unavailable = (what: string): never => refuse('proof_unavailable', `${what} unavailable`)

async function read<T>(what: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call()
  } catch (error) {
    if (error instanceof PolicyRefused) throw error
    return unavailable(what)
  }
}

/** The options of a decision: a JSON array, or the base64 JSON the list endpoint sends. */
function optionLabels(options: unknown): (string | undefined)[] {
  let list = options
  if (typeof options === 'string') {
    try {
      list = JSON.parse(Buffer.from(options, 'base64').toString('utf8'))
    } catch {
      return unavailable('decision options')
    }
  }
  if (!Array.isArray(list)) return unavailable('decision options')
  return list.map((option) => (isRecord(option) ? text(option.label) : typeof option === 'string' ? option : undefined))
}

function checkDecision(decision: unknown, req: LandingRequest, watcherId: string) {
  if (!isRecord(decision)) return unavailable('decision')
  if (decision.id !== undefined && decision.id !== req.closeDecisionId)
    refuse('decision_mismatch', 'Multica returned another decision')
  if (decision.kind !== 'decision') refuse('decision_kind', 'the close record is not a decision')
  const answer = decision.answer
  if (decision.status !== 'answered' || !isRecord(answer))
    refuse('decision_not_answered', 'the decision is not answered')
  const given = answer as Record<string, unknown>
  if (decision.withdrawn_at) refuse('decision_withdrawn', 'the decision was withdrawn')
  if (decision.authority !== 'human') refuse('decision_not_human', 'the decision does not need a human')
  if (decision.asking_agent_id !== watcherId)
    refuse('decision_not_watcher', 'the decision was not asked by the watcher')
  if (decision.issue_id !== req.topicIssueId) refuse('decision_wrong_issue', 'the decision is on another issue')
  const index = given.chosen_option_index
  const label = typeof index === 'number' ? optionLabels(decision.options)[index] : undefined
  if (label !== 'close' || given.content_snapshot !== 'close') refuse('decision_not_close', 'the answer is not close')
  if (given.disclaimed_at) refuse('decision_disclaimed', 'the answer was disclaimed')
  const humanId = text(decision.human_user_id)
  if (!humanId || given.answered_by_user_id !== humanId)
    refuse('decision_answerer', 'the decision was not answered by its human')
  const projectId = text(decision.project_id)
  const workspaceId = text(decision.workspace_id)
  if (!projectId || !workspaceId) return unavailable('decision project')
  return { projectId, workspaceId, humanId, ask: typeof decision.ask === 'string' ? decision.ask : '' }
}

function checkPinLine(ask: string, pin: string): void {
  const lines = ask.split(/\r?\n/).filter((line) => line.trim().startsWith('Lock pin:'))
  if (lines.length === 0) refuse('pin_line_missing', 'the decision text has no pin line')
  if (lines.length > 1) refuse('pin_line_ambiguous', 'the decision text has more than one pin line')
  if (lines[0]?.trim() !== pin) refuse('pin_line_mismatch', 'the decision pin line is not the record pin')
}

function checkLock(req: LandingRequest): void {
  const manifest = /\bmanifest=([0-9a-f]{64})\b/.exec(req.pin)?.[1]
  if (!manifest || sha256(req.lockJson) !== manifest)
    refuse('manifest_mismatch', 'LOCK.json is not the pinned manifest')
  let lock: unknown
  try {
    lock = JSON.parse(req.lockJson)
  } catch {
    return refuse('lock_invalid', 'LOCK.json is not JSON')
  }
  if (!isRecord(lock) || !Array.isArray(lock.screens)) return refuse('lock_invalid', 'LOCK.json has no screens')
  if (lock.canvas_or_project_id !== req.canvasId) refuse('lock_mismatch', 'LOCK.json names another canvas')
  if (lock.page_id !== req.sourcePageId) refuse('lock_mismatch', 'LOCK.json names another page')
  const entries = new Map<string, unknown>()
  for (const screen of lock.screens as unknown[]) {
    const frameId = isRecord(screen) ? text(screen.frame_id) : undefined
    if (!frameId || entries.has(frameId)) return refuse('lock_invalid', 'LOCK.json has a bad or repeated frame id')
    entries.set(frameId, (screen as Record<string, unknown>).content_sha256)
  }
  const sent = new Set(req.frames.map((frame) => frame.frameId))
  if (sent.size !== req.frames.length || sent.size !== entries.size || [...sent].some((id) => !entries.has(id)))
    refuse('lock_mismatch', 'LOCK.json frames are not the frames sent')
  for (const frame of req.frames)
    if (entries.get(frame.frameId) !== frame.contentSha256 || sha256(frame.html) !== frame.contentSha256)
      refuse('frame_hash_mismatch', `frame ${frame.frameId} does not hash to its LOCK.json entry`)
}

/**
 * Throws a `PolicyRefused` (op `land_proposal`, a code per failed check) unless the request is a legitimate
 * landing: the trusted checklist names this decision, pin, canvas and topic; the decision is an answered,
 * undisclaimed, human `close` asked by the watcher on the topic issue, answered by its human, who is an owner;
 * its text holds exactly the record pin; and the sent LOCK.json and frames match the pin.
 */
export async function verifyLanding(req: LandingRequest, multica: LandingMultica): Promise<LandingProof> {
  const watcherId = text(multica.watcherId)
  if (!watcherId) return unavailable('the landing watcher setting')

  let checklist: TrustedChecklist
  try {
    checklist = await multica.trustedChecklist(req.topicIssueId)
  } catch (error) {
    const code = isRecord(error) ? text(error.code) : undefined
    if (code) refuse(code, error instanceof Error ? error.message : 'the checklist was refused')
    return unavailable('the checklist')
  }
  if (checklist.decisionId !== req.closeDecisionId)
    refuse('decision_mismatch', 'the request names a decision the record does not')
  if (checklist.pin !== req.pin) refuse('pin_mismatch', 'the request pin is not the record pin')
  if (checklist.link.canvas !== req.canvasId || checklist.link.topic !== req.sourcePageName)
    refuse('link_mismatch', 'the record link names another canvas or topic')

  const decision = await read('the decision', () => multica.decision(req.closeDecisionId))
  const { projectId, workspaceId, humanId, ask } = checkDecision(decision, req, watcherId)

  const members = await read('the member list', () => multica.members(workspaceId))
  if (!Array.isArray(members)) return unavailable('the member list')
  if (!members.some((member) => isRecord(member) && member.user_id === humanId && member.role === 'owner'))
    refuse('answerer_not_owner', 'the decision human is not an owner')

  checkPinLine(ask, req.pin)
  checkLock(req)

  const proof = Object.freeze({
    projectId,
    issueId: req.topicIssueId,
    canvasId: req.canvasId,
    sourcePageId: req.sourcePageId,
    sourcePageName: req.sourcePageName,
    decisionId: req.closeDecisionId,
    recordCommentId: checklist.recordCommentId,
    pin: req.pin,
    watcherId,
    frames: Object.freeze(req.frames.map(({ frameId, contentSha256 }) => ({ frameId, contentSha256 }))),
  }) as unknown as LandingProof
  issued.add(proof)
  return proof
}
