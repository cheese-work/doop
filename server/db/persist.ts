import fs from 'node:fs'
import path from 'node:path'
import { nanoid } from 'nanoid'
import { and, asc, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm'
import { db } from './index.ts'
import * as t from './schema.ts'
import { extractAssetIds } from '../assets.ts'
import type { Pin } from '../pinState.ts'
import { AGENT_ROLES, roleByAgentName } from '../../shared/agents.ts'
import type { AttestationRow } from '../../shared/designCompleteness.ts'
import { isCommunityCategory } from '../../shared/types.ts'
import { storedLinkAccess } from '../../shared/canvasRole.ts'
import type { ComponentDef, LibraryComponent } from '../../shared/components.ts'
import type { DesignToken, TokenType } from '../../shared/designTokens.ts'
import { parseRunnerPick } from '../../shared/agentRunner.ts'
import { byStack } from '../../shared/frameStack.ts'
import { unloadHtml } from '../frameHtml.ts'
import type {
  ActivityItem,
  ActorKind,
  AgentTask,
  CardScope,
  Canvas,
  DeletedPage,
  DesignDecision,
  ElementComment,
  Frame,
  FrameVersion,
  FrameVersionInfo,
  GuidelineDoc,
  MemoryProposal,
  MemoryReference,
  PageSnapshot,
  RepoCardKind,
  RepoCardPayload,
  TaskFeedback,
} from '../../shared/types.ts'

/**
 * Write-through persistence: the in-memory maps stay the source of truth and
 * the hot path; every committed mutation is mirrored here asynchronously.
 * Nothing on the live path (presence, cursors, reveal ticks) awaits the DB.
 */

/** the pool, or one open transaction: what a write that may join a transaction runs on */
type Exec = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0]

function swallow(p: Promise<unknown>) {
  p.catch((err) => console.error('[db] write failed', err))
}

/** every mutable canvas column, so insert and upsert can't drift apart */
function canvasColumns(c: Canvas) {
  return {
    name: c.name,
    pages: c.pages ?? null,
    guides: c.guides?.length ? c.guides : null,
    tokenThemes: c.tokenThemes?.length ? c.tokenThemes : null,
    ownerId: c.ownerId ?? null,
    linkAccess: storedLinkAccess(c.linkAccess) ?? null,
    publishedAt: c.publishedAt ?? null,
    description: c.description ?? null,
    category: c.category ?? null,
    copyCount: c.copyCount ?? 0,
    workspaceId: c.workspaceId ?? null,
    projectId: c.projectId ?? null,
    updatedAt: c.updatedAt,
  }
}

export function saveCanvas(c: Canvas) {
  swallow(
    db
      .insert(t.canvases)
      .values({ id: c.id, ...canvasColumns(c), createdAt: c.createdAt })
      .onConflictDoUpdate({ target: t.canvases.id, set: canvasColumns(c) }),
  )
}

/** A canvas's deleted pages (soft delete, CHE-5306). Kept off `saveCanvas` so
 * the many ordinary canvas writes cannot overwrite the column. */
export function saveDeletedPages(canvasId: string, pages: DeletedPage[]) {
  swallow(
    db
      .update(t.canvases)
      .set({ deletedPages: pages.length ? pages : null })
      .where(eq(t.canvases.id, canvasId)),
  )
}

/** Persist a newly duplicated canvas as one unit. Unlike ordinary live edits,
 * duplication must not report success until every copied row is durable. */
export async function saveCanvasCopy(c: Canvas): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.insert(t.canvases).values({ id: c.id, ...canvasColumns(c), createdAt: c.createdAt })

    if (c.frames.length) {
      await tx.insert(t.frames).values(
        c.frames.map((frame) => ({
          id: frame.id,
          canvasId: frame.canvasId,
          pageId: frame.pageId ?? null,
          name: frame.name,
          x: frame.x,
          y: frame.y,
          width: frame.width,
          height: frame.height,
          html: frame.html,
          createdAt: frame.createdAt,
          updatedAt: frame.updatedAt,
          updatedBy: frame.updatedBy,
          demo: frame.demo ?? null,
          hidden: frame.hidden ?? null,
          locked: frame.locked ?? null,
          lockEpoch: frame.lockEpoch ?? null,
          lockAttestationId: frame.lockAttestationId ?? null,
          z: frame.z ?? null,
          rotation: frame.rotation ?? null,
        })),
      )
    }

    if (c.guidelines?.length) {
      await tx.insert(t.guidelines).values(
        c.guidelines.map((doc) => ({
          canvasId: c.id,
          name: doc.name,
          markdown: doc.markdown,
          title: doc.title ?? null,
          updatedAt: doc.updatedAt,
          updatedBy: doc.updatedBy,
          x: doc.x ?? null,
          y: doc.y ?? null,
        })),
      )
    }

    if (c.components?.length) {
      await tx.insert(t.components).values(c.components.map((def) => componentRow(c.id, def)))
    }
    if (c.tokens?.length) {
      await tx.insert(t.designTokens).values(c.tokens.map((token) => tokenRow(c.id, token)))
    }

    if (c.references?.length) {
      await tx.insert(t.memoryReferences).values(
        c.references.map((ref) => ({
          id: ref.id,
          canvasId: c.id,
          frameId: ref.frameId,
          title: ref.title,
          html: ref.html,
          width: ref.width,
          height: ref.height,
          pinnedBy: ref.pinnedBy,
          pinnedAt: ref.pinnedAt,
        })),
      )
    }

    const refs = c.frames.flatMap((frame) =>
      [...extractAssetIds(frame.html)].map((assetId) => ({ assetId, frameId: frame.id })),
    )
    if (refs.length) await tx.insert(t.assetRefs).values(refs)
  })
}

export function saveMember(canvasId: string, userId: string, addedBy: string, addedAt: number) {
  swallow(db.insert(t.canvasMembers).values({ canvasId, userId, addedBy, addedAt }).onConflictDoNothing())
}

export function deleteMember(canvasId: string, userId: string) {
  swallow(
    db.delete(t.canvasMembers).where(and(eq(t.canvasMembers.canvasId, canvasId), eq(t.canvasMembers.userId, userId))),
  )
}

function componentRow(canvasId: string, def: ComponentDef) {
  return {
    canvasId,
    id: def.id,
    name: def.name,
    description: def.description,
    template: def.template,
    css: def.css,
    rawCss: def.rawCss,
    head: def.head,
    props: def.props,
    slots: def.slots,
    rev: def.rev,
    mainFrameId: def.mainFrameId,
    code: def.code ?? null,
    source: def.source ?? null,
    history: def.history,
    status: def.status ?? ('active' as const),
    deletedAt: def.deletedAt ?? null,
    deletedBy: def.deletedBy ?? null,
    createdAt: def.createdAt,
    updatedAt: def.updatedAt,
    updatedBy: def.updatedBy,
  }
}

/*
 * Writes to one component row go one at a time, and only the latest state waits: a create
 * saves a blank definition and then the filled one, and on a pooled connection two
 * fire-and-forget upserts land in either order. The blank one landing last left a hollow
 * row that the next boot loaded as the component (2026-11-11: 236 definitions, 7%). A write
 * that fails is retried while nothing newer waits, and logged when it gives up.
 */
interface RowQueue {
  next: (() => Promise<unknown>) | undefined
  drained: Promise<void>
}

const componentWrites = new Map<string, RowQueue>()

/** How long to wait before each retry of a failed component write. */
export const COMPONENT_WRITE_RETRIES_MS = [500, 5_000, 30_000]

/* a retry waiting out its delay: shutdown cuts the wait short, so the write gets its last try */
const retryWaits = new Set<() => void>()
let draining = false

const pause = (ms: number) =>
  draining
    ? Promise.resolve()
    : new Promise<void>((resolve) => {
        const wake = () => {
          clearTimeout(timer)
          retryWaits.delete(wake)
          resolve()
        }
        const timer = setTimeout(wake, ms)
        retryWaits.add(wake)
      })

function queueComponentWrite(canvasId: string, id: string, write: () => Promise<unknown>) {
  const key = `${canvasId}\0${id}`
  const queued = componentWrites.get(key)
  if (queued) {
    queued.next = write
    return
  }
  const queue: RowQueue = { next: write, drained: Promise.resolve() }
  componentWrites.set(key, queue)
  queue.drained = drainComponentWrites(key, queue)
}

async function drainComponentWrites(key: string, queue: RowQueue) {
  try {
    for (let write = queue.next; write; write = queue.next) {
      queue.next = undefined
      await writeWithRetries(key, write, queue)
    }
  } finally {
    componentWrites.delete(key)
  }
}

async function writeWithRetries(key: string, write: () => Promise<unknown>, queue: RowQueue) {
  for (let attempt = 0; ; attempt++) {
    try {
      await write()
      return
    } catch (error) {
      /* a newer state is waiting: it replaces this one, so this one need not land */
      if (queue.next) return
      const wait = COMPONENT_WRITE_RETRIES_MS[attempt]
      if (wait === undefined) {
        console.error(`[db] component write failed for good: ${key.replace('\0', '/')}`, error)
        return
      }
      console.error(`[db] component write failed, retrying in ${wait}ms: ${key.replace('\0', '/')}`, error)
      await pause(wait)
      if (queue.next) return
    }
  }
}

/** Every queued component write, settled: what a canvas delete waits for (so a queued save
 *  cannot put a row back afterwards), and what a test awaits. */
export function pendingComponentWrites(canvasId?: string): Promise<unknown> {
  const prefix = canvasId === undefined ? '' : `${canvasId}\0`
  return Promise.allSettled(
    [...componentWrites].filter(([key]) => key.startsWith(prefix)).map(([, queue]) => queue.drained),
  )
}

export function saveComponent(canvasId: string, def: ComponentDef) {
  const row = componentRow(canvasId, def)
  const { canvasId: _canvasId, id: _id, createdAt: _createdAt, ...set } = row
  queueComponentWrite(canvasId, def.id, () =>
    db
      .insert(t.components)
      .values(row)
      .onConflictDoUpdate({ target: [t.components.canvasId, t.components.id], set }),
  )
}

/**
 * The components with an instance stored at an older revision than the component: the
 * frames a propagation never reached (the queue lives in memory, so a restart mid-drain
 * drops it; the kill switch of 2026-11-11 deferred it). Read in the database, where matching
 * every frame's HTML costs the server nothing.
 */
export async function componentsBehind(): Promise<{ canvasId: string; componentId: string }[]> {
  const result = await db.execute(sql`
    select distinct c.canvas_id as "canvasId", c.id as "componentId"
    from components c
    join frames f on f.canvas_id = c.canvas_id
      and position('data-doop-instance="' || c.id || '"' in f.html) > 0
    cross join lateral regexp_matches(f.html, 'data-doop-instance="' || c.id || '" data-doop-rev="(\\d+)"', 'g') as m
    where coalesce(c.status, 'active') = 'active' and c.rev > 1 and m[1]::int < c.rev`)
  return (result as unknown as { rows: { canvasId: string; componentId: string }[] }).rows
}

export function deleteComponent(canvasId: string, id: string) {
  queueComponentWrite(canvasId, id, () =>
    db.delete(t.components).where(and(eq(t.components.canvasId, canvasId), eq(t.components.id, id))),
  )
}

export function saveLibraryComponent(snapshot: LibraryComponent) {
  const row = { ...snapshot, code: snapshot.code ?? null, nested: snapshot.nested ?? null }
  const { canvasId: _canvasId, id: _id, ...set } = row
  swallow(
    db
      .insert(t.libraryComponents)
      .values(row)
      .onConflictDoUpdate({ target: [t.libraryComponents.canvasId, t.libraryComponents.id], set }),
  )
}

export function deleteLibraryComponent(canvasId: string, id: string) {
  swallow(
    db
      .delete(t.libraryComponents)
      .where(and(eq(t.libraryComponents.canvasId, canvasId), eq(t.libraryComponents.id, id))),
  )
}

export async function loadLibraryComponents(): Promise<LibraryComponent[]> {
  const rows = await db.select().from(t.libraryComponents).orderBy(t.libraryComponents.name)
  return rows.map(({ code, nested, ...row }) => ({ ...row, ...(code ? { code } : {}), ...(nested ? { nested } : {}) }))
}

export function saveGuideline(canvasId: string, doc: GuidelineDoc) {
  const row = {
    canvasId,
    name: doc.name,
    markdown: doc.markdown,
    title: doc.title ?? null,
    updatedAt: doc.updatedAt,
    updatedBy: doc.updatedBy,
    x: doc.x ?? null,
    y: doc.y ?? null,
  }
  swallow(
    db
      .insert(t.guidelines)
      .values(row)
      .onConflictDoUpdate({
        target: [t.guidelines.canvasId, t.guidelines.name],
        set: {
          markdown: row.markdown,
          title: row.title,
          updatedAt: row.updatedAt,
          updatedBy: row.updatedBy,
          x: row.x,
          y: row.y,
        },
      }),
  )
}

export function deleteGuideline(canvasId: string, name: string) {
  swallow(db.delete(t.guidelines).where(and(eq(t.guidelines.canvasId, canvasId), eq(t.guidelines.name, name))))
}

function tokenRow(canvasId: string, token: DesignToken) {
  return {
    canvasId,
    name: token.name,
    type: token.type,
    value: token.value,
    themes: token.themes && Object.keys(token.themes).length ? token.themes : null,
    description: token.description ?? null,
    order: token.order,
    updatedAt: token.updatedAt,
    updatedBy: token.updatedBy,
  }
}

/* Writes to one token run in order: a rename followed by an edit of the
   same row must not let the earlier write land last on a pooled connection. */
const tokenWrites = new Map<string, Promise<unknown>>()

function queueTokenWrite(canvasId: string, name: string, write: () => Promise<unknown>) {
  const key = `${canvasId}\0${name}`
  const prior = tokenWrites.get(key) ?? Promise.resolve()
  const next = prior.then(write, write)
  tokenWrites.set(key, next)
  swallow(next.finally(() => tokenWrites.get(key) === next && tokenWrites.delete(key)))
}

/** Every queued token write of a canvas, settled: what a canvas delete waits
 *  for, so a save still in the queue cannot put a row back afterwards. */
function pendingTokenWrites(canvasId: string): Promise<unknown> {
  const prefix = `${canvasId}\0`
  return Promise.allSettled([...tokenWrites].filter(([key]) => key.startsWith(prefix)).map(([, write]) => write))
}

export function saveToken(canvasId: string, token: DesignToken) {
  const row = tokenRow(canvasId, token)
  queueTokenWrite(canvasId, token.name, () =>
    db
      .insert(t.designTokens)
      .values(row)
      .onConflictDoUpdate({
        target: [t.designTokens.canvasId, t.designTokens.name],
        set: {
          type: row.type,
          value: row.value,
          themes: row.themes,
          description: row.description,
          order: row.order,
          updatedAt: row.updatedAt,
          updatedBy: row.updatedBy,
        },
      }),
  )
}

export function deleteToken(canvasId: string, name: string) {
  queueTokenWrite(canvasId, name, () =>
    db.delete(t.designTokens).where(and(eq(t.designTokens.canvasId, canvasId), eq(t.designTokens.name, name))),
  )
}

/* Append-only doc history: a snapshot per save, '' marks a deletion. */
const MAX_GUIDELINE_VERSIONS = 50

export function saveGuidelineVersion(canvasId: string, name: string, markdown: string, by: string, at: number) {
  swallow(appendGuidelineVersion(canvasId, name, markdown, by, at))
}

async function appendGuidelineVersion(canvasId: string, name: string, markdown: string, by: string, at: number) {
  await db.insert(t.guidelineVersions).values({ id: nanoid(10), canvasId, name, markdown, savedAt: at, savedBy: by })
  const excess = await db
    .select({ id: t.guidelineVersions.id })
    .from(t.guidelineVersions)
    .where(and(eq(t.guidelineVersions.canvasId, canvasId), eq(t.guidelineVersions.name, name)))
    .orderBy(desc(t.guidelineVersions.savedAt))
    .offset(MAX_GUIDELINE_VERSIONS)
  if (excess.length) {
    await db.delete(t.guidelineVersions).where(
      inArray(
        t.guidelineVersions.id,
        excess.map((e) => e.id),
      ),
    )
  }
}

/** Newest first. Cold path — read straight from the database on demand. */
export function listGuidelineVersions(canvasId: string, name: string) {
  return db
    .select()
    .from(t.guidelineVersions)
    .where(and(eq(t.guidelineVersions.canvasId, canvasId), eq(t.guidelineVersions.name, name)))
    .orderBy(desc(t.guidelineVersions.savedAt))
}

/* Design memory: single-shot writes, like guidelines. */
export function saveReference(canvasId: string, ref: MemoryReference) {
  swallow(
    db
      .insert(t.memoryReferences)
      .values({
        id: ref.id,
        canvasId,
        frameId: ref.frameId,
        title: ref.title,
        html: ref.html,
        width: ref.width,
        height: ref.height,
        pinnedBy: ref.pinnedBy,
        pinnedAt: ref.pinnedAt,
      })
      .onConflictDoNothing(),
  )
}

export function deleteReference(id: string) {
  swallow(db.delete(t.memoryReferences).where(eq(t.memoryReferences.id, id)))
}

export function saveDecision(canvasId: string, d: DesignDecision) {
  const row = {
    id: d.id,
    canvasId,
    text: d.text,
    summary: d.summary ?? null,
    source: d.source,
    frameId: d.frameId ?? null,
    fromName: d.from,
    agentName: d.agentName ?? null,
    at: d.at,
    distilledAt: d.distilledAt ?? null,
  }
  swallow(
    db
      .insert(t.decisions)
      .values(row)
      .onConflictDoUpdate({ target: t.decisions.id, set: { summary: row.summary, distilledAt: row.distilledAt } }),
  )
}

export function saveProposal(canvasId: string, p: MemoryProposal) {
  const row = {
    id: p.id,
    canvasId,
    guideName: p.guideName,
    guideTitle: p.guideTitle ?? null,
    rule: p.rule,
    rationale: p.rationale,
    basedOn: p.basedOn.join(','),
    at: p.at,
    status: p.status,
    resolvedBy: p.resolvedBy ?? null,
    resolvedAt: p.resolvedAt ?? null,
  }
  swallow(
    db
      .insert(t.memoryProposals)
      .values(row)
      .onConflictDoUpdate({
        target: t.memoryProposals.id,
        set: { status: row.status, resolvedBy: row.resolvedBy, resolvedAt: row.resolvedAt },
      }),
  )
}

/* ------------------------------------------------------------------ */
/* Frame fence (CHE-9399 step 1)                                      */
/* ------------------------------------------------------------------ */

/* A purge must not race a frame write on its way to the database. `fenceFrame` raises a fence on one
   frame: every top-level frame writer checks it ONCE, on entry, before its first await. A fenced write
   waits for `fence.outcome`: `kept` runs it as it would have run, `purged` drops it. A write admitted
   before the fence (or called with a transaction: it inherits its caller's admission) finishes whole,
   and `settleFrameWrites` waits for it. Nothing in this block deletes a row. */

export type FrameFenceOutcome = 'kept' | 'purged'

export interface FrameFence {
  readonly frameId: string
  /** settles `kept` on `release()`, `purged` on `forgetFrame` */
  readonly outcome: Promise<FrameFenceOutcome>
  release(): void
}

/** a keyed frame write refused because its frame was purged while it waited */
export class FramePurgedError extends Error {
  constructor(readonly frameId: string) {
    super(`frame ${frameId} was purged`)
    this.name = 'FramePurgedError'
  }
}

/** `settleFrameWrites` gave up; nothing has been deleted */
export class SettleTimeout extends Error {
  constructor(
    readonly frameId: string,
    readonly timeoutMs: number,
  ) {
    super(`frame ${frameId} still has writes in flight after ${timeoutMs} ms`)
    this.name = 'SettleTimeout'
  }
}

const SETTLE_TIMEOUT_MS = 30_000

type OpenFence = FrameFence & { settle: (outcome: FrameFenceOutcome) => void }
const fences = new Map<string, OpenFence>()
/** frames a purge has finished with; for the life of the process a later writer for one drops */
const purgedFrames = new Set<string>()
/** admitted top-level frame writes, per frame, until each settles; a held write is not here */
const frameWritesInFlight = new Map<string, Set<Promise<unknown>>>()
/** comment writes per frame: read-only, no fence and no hold, so a comment write is never delayed or dropped */
const commentWritesByFrame = new Map<string, number>()
const commentWritePromises = new Map<string, Set<Promise<unknown>>>()

export function fenceFrame(frameId: string): FrameFence {
  const open = fences.get(frameId)
  if (open) return open
  let settle!: (outcome: FrameFenceOutcome) => void
  const outcome = new Promise<FrameFenceOutcome>((resolve) => (settle = resolve))
  const fence: OpenFence = {
    frameId,
    outcome,
    settle,
    release() {
      if (fences.get(frameId) === fence) fences.delete(frameId)
      settle('kept')
    },
  }
  fences.set(frameId, fence)
  return fence
}

/** the fence a writer must wait for, if one is up; a purged frame answers `purged` at once */
function fenceGate(frameId: string): Promise<FrameFenceOutcome> | undefined {
  if (purgedFrames.has(frameId)) return Promise.resolve('purged')
  return fences.get(frameId)?.outcome
}

function track(registry: Map<string, Set<Promise<unknown>>>, frameId: string, write: Promise<unknown>) {
  const set = registry.get(frameId) ?? new Set<Promise<unknown>>()
  registry.set(frameId, set)
  set.add(write)
  const done = () => {
    set.delete(write)
    if (set.size === 0 && registry.get(frameId) === set) registry.delete(frameId)
  }
  write.then(done, done)
}

/** Admission for a top-level frame writer: runs `write` now when no fence is up (registered until it
 *  settles), else waits for the fence. Resolves `undefined` when the write was dropped. */
function admit<T>(frameId: string, write: () => Promise<T>): Promise<T | undefined> {
  const gate = fenceGate(frameId)
  if (!gate) {
    const running = write()
    track(frameWritesInFlight, frameId, running)
    return running
  }
  return gate.then((outcome) => (outcome === 'kept' ? admit(frameId, write) : undefined))
}

/** Wait until every write admitted for the frame has settled: its registry, its version queue and its
 *  comment writes. A debounce still pending is cleared (it stays dirty, so the idle sweep writes it if
 *  the fence is kept). Rejects with `SettleTimeout` when they do not end in time. */
export async function settleFrameWrites(
  frameId: string,
  { timeoutMs = SETTLE_TIMEOUT_MS }: { timeoutMs?: number } = {},
): Promise<void> {
  const timer = frameTimers.get(frameId)
  if (timer) clearTimeout(timer)
  frameTimers.delete(frameId)
  const waits = [
    ...(frameWritesInFlight.get(frameId) ?? []),
    ...(commentWritePromises.get(frameId) ?? []),
    ...(versionWrites.has(frameId) ? [versionWrites.get(frameId)!.queued] : []),
  ]
  let timeout: NodeJS.Timeout | undefined
  const expired = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new SettleTimeout(frameId, timeoutMs)), timeoutMs)
  })
  try {
    await Promise.race([Promise.allSettled(waits), expired])
  } finally {
    clearTimeout(timeout)
  }
}

/** Called only by the purge's finalizer: held writers drop, a later writer for the frame drops, and
 *  nothing is left for the idle sweep or `retryFrameWrite` to write again. */
export function forgetFrame(frameId: string): void {
  purgedFrames.add(frameId)
  const timer = frameTimers.get(frameId)
  if (timer) clearTimeout(timer)
  frameTimers.delete(frameId)
  dirtyFrames.delete(frameId)
  writesInFlight.delete(frameId)
  versionWrites.delete(frameId)
  const open = fences.get(frameId)
  fences.delete(frameId)
  open?.settle('purged')
}

/** how many writes for comments anchored on this frame are on their way to the database */
export function commentWritesPending(frameId: string): number {
  return commentWritesByFrame.get(frameId) ?? 0
}

function trackCommentWrite(frameId: string | null | undefined, write: Promise<unknown>) {
  if (!frameId) return
  commentWritesByFrame.set(frameId, (commentWritesByFrame.get(frameId) ?? 0) + 1)
  track(commentWritePromises, frameId, write)
  const done = () => {
    const left = (commentWritesByFrame.get(frameId) ?? 1) - 1
    if (left > 0) commentWritesByFrame.set(frameId, left)
    else commentWritesByFrame.delete(frameId)
  }
  write.then(done, done)
}

/** what persist still holds for one frame (a read-only view for tests and the purge's final check) */
export function frameWriteState(frameId: string) {
  return {
    dirty: dirtyFrames.has(frameId),
    timer: frameTimers.has(frameId),
    inFlight: writesInFlight.has(frameId),
    versions: versionWrites.has(frameId),
  }
}

/* Streaming appends update a frame's html on every chunk — debounce per frame
   so the DB sees one row write per burst, not one per keystroke of the reveal. */
const frameTimers = new Map<string, NodeJS.Timeout>()
const FRAME_DEBOUNCE_MS = 400

/** Persist a duplicated page as one unit: the canvas's new page list and
 * every copied frame land together or not at all, so a copy is never half
 * there after a crash. Like saveCanvasCopy, success means durable. */
export async function savePageCopy(c: Canvas, frames: Frame[], beforeCommit?: () => void): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.update(t.canvases).set(canvasColumns(c)).where(eq(t.canvases.id, c.id))
    if (!frames.length) return beforeCommit?.()
    await tx.insert(t.frames).values(
      frames.map((frame) => ({
        id: frame.id,
        canvasId: frame.canvasId,
        pageId: frame.pageId ?? null,
        name: frame.name,
        x: frame.x,
        y: frame.y,
        width: frame.width,
        height: frame.height,
        html: frame.html,
        createdAt: frame.createdAt,
        updatedAt: frame.updatedAt,
        updatedBy: frame.updatedBy,
        demo: frame.demo ?? null,
        hidden: frame.hidden ?? null,
        locked: frame.locked ?? null,
        lockEpoch: frame.lockEpoch ?? null,
        lockAttestationId: frame.lockAttestationId ?? null,
        z: frame.z ?? null,
        rotation: frame.rotation ?? null,
      })),
    )
    const refs = frames.flatMap((frame) =>
      [...extractAssetIds(frame.html)].map((assetId) => ({ assetId, frameId: frame.id })),
    )
    if (refs.length) await tx.insert(t.assetRefs).values(refs)
    /* the last word before the rows become durable: a throw here rolls the whole copy back */
    beforeCommit?.()
  })
}

/** Write the frame now and resolve once it is on disk, for a caller that
 *  must write something naming the frame's content afterwards. */
/* Frames whose latest state is not yet in the database, by write
   generation: marked on every save, cleared only once a write that started
   at the latest generation succeeds. A frame stays dirty through its
   debounce, its write in flight and a failed write, and a dirty frame keeps
   its canvas loaded (store.evictIdle) — dropping it would lose the only
   copy, or reload the stored row over a newer one still being written. */
const dirtyFrames = new Map<string, number>()

/** writes of a frame on their way to the database, counted */
const writesInFlight = new Map<string, number>()

function markDirty(frameId: string) {
  dirtyFrames.set(frameId, (dirtyFrames.get(frameId) ?? 0) + 1)
}

export async function saveFrameNow(f: Frame): Promise<void> {
  if (purgedFrames.has(f.id)) return
  markDirty(f.id)
  const existing = frameTimers.get(f.id)
  if (existing) clearTimeout(existing)
  frameTimers.delete(f.id)
  await admit(f.id, () => writeFrame(f))
}

export function saveFrame(f: Frame, immediate = false) {
  if (purgedFrames.has(f.id)) return
  markDirty(f.id)
  const existing = frameTimers.get(f.id)
  if (existing) clearTimeout(existing)
  if (immediate) {
    frameTimers.delete(f.id)
    swallow(admit(f.id, () => writeFrame(f)))
    return
  }
  /* entered while fenced: no timer (settle would clear it and nothing would reschedule). The save waits
   * on the fence: `kept` schedules it as a normal debounce, `purged` drops it. The frame stays dirty
   * meanwhile, so it is not evicted. Repeated calls collapse into one timer when they resume. */
  const gate = fenceGate(f.id)
  if (gate) {
    swallow(gate.then((outcome) => (outcome === 'kept' ? saveFrame(f) : undefined)))
    return
  }
  frameTimers.set(
    f.id,
    setTimeout(() => {
      frameTimers.delete(f.id)
      swallow(admit(f.id, () => writeFrame(f))) // f is mutated in place by the store, so the ref holds the latest state
    }, FRAME_DEBOUNCE_MS),
  )
}

async function writeFrame(f: Frame, exec: Exec = db) {
  writesInFlight.set(f.id, (writesInFlight.get(f.id) ?? 0) + 1)
  try {
    await writeFrameRow(f, exec)
  } finally {
    const left = (writesInFlight.get(f.id) ?? 1) - 1
    if (left > 0) writesInFlight.set(f.id, left)
    else writesInFlight.delete(f.id)
  }
}

async function writeFrameRow(f: Frame, exec: Exec) {
  const generation = dirtyFrames.get(f.id)
  const html = f.html
  const row = {
    id: f.id,
    canvasId: f.canvasId,
    pageId: f.pageId ?? null,
    name: f.name,
    x: f.x,
    y: f.y,
    width: f.width,
    height: f.height,
    html,
    createdAt: f.createdAt,
    updatedAt: f.updatedAt,
    updatedBy: f.updatedBy,
    demo: f.demo ?? null,
    hidden: f.hidden ?? null,
    locked: f.locked ?? null,
    lockEpoch: f.lockEpoch ?? null,
    lockAttestationId: f.lockAttestationId ?? null,
    z: f.z ?? null,
    rotation: f.rotation ?? null,
    approval: f.approval ?? null,
    deletedAt: f.deletedAt ?? null,
  }
  const { id, createdAt, ...set } = row
  /* Second line of the frame lock (the first is `store.updateFrame`): when the
     stored row and this frame are both locked in the same lock epoch, html, width
     and height keep their stored values, decided inside the one upsert statement.
     An unlock saved with its next edit carries `locked: false` and lands whole. An
     unlock that never reached the row (its save was cancelled by an immediate
     relock) shows as a higher `lock_epoch`: the content written between the two
     locks is the attested content and lands with the relock. */
  const keepWhileLocked = (column: typeof t.frames.html | typeof t.frames.width | typeof t.frames.height) =>
    sql`CASE WHEN ${t.frames.locked} IS TRUE AND excluded.locked IS TRUE AND COALESCE(${t.frames.lockEpoch}, 0) = COALESCE(excluded.lock_epoch, 0) THEN ${column} ELSE excluded.${sql.identifier(column.name)} END`
  await exec
    .insert(t.frames)
    .values(row)
    .onConflictDoUpdate({
      target: t.frames.id,
      set: {
        ...set,
        html: keepWhileLocked(t.frames.html),
        width: keepWhileLocked(t.frames.width),
        height: keepWhileLocked(t.frames.height),
      },
    })
  /* a save made while this one was in flight keeps the frame dirty */
  if (exec === db && dirtyFrames.get(f.id) === generation) dirtyFrames.delete(f.id)
  await syncAssetRefs(f.id, html, exec)
}

/** A frame whose latest state is not yet stored: waiting on its debounce,
 *  its write in flight, or its write failed. Its canvas must stay loaded. */
export function frameWritePending(frameId: string): boolean {
  return dirtyFrames.has(frameId)
}

/** Write again a dirty frame with nothing scheduled or in flight: one whose
 *  write failed. The idle sweep calls this for the frames that keep their
 *  canvas from being dropped. */
export function retryFrameWrite(f: Frame) {
  const gate = fenceGate(f.id)
  if (gate) {
    swallow(gate.then((outcome) => (outcome === 'kept' ? retryFrameWrite(f) : undefined)))
    return
  }
  if (dirtyFrames.has(f.id) && !frameTimers.has(f.id) && !writesInFlight.has(f.id)) saveFrame(f)
}

/** Move a frame to another page without touching its html, for a frame
 *  whose canvas is not loaded (store.init's repair of an orphaned frame). */
export function saveFramePage(frameId: string, pageId: string) {
  swallow(admit(frameId, () => writeFramePage(frameId, pageId)))
}

async function writeFramePage(frameId: string, pageId: string) {
  await db.update(t.frames).set({ pageId }).where(eq(t.frames.id, frameId))
}

/** A frame moved into or out of the trash, without its html (which may not be loaded). */
export function saveFrameTrash(f: Frame) {
  swallow(admit(f.id, () => writeFrameTrash(f)))
}

async function writeFrameTrash(f: Frame) {
  await db
    .update(t.frames)
    .set({ deletedAt: f.deletedAt ?? null, pageId: f.pageId ?? null, updatedAt: f.updatedAt })
    .where(eq(t.frames.id, f.id))
}

/** The html of every frame on a canvas, for store.load. */
export function loadFrameHtml(canvasId: string): Promise<{ id: string; html: string }[]> {
  return db.select({ id: t.frames.id, html: t.frames.html }).from(t.frames).where(eq(t.frames.canvasId, canvasId))
}

/** One frame's html, for a render of a frame whose canvas is not loaded. */
export async function loadOneFrameHtml(frameId: string): Promise<string | undefined> {
  const [row] = await db.select({ html: t.frames.html }).from(t.frames).where(eq(t.frames.id, frameId))
  return row?.html
}

const frameMetaColumns = {
  id: t.frames.id,
  canvasId: t.frames.canvasId,
  pageId: t.frames.pageId,
  name: t.frames.name,
  x: t.frames.x,
  y: t.frames.y,
  width: t.frames.width,
  height: t.frames.height,
  createdAt: t.frames.createdAt,
  updatedAt: t.frames.updatedAt,
  updatedBy: t.frames.updatedBy,
  demo: t.frames.demo,
  hidden: t.frames.hidden,
  locked: t.frames.locked,
  lockEpoch: t.frames.lockEpoch,
  lockAttestationId: t.frames.lockAttestationId,
  z: t.frames.z,
  rotation: t.frames.rotation,
  approval: t.frames.approval,
  deletedAt: t.frames.deletedAt,
}

/* Frame design history: one row per burst boundary (see actions.ts), newest
   kept to MAX_FRAME_VERSIONS per frame. Appends are fire-and-forget like every
   other write; reads happen only when someone opens the history. */
const MAX_FRAME_VERSIONS = 50

/* A version write reads the newest row before it inserts, so a frame's
   deletion must queue behind its pending writes (and they behind each
   other), or a late insert could put back history the delete just removed.
   One queue per frame; deleteCanvas waits for every frame of the canvas. */
const versionWrites = new Map<string, { canvasId: string; queued: Promise<unknown> }>()

function queueVersionWrite(frameId: string, canvasId: string, work: () => Promise<unknown>) {
  const previous = versionWrites.get(frameId)?.queued ?? Promise.resolve()
  const queued = previous.then(work, work)
  versionWrites.set(frameId, { canvasId, queued })
  swallow(queued.finally(() => versionWrites.get(frameId)?.queued === queued && versionWrites.delete(frameId)))
}

export function saveFrameVersion(version: FrameVersion) {
  const gate = fenceGate(version.frameId)
  if (gate) {
    swallow(gate.then((outcome) => outcome === 'kept' && saveFrameVersion(version)))
    return
  }
  queueVersionWrite(version.frameId, version.canvasId, () => appendFrameVersion(version))
}

/** Settles once every queued version write the filter picks has landed. */
function pendingVersionWrites(pick: (frameId: string, canvasId: string) => boolean) {
  const queued = [...versionWrites].filter(([frameId, e]) => pick(frameId, e.canvasId)).map(([, e]) => e.queued)
  return Promise.allSettled(queued)
}

async function appendFrameVersion(version: FrameVersion) {
  /* a burst that ended where it began (an edit typed and reverted) would
     snapshot the same state twice — the newest row already holds it. Size
     counts: the same document at another frame size is a state of its own */
  const [latest] = await db
    .select({ html: t.frameVersions.html, width: t.frameVersions.width, height: t.frameVersions.height })
    .from(t.frameVersions)
    .where(eq(t.frameVersions.frameId, version.frameId))
    .orderBy(desc(t.frameVersions.savedAt))
    .limit(1)
  if (latest && latest.html === version.html && latest.width === version.width && latest.height === version.height)
    return
  await db.insert(t.frameVersions).values({
    id: version.id,
    frameId: version.frameId,
    canvasId: version.canvasId,
    html: version.html,
    width: version.width,
    height: version.height,
    savedAt: version.savedAt,
    savedBy: version.savedBy,
    savedByKind: version.savedByKind ?? null,
  })
  const excess = await db
    .select({ id: t.frameVersions.id })
    .from(t.frameVersions)
    .where(eq(t.frameVersions.frameId, version.frameId))
    .orderBy(desc(t.frameVersions.savedAt))
    .offset(MAX_FRAME_VERSIONS)
  if (excess.length) {
    await db.delete(t.frameVersions).where(
      inArray(
        t.frameVersions.id,
        excess.map((e) => e.id),
      ),
    )
  }
}

export type FrameWriteKeyRow = {
  versionId: string
  payloadHash: string
  result: { updatedAt: number; htmlBytes: number }
}

/** The stored answer of an earlier write under this key, if one committed. */
export async function findFrameWriteKey(frameId: string, key: string): Promise<FrameWriteKeyRow | undefined> {
  const [row] = await db
    .select({
      versionId: t.frameWriteKeys.versionId,
      payloadHash: t.frameWriteKeys.payloadHash,
      result: t.frameWriteKeys.result,
    })
    .from(t.frameWriteKeys)
    .where(and(eq(t.frameWriteKeys.frameId, frameId), eq(t.frameWriteKeys.key, key)))
  return row
}

/** Commit a keyed frame write as one unit: the key row, the frame row (html and
 *  size) and the named version land together or not at all. Resolves to the
 *  earlier row, writing nothing, when the key is already taken (a writer that
 *  got past the in-process arbiter, or another instance). */
export async function commitKeyedFrameWrite(
  frame: Frame,
  write: {
    key: string
    payloadHash: string
    versionId: string
    versionName?: string
    savedByKind: ActorKind
    /** the version as the write produced it: the frame is live and may have moved on during the commit */
    version: { html: string; width: number; height: number; savedAt: number; savedBy: string }
    result: FrameWriteKeyRow['result']
  },
): Promise<FrameWriteKeyRow | undefined> {
  const gate = fenceGate(frame.id)
  if (gate) {
    return gate.then((outcome) => {
      if (outcome === 'purged') throw new FramePurgedError(frame.id)
      return commitKeyedFrameWrite(frame, write)
    })
  }
  /* any pending debounced write holds the very state committed below */
  const timer = frameTimers.get(frame.id)
  if (timer) clearTimeout(timer)
  frameTimers.delete(frame.id)
  /* admitted: the whole transaction is registered, and its nested writeFrame(frame, tx) never checks the fence */
  const committed = db.transaction(async (tx) => {
    const [claimed] = await tx
      .insert(t.frameWriteKeys)
      .values({
        frameId: frame.id,
        key: write.key,
        payloadHash: write.payloadHash,
        versionId: write.versionId,
        result: write.result,
        createdAt: Date.now(),
      })
      .onConflictDoNothing()
      .returning({ versionId: t.frameWriteKeys.versionId })
    if (!claimed) {
      const [earlier] = await tx
        .select({
          versionId: t.frameWriteKeys.versionId,
          payloadHash: t.frameWriteKeys.payloadHash,
          result: t.frameWriteKeys.result,
        })
        .from(t.frameWriteKeys)
        .where(and(eq(t.frameWriteKeys.frameId, frame.id), eq(t.frameWriteKeys.key, write.key)))
      return earlier
    }
    await writeFrame(frame, tx)
    await tx.insert(t.frameVersions).values({
      id: write.versionId,
      frameId: frame.id,
      canvasId: frame.canvasId,
      html: write.version.html,
      width: write.version.width,
      height: write.version.height,
      savedAt: write.version.savedAt,
      savedBy: write.version.savedBy,
      savedByKind: write.savedByKind,
      name: write.versionName ?? null,
    })
    return undefined
  })
  track(frameWritesInFlight, frame.id, committed)
  return committed
}

/* Named page snapshots. Unlike version writes these are awaited by the caller:
   a restore files its safety snapshot before it changes anything, so a failed
   write must stop it. HTML is deduplicated per canvas by content hash. */
export async function savePageSnapshot(snapshot: PageSnapshot, htmlByHash: Map<string, string>): Promise<void> {
  await db.transaction(async (tx) => {
    if (htmlByHash.size) {
      await tx
        .insert(t.snapshotBlobs)
        .values([...htmlByHash].map(([hash, html]) => ({ canvasId: snapshot.canvasId, hash, html })))
        .onConflictDoNothing()
    }
    await tx.insert(t.pageSnapshots).values({
      id: snapshot.id,
      canvasId: snapshot.canvasId,
      pageId: snapshot.pageId,
      pageName: snapshot.pageName,
      name: snapshot.name,
      author: snapshot.author,
      authorKind: snapshot.authorKind ?? null,
      createdAt: snapshot.createdAt,
      frames: snapshot.frames,
    })
  })
}

function toPageSnapshot(row: typeof t.pageSnapshots.$inferSelect): PageSnapshot {
  return {
    id: row.id,
    canvasId: row.canvasId,
    pageId: row.pageId,
    pageName: row.pageName,
    name: row.name,
    author: row.author,
    authorKind: frameVersionKind(row.authorKind),
    createdAt: row.createdAt,
    frames: row.frames,
  }
}

/** Newest first; one page's, or the whole canvas's when no page is named. */
export async function listPageSnapshots(canvasId: string, pageId?: string): Promise<PageSnapshot[]> {
  const rows = await db
    .select()
    .from(t.pageSnapshots)
    .where(
      pageId
        ? and(eq(t.pageSnapshots.canvasId, canvasId), eq(t.pageSnapshots.pageId, pageId))
        : eq(t.pageSnapshots.canvasId, canvasId),
    )
    .orderBy(desc(t.pageSnapshots.createdAt), desc(t.pageSnapshots.id))
  return rows.map(toPageSnapshot)
}

/** One snapshot; undefined when the id is unknown OR belongs to another
 *  canvas, so a caller can never read across canvases by id alone. */
export async function getPageSnapshot(canvasId: string, id: string): Promise<PageSnapshot | undefined> {
  const [row] = await db
    .select()
    .from(t.pageSnapshots)
    .where(and(eq(t.pageSnapshots.id, id), eq(t.pageSnapshots.canvasId, canvasId)))
    .limit(1)
  return row ? toPageSnapshot(row) : undefined
}

/** hash -> html for the hashes this canvas holds. */
export async function getSnapshotHtml(canvasId: string, hashes: string[]): Promise<Map<string, string>> {
  if (!hashes.length) return new Map()
  const rows = await db
    .select()
    .from(t.snapshotBlobs)
    .where(and(eq(t.snapshotBlobs.canvasId, canvasId), inArray(t.snapshotBlobs.hash, hashes)))
  return new Map(rows.map((r) => [r.hash, r.html]))
}

function frameVersionKind(kind: string | null): ActorKind | undefined {
  return kind === 'user' || kind === 'agent' ? kind : undefined
}

/** Newest first, without the HTML — the list stays light however large the
 *  designs are; `getFrameVersion` fetches one in full. */
export async function listFrameVersions(frameId: string): Promise<FrameVersionInfo[]> {
  /* a replace files its version behind the response; the list that follows
     it must show it */
  await pendingVersionWrites((id) => id === frameId)
  const rows = await db
    .select({
      id: t.frameVersions.id,
      frameId: t.frameVersions.frameId,
      canvasId: t.frameVersions.canvasId,
      width: t.frameVersions.width,
      height: t.frameVersions.height,
      savedAt: t.frameVersions.savedAt,
      savedBy: t.frameVersions.savedBy,
      savedByKind: t.frameVersions.savedByKind,
      name: t.frameVersions.name,
      htmlBytes: sql<number>`length(${t.frameVersions.html})`,
    })
    .from(t.frameVersions)
    .where(eq(t.frameVersions.frameId, frameId))
    .orderBy(desc(t.frameVersions.savedAt))
  return rows.map((row) => ({
    id: row.id,
    frameId: row.frameId,
    canvasId: row.canvasId,
    width: row.width,
    height: row.height,
    savedAt: row.savedAt,
    savedBy: row.savedBy,
    savedByKind: frameVersionKind(row.savedByKind),
    htmlBytes: Number(row.htmlBytes),
    ...(row.name ? { name: row.name } : {}),
  }))
}

/** One version in full; undefined when the id is unknown OR belongs to
 *  another frame, so a caller can never read across frames by id alone. */
export async function getFrameVersion(frameId: string, versionId: string): Promise<FrameVersion | undefined> {
  const [row] = await db
    .select()
    .from(t.frameVersions)
    .where(and(eq(t.frameVersions.id, versionId), eq(t.frameVersions.frameId, frameId)))
    .limit(1)
  if (!row) return undefined
  return {
    id: row.id,
    frameId: row.frameId,
    canvasId: row.canvasId,
    width: row.width,
    height: row.height,
    savedAt: row.savedAt,
    savedBy: row.savedBy,
    savedByKind: frameVersionKind(row.savedByKind),
    htmlBytes: row.html.length,
    ...(row.name ? { name: row.name } : {}),
    html: row.html,
  }
}

/* asset_refs is a projection of frame HTML: recompute this frame's full ref
   set on every durable write (never increment/decrement — nothing to drift).
   Boot reconciles the whole table, so a lost write here self-heals. */
async function syncAssetRefs(frameId: string, html: string, exec: Exec = db) {
  const ids = [...extractAssetIds(html)]
  await exec.delete(t.assetRefs).where(eq(t.assetRefs.frameId, frameId))
  if (ids.length) {
    await exec
      .insert(t.assetRefs)
      .values(ids.map((assetId) => ({ assetId, frameId })))
      .onConflictDoNothing()
  }
}

/** Store one run of check_design_completeness. Awaited by the caller: an
 *  attestation id is only handed out once its rows are in the database. */
export async function saveAttestationRows(rows: AttestationRow[]): Promise<void> {
  if (!rows.length) return
  await db.insert(t.designAttestations).values(rows.map((r) => ({ id: nanoid(), ...r })))
}

/** Every row of one run, oldest frame first; empty when there is no such run. */
export async function listAttestationRun(runId: string): Promise<AttestationRow[]> {
  const rows = await db.select().from(t.designAttestations).where(eq(t.designAttestations.runId, runId))
  return rows.map(({ id: _id, ...row }) => ({ ...row, result: row.result === 'complete' ? 'complete' : 'incomplete' }))
}

export function deleteCanvas(canvasId: string) {
  /* refs must go before the frames rows the subquery reads */
  swallow(
    db
      .delete(t.assetRefs)
      .where(
        inArray(
          t.assetRefs.frameId,
          db.select({ id: t.frames.id }).from(t.frames).where(eq(t.frames.canvasId, canvasId)),
        ),
      )
      .then(() => db.delete(t.frames).where(eq(t.frames.canvasId, canvasId))),
  )
  /* a queued task or feedback write (a run's reply, then its completion)
     would otherwise re-insert its row after the delete */
  swallow(pendingRowWrites(taskWrites, canvasId).then(() => db.delete(t.tasks).where(eq(t.tasks.canvasId, canvasId))))
  swallow(
    pendingRowWrites(feedbackWrites, canvasId).then(() =>
      db.delete(t.feedback).where(eq(t.feedback.canvasId, canvasId)),
    ),
  )
  swallow(db.delete(t.designAttestations).where(eq(t.designAttestations.canvasId, canvasId)))
  swallow(db.delete(t.comments).where(eq(t.comments.canvasId, canvasId)))
  swallow(db.delete(t.commentEvents).where(eq(t.commentEvents.canvasId, canvasId)))
  swallow(db.delete(t.canvasBridge).where(eq(t.canvasBridge.canvasId, canvasId)))
  swallow(db.delete(t.activity).where(eq(t.activity.canvasId, canvasId)))
  swallow(db.delete(t.guidelines).where(eq(t.guidelines.canvasId, canvasId)))
  swallow(
    pendingComponentWrites(canvasId).then(() => db.delete(t.components).where(eq(t.components.canvasId, canvasId))),
  )
  swallow(db.delete(t.libraryComponents).where(eq(t.libraryComponents.canvasId, canvasId)))
  swallow(db.delete(t.guidelineVersions).where(eq(t.guidelineVersions.canvasId, canvasId)))
  swallow(
    pendingTokenWrites(canvasId).then(() => db.delete(t.designTokens).where(eq(t.designTokens.canvasId, canvasId))),
  )
  swallow(
    pendingVersionWrites((_, c) => c === canvasId).then(() =>
      db.delete(t.frameVersions).where(eq(t.frameVersions.canvasId, canvasId)),
    ),
  )
  swallow(db.delete(t.pageSnapshots).where(eq(t.pageSnapshots.canvasId, canvasId)))
  swallow(db.delete(t.snapshotBlobs).where(eq(t.snapshotBlobs.canvasId, canvasId)))
  swallow(db.delete(t.memoryReferences).where(eq(t.memoryReferences.canvasId, canvasId)))
  swallow(db.delete(t.decisions).where(eq(t.decisions.canvasId, canvasId)))
  swallow(db.delete(t.memoryProposals).where(eq(t.memoryProposals.canvasId, canvasId)))
  swallow(db.delete(t.canvasMembers).where(eq(t.canvasMembers.canvasId, canvasId)))
  swallow(db.delete(t.canvases).where(eq(t.canvases.id, canvasId)))
}

/** The frame/element a prompt card was scoped to, or nothing when the row
 *  carries none or it no longer parses. */
function scopeField(scope: string | null): Pick<AgentTask, 'scope'> {
  if (!scope) return {}
  try {
    const parsed = JSON.parse(scope) as CardScope
    return typeof parsed?.frameId === 'string' ? { scope: parsed } : {}
  } catch {
    return {}
  }
}

/** The connection a card was sent to, or nothing when the row carries none
 *  or it no longer parses (the card then runs on the Settings default). */
function runnerField(runner: string | null): Pick<AgentTask, 'runner'> {
  if (!runner) return {}
  try {
    const parsed = parseRunnerPick(JSON.parse(runner))
    return parsed ? { runner: parsed } : {}
  } catch {
    return {}
  }
}

/** A structured card's kind + payload, or nothing when the row is a prompt
 *  card or its payload no longer parses (the card then reads as a plain one). */
function repoCardFields(kind: string | null, payload: string | null): Pick<AgentTask, 'kind' | 'payload'> {
  if (!kind || !payload) return {}
  try {
    return { kind: kind as RepoCardKind, payload: JSON.parse(payload) as RepoCardPayload }
  } catch {
    return {}
  }
}

/* Task rows are written as whole snapshots and never awaited by callers, so
   two quick edits could otherwise race on the pool and leave the older one
   in the table. Writes to the same task queue behind each other instead. */
/* queued writes per row id, with the canvas each belongs to, so deleting a
   canvas can wait for its rows' writes instead of having one land after */
interface QueuedWrite {
  canvasId: string
  write: Promise<unknown>
}

/** Chain `write` after the row's earlier writes, in order. */
function queueRowWrite(queue: Map<string, QueuedWrite>, id: string, canvasId: string, write: () => Promise<unknown>) {
  const queued = (queue.get(id)?.write ?? Promise.resolve()).then(write, write)
  queue.set(id, { canvasId, write: queued })
  swallow(queued.finally(() => queue.get(id)?.write === queued && queue.delete(id)))
}

/** Settles once every write queued so far for this canvas's rows has. */
function pendingRowWrites(queue: Map<string, QueuedWrite>, canvasId: string): Promise<unknown> {
  return Promise.allSettled([...queue.values()].filter((q) => q.canvasId === canvasId).map((q) => q.write))
}

const taskWrites = new Map<string, QueuedWrite>()

export function saveTask(canvasId: string, task: AgentTask) {
  const row = {
    id: task.id,
    canvasId,
    agentName: task.agentName,
    owner: task.owner ?? null,
    color: task.color,
    status: task.status,
    startedAt: task.startedAt,
    endedAt: task.endedAt ?? null,
    auto: task.auto ?? false,
    queuedBy: task.queuedBy ?? null,
    queuedByUserId: task.queuedByUserId ?? null,
    claimedAt: task.claimedAt ?? null,
    failedAt: task.failedAt ?? null,
    failureReason: task.failureReason ?? null,
    pipeline: task.pipeline?.join(',') ?? null,
    stage: task.stage ?? null,
    attachments: task.attachments?.join(',') ?? null,
    kind: task.kind ?? null,
    payload: task.payload ? JSON.stringify(task.payload) : null,
    scope: task.scope ? JSON.stringify(task.scope) : null,
    frameIds: task.frameIds?.join(',') ?? null,
    runner: task.runner ? JSON.stringify(task.runner) : null,
    reply: task.reply ?? null,
    multicaTaskId: task.multicaTaskId ?? null,
  }
  const write = () =>
    db
      .insert(t.tasks)
      .values(row)
      .onConflictDoUpdate({
        target: t.tasks.id,
        set: {
          endedAt: row.endedAt,
          status: row.status,
          agentName: row.agentName,
          color: row.color,
          claimedAt: row.claimedAt,
          failedAt: row.failedAt,
          failureReason: row.failureReason,
          pipeline: row.pipeline,
          stage: row.stage,
          frameIds: row.frameIds,
          reply: row.reply,
        },
      })
  queueRowWrite(taskWrites, task.id, canvasId, write)
}

/* One feedback row is often saved twice in a row (its reply, then its
   completion), and each write carries the whole state. Without an order the
   older write can land last and undo the newer one, so writes per row queue. */
const feedbackWrites = new Map<string, QueuedWrite>()

export function saveFeedback(fb: TaskFeedback) {
  const row = {
    id: fb.id,
    taskId: fb.taskId,
    canvasId: fb.canvasId,
    agentName: fb.agentName,
    targetAgent: fb.targetAgent ?? null,
    fromName: fb.from,
    fromUserId: fb.fromUserId ?? null,
    text: fb.text,
    at: fb.at,
    deliveredAt: fb.deliveredAt ?? null,
    claimedBy: fb.claimedBy ?? null,
    claimedByResident: fb.claimedByResident ?? null,
    completedAt: fb.completedAt ?? null,
    failedAt: fb.failedAt ?? null,
    failureReason: fb.failureReason ?? null,
    runner: fb.runner ? JSON.stringify(fb.runner) : null,
    reply: fb.reply ?? null,
  }
  const write = () =>
    db
      .insert(t.feedback)
      .values(row)
      .onConflictDoUpdate({
        target: t.feedback.id,
        set: {
          deliveredAt: row.deliveredAt,
          claimedBy: row.claimedBy,
          claimedByResident: row.claimedByResident,
          completedAt: row.completedAt,
          failedAt: row.failedAt,
          failureReason: row.failureReason,
          reply: row.reply,
        },
      })
  queueRowWrite(feedbackWrites, fb.id, fb.canvasId, write)
}

type CommentRow = typeof t.comments.$inferSelect

/** A stored comment as the in-memory log holds it; `fail` overrides the failure columns (boot recovery). */
function commentFromRow(
  row: CommentRow,
  fail: { failedAt?: number | undefined; failureReason?: string | undefined } = {
    failedAt: row.failedAt ?? undefined,
    failureReason: row.failureReason ?? undefined,
  },
): ElementComment {
  const { failedAt, failureReason } = fail
  return {
    id: row.id,
    canvasId: row.canvasId,
    ...(row.frameId != null ? { frameId: row.frameId } : {}),
    ...(row.elementId != null ? { elementId: row.elementId } : {}),
    ...(row.elementOrigin != null ? { elementOrigin: row.elementOrigin } : {}),
    snippet: row.snippet,
    ...(row.pageId != null ? { pageId: row.pageId } : {}),
    ...(row.x != null ? { x: row.x } : {}),
    ...(row.y != null ? { y: row.y } : {}),
    from: row.fromName,
    ...(row.fromUserId != null ? { fromUserId: row.fromUserId } : {}),
    text: row.text,
    at: row.at,
    ...(row.forAgent ? { forAgent: true } : {}),
    ...(row.targetAgent != null ? { targetAgent: row.targetAgent } : {}),
    ...(row.claimedBy != null ? { claimedBy: row.claimedBy } : {}),
    ...(row.claimedAt != null ? { claimedAt: row.claimedAt } : {}),
    ...(failedAt !== undefined ? { failedAt } : {}),
    ...(failureReason !== undefined ? { failureReason } : {}),
    ...(row.resolvedBy != null ? { resolvedBy: row.resolvedBy } : {}),
    ...(row.resolvedAt != null ? { resolvedAt: row.resolvedAt } : {}),
    ...(row.resolution === 'addressed' || row.resolution === 'wont_fix' || row.resolution === 'moved'
      ? { resolution: row.resolution }
      : {}),
    ...(row.resolutionRef != null ? { resolutionRef: row.resolutionRef } : {}),
    ...(row.resolutionNote != null ? { resolutionNote: row.resolutionNote } : {}),
    ...(row.parentId != null ? { parentId: row.parentId } : {}),
    ...(row.clientRequestId != null ? { clientRequestId: row.clientRequestId } : {}),
  }
}

function commentRow(c: ElementComment) {
  return {
    id: c.id,
    canvasId: c.canvasId,
    frameId: c.frameId ?? null,
    elementId: c.elementId ?? null,
    elementOrigin: c.elementOrigin ?? null,
    /* the pre-element-id anchor is spent once the comment is saved again */
    selector: null,
    snippet: c.snippet,
    pageId: c.pageId ?? null,
    x: c.x ?? null,
    y: c.y ?? null,
    fromName: c.from,
    fromUserId: c.fromUserId ?? null,
    text: c.text,
    at: c.at,
    forAgent: c.forAgent ?? false,
    targetAgent: c.targetAgent ?? null,
    claimedBy: c.claimedBy ?? null,
    claimedAt: c.claimedAt ?? null,
    failedAt: c.failedAt ?? null,
    failureReason: c.failureReason ?? null,
    resolvedBy: c.resolvedBy ?? null,
    resolvedAt: c.resolvedAt ?? null,
    resolution: c.resolution ?? null,
    resolutionRef: c.resolutionRef ?? null,
    resolutionNote: c.resolutionNote ?? null,
    parentId: c.parentId ?? null,
    clientRequestId: c.clientRequestId ?? null,
  }
}

export function saveComment(c: ElementComment) {
  swallow(writeComment(c))
}

/** The comment's write, for a caller that must know it landed. */
export function saveCommentNow(c: ElementComment): Promise<void> {
  return writeComment(c)
}

/* the tail of each comment's writes still out: the next write for that id waits
   for it, so they land in the order they were made, whichever call awaits */
const commentWrites = new Map<string, Promise<void>>()

/** The row is taken now; its write runs after every earlier write of the same
 *  comment, so a slow write with an old copy cannot land over a newer one. */
function writeComment(c: ElementComment): Promise<void> {
  const row = commentRow(c)
  const write = (commentWrites.get(c.id) ?? Promise.resolve()).then(() => upsertComment(row))
  trackCommentWrite(row.frameId, write)
  const tail = write.catch(() => {})
  commentWrites.set(c.id, tail)
  void tail.then(() => commentWrites.get(c.id) === tail && commentWrites.delete(c.id))
  return write
}

async function upsertComment(row: ReturnType<typeof commentRow>): Promise<void> {
  await db
    .insert(t.comments)
    .values(row)
    .onConflictDoUpdate({
      target: t.comments.id,
      set: {
        /* a moved thread keeps its id and takes a new anchor */
        frameId: row.frameId,
        elementId: row.elementId,
        elementOrigin: row.elementOrigin,
        selector: row.selector,
        snippet: row.snippet,
        pageId: row.pageId,
        x: row.x,
        y: row.y,
        /* a request handed back to the person is no longer the agent's */
        forAgent: row.forAgent,
        claimedBy: row.claimedBy,
        claimedAt: row.claimedAt,
        failedAt: row.failedAt,
        failureReason: row.failureReason,
        resolvedBy: row.resolvedBy,
        resolvedAt: row.resolvedAt,
        /* an unresolve clears all three with the resolved stamp */
        resolution: row.resolution,
        resolutionRef: row.resolutionRef,
        resolutionNote: row.resolutionNote,
      },
    })
}

/** A retry key reused with other text in the same thread. */
export class ClientRequestConflictError extends Error {
  constructor(readonly clientRequestId: string) {
    super(`client_request_id ${clientRequestId} was already used in this thread with different text`)
    this.name = 'ClientRequestConflictError'
  }
}

/** A NEW comment: the row and its comment_events row in ONE transaction. Unlike
 *  the write-through saves it is awaited and its failure is thrown, so the
 *  request fails and neither row is stored.
 *
 *  A keyed reply (`clientRequestId`) is stored at most once per thread: the
 *  insert yields to the unique index, and the stored text is compared in the
 *  same transaction. Returns undefined when stored, the first reply when the
 *  key and text repeat, and throws ClientRequestConflictError when the text
 *  differs. Two concurrent callers queue on the index entry, so one inserts
 *  and the other reads the committed row. */
export function saveNewComment(c: ElementComment, actorKind: ActorKind = 'user'): Promise<ElementComment | undefined> {
  const write = insertNewComment(c, actorKind)
  trackCommentWrite(c.frameId, write)
  return write
}

async function insertNewComment(c: ElementComment, actorKind: ActorKind): Promise<ElementComment | undefined> {
  return db.transaction(async (tx) => {
    if (c.clientRequestId !== undefined && c.parentId !== undefined) {
      const inserted = await tx
        .insert(t.comments)
        .values(commentRow(c))
        .onConflictDoNothing({
          target: [t.comments.parentId, t.comments.clientRequestId],
          where: sql`${t.comments.clientRequestId} is not null`,
        })
        .returning({ id: t.comments.id })
      if (inserted.length === 0) {
        const [first] = await tx
          .select()
          .from(t.comments)
          .where(and(eq(t.comments.parentId, c.parentId), eq(t.comments.clientRequestId, c.clientRequestId)))
          .limit(1)
        if (!first) throw new Error('keyed comment insert yielded to a row that is gone')
        if (first.text !== c.text) throw new ClientRequestConflictError(c.clientRequestId)
        return commentFromRow(first)
      }
    } else {
      await tx.insert(t.comments).values(commentRow(c))
    }
    await tx.insert(t.commentEvents).values({
      canvasId: c.canvasId,
      commentId: c.id,
      parentId: c.parentId ?? null,
      fromUserId: c.fromUserId ?? null,
      actorKind,
      at: c.at,
    })
    return undefined
  })
}

/** The reply stored under this retry key in a thread, if any. */
export async function findReplyByRequestId(
  rootId: string,
  clientRequestId: string,
): Promise<ElementComment | undefined> {
  const [row] = await db
    .select()
    .from(t.comments)
    .where(and(eq(t.comments.parentId, rootId), eq(t.comments.clientRequestId, clientRequestId)))
    .limit(1)
  return row ? commentFromRow(row) : undefined
}

/** One stored comment by id, for ids that have left the in-memory window. */
export async function findCommentRow(commentId: string): Promise<ElementComment | undefined> {
  const [row] = await db.select().from(t.comments).where(eq(t.comments.id, commentId)).limit(1)
  return row ? commentFromRow(row) : undefined
}

/** The whole thread the comment belongs to (root and every reply), oldest first. */
export async function loadCommentThread(commentId: string): Promise<ElementComment[]> {
  const found = await findCommentRow(commentId)
  if (!found) return []
  const rootId = found.parentId ?? found.id
  const rows = await db
    .select()
    .from(t.comments)
    .where(or(eq(t.comments.id, rootId), eq(t.comments.parentId, rootId)))
    .orderBy(asc(t.comments.at))
  return rows.map((row) => commentFromRow(row))
}

export interface CommentEvent {
  id: number
  canvasId: string
  commentId: string
  parentId: string | null
  fromUserId: string | null
  /** Null on events written before the column existed. */
  actorKind: ActorKind | null
  at: number
  comment: ElementComment
}

/** Events nobody has acknowledged yet, oldest id first, with their comment. No
 *  cursor: an event that commits late is still unacknowledged on the next read. */
export async function listUnackedCommentEvents(canvasId: string, limit: number): Promise<CommentEvent[]> {
  const rows = await db
    .select({ event: t.commentEvents, comment: t.comments })
    .from(t.commentEvents)
    .innerJoin(t.comments, eq(t.comments.id, t.commentEvents.commentId))
    .where(and(eq(t.commentEvents.canvasId, canvasId), isNull(t.commentEvents.ackedAt)))
    .orderBy(asc(t.commentEvents.id))
    .limit(limit)
  return rows.map(({ event, comment }) => ({
    id: event.id,
    canvasId: event.canvasId,
    commentId: event.commentId,
    parentId: event.parentId,
    fromUserId: event.fromUserId,
    actorKind: event.actorKind,
    at: event.at,
    comment: commentFromRow(comment),
  }))
}

/** Acknowledge events by id, only those on canvases `canAck` allows. Returns the
 *  ids now acknowledged; an already-acknowledged id is not an error. */
export async function ackCommentEvents(ids: number[], canAck: (canvasId: string) => boolean): Promise<number[]> {
  if (ids.length === 0) return []
  const found = await db
    .select({ id: t.commentEvents.id, canvasId: t.commentEvents.canvasId })
    .from(t.commentEvents)
    .where(inArray(t.commentEvents.id, ids))
  const allowed = found.filter((e) => canAck(e.canvasId)).map((e) => e.id)
  if (allowed.length === 0) return []
  await db
    .update(t.commentEvents)
    .set({ ackedAt: Date.now() })
    .where(and(inArray(t.commentEvents.id, allowed), isNull(t.commentEvents.ackedAt)))
  return allowed
}

export function saveActivity(canvasId: string, item: ActivityItem) {
  swallow(
    db.insert(t.activity).values({
      id: item.id,
      canvasId,
      actorName: item.actorName,
      actorKind: item.actorKind,
      actorColor: item.actorColor,
      message: item.message,
      frameId: item.frameId ?? null,
      at: item.at,
    }),
  )
}

/** Flush pending debounced frame writes and queued version writes (called
 *  on shutdown): a design must not survive a restart without its history. */
export async function flush(getFrame: (id: string) => Frame | undefined): Promise<void> {
  /* every dirty frame, a failed write included, not only the debounced ones */
  const ids = [...dirtyFrames.keys()]
  for (const [, timer] of frameTimers) clearTimeout(timer)
  frameTimers.clear()
  await Promise.allSettled(
    ids.map((id) => {
      const f = getFrame(id)
      return f ? writeFrame(f) : Promise.resolve()
    }),
  )
  await pendingVersionWrites(() => true)
  draining = true
  for (const wake of [...retryWaits]) wake()
  await pendingComponentWrites()
}

/* ------------------------------------------------------------------ */
/* Boot hydration                                                     */
/* ------------------------------------------------------------------ */

export interface Hydrated {
  canvases: Canvas[]
  tasks: Map<string, AgentTask[]> // canvasId -> newest first
  feedback: Map<string, TaskFeedback[]>
  comments: Map<string, ElementComment[]>
  /** comment id -> the positional CSS path an element comment was anchored
   *  by before element ids; `backfillElementIds` turns each into a stamp */
  legacyCommentSelectors: Map<string, string>
  activity: Map<string, ActivityItem[]>
  decisions: Map<string, DesignDecision[]>
  proposals: Map<string, MemoryProposal[]>
  /** soft-deleted frames and pages per canvas, kept out of `canvases[].frames` */
  trash: Map<string, { frames: Frame[]; pages: DeletedPage[] }>
}

const LOG_CAP = 100

export async function hydrate(): Promise<Hydrated> {
  const [
    canvasRows,
    frameRows,
    taskRows,
    feedbackRows,
    commentRows,
    activityRows,
    guidelineRows,
    componentRows,
    tokenRows,
    referenceRows,
    decisionRows,
    proposalRows,
    memberRows,
  ] = await Promise.all([
    db.select().from(t.canvases),
    /* every column but html: frame HTML is most of the database and loads
       per canvas when something needs it (store.load) */
    db.select(frameMetaColumns).from(t.frames),
    db.select().from(t.tasks).orderBy(desc(t.tasks.startedAt)),
    db.select().from(t.feedback).orderBy(desc(t.feedback.at)),
    db.select().from(t.comments).orderBy(desc(t.comments.at)),
    db.select().from(t.activity).orderBy(desc(t.activity.at)),
    db.select().from(t.guidelines).orderBy(t.guidelines.name),
    db.select().from(t.components).orderBy(t.components.name),
    db.select().from(t.designTokens).orderBy(t.designTokens.order, t.designTokens.name),
    db.select().from(t.memoryReferences).orderBy(desc(t.memoryReferences.pinnedAt)),
    db.select().from(t.decisions).orderBy(desc(t.decisions.at)),
    db.select().from(t.memoryProposals).orderBy(desc(t.memoryProposals.at)),
    db.select().from(t.canvasMembers).orderBy(t.canvasMembers.addedAt),
  ])

  const canvases: Canvas[] = canvasRows.map((c) => ({
    id: c.id,
    name: c.name,
    pages: c.pages ?? undefined,
    ...(c.guides?.length ? { guides: c.guides } : {}),
    ...(c.tokenThemes?.length ? { tokenThemes: c.tokenThemes } : {}),
    ownerId: c.ownerId ?? undefined,
    /* 'view' / 'comment' / 'edit'; null and anything unknown read as private */
    linkAccess: storedLinkAccess(c.linkAccess),
    ...(c.publishedAt != null ? { publishedAt: c.publishedAt } : {}),
    ...(c.description ? { description: c.description } : {}),
    ...(isCommunityCategory(c.category) ? { category: c.category } : {}),
    ...(c.copyCount ? { copyCount: c.copyCount } : {}),
    ...(c.workspaceId ? { workspaceId: c.workspaceId } : {}),
    ...(c.projectId ? { projectId: c.projectId } : {}),
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    frames: [],
  }))
  const byId = new Map(canvases.map((c) => [c.id, c]))
  for (const m of memberRows) {
    const c = byId.get(m.canvasId)
    if (c) (c.memberIds ??= []).push(m.userId)
  }
  const trash = new Map<string, { frames: Frame[]; pages: DeletedPage[] }>()
  const trashOf = (canvasId: string) => {
    let entry = trash.get(canvasId)
    if (!entry) trash.set(canvasId, (entry = { frames: [], pages: [] }))
    return entry
  }
  for (const c of canvasRows) if (c.deletedPages?.length) trashOf(c.id).pages = c.deletedPages
  for (const { deletedAt, ...f } of frameRows) {
    const frame = {
      ...f,
      pageId: f.pageId ?? undefined,
      demo: f.demo ?? undefined,
      hidden: f.hidden ?? undefined,
      locked: f.locked ?? undefined,
      lockEpoch: f.lockEpoch ?? undefined,
      lockAttestationId: f.lockAttestationId ?? undefined,
      z: f.z ?? undefined,
      rotation: f.rotation ?? undefined,
      ...(deletedAt != null ? { deletedAt } : {}),
    } as Frame
    unloadHtml(frame)
    if (deletedAt != null) {
      if (byId.has(f.canvasId)) trashOf(f.canvasId).frames.push(frame)
    } else byId.get(f.canvasId)?.frames.push(frame)
  }
  for (const c of canvases) c.frames.sort(byStack)
  for (const r of referenceRows) {
    const c = byId.get(r.canvasId)
    if (!c) continue
    ;(c.references ??= []).push({
      id: r.id,
      frameId: r.frameId,
      title: r.title,
      html: r.html,
      width: r.width,
      height: r.height,
      pinnedBy: r.pinnedBy,
      pinnedAt: r.pinnedAt,
    })
  }
  for (const row of componentRows) {
    const c = byId.get(row.canvasId)
    if (!c) continue
    const { canvasId: _canvasId, code, source, status, deletedAt, deletedBy, ...def } = row
    ;(c.components ??= []).push({
      ...def,
      ...(code ? { code } : {}),
      ...(source ? { source } : {}),
      ...(status === 'deleted' ? { status, deletedAt: deletedAt ?? def.updatedAt, deletedBy: deletedBy ?? '' } : {}),
    })
  }
  for (const g of guidelineRows) {
    const c = byId.get(g.canvasId)
    if (!c) continue
    ;(c.guidelines ??= []).push({
      name: g.name,
      markdown: g.markdown,
      ...(g.title != null ? { title: g.title } : {}),
      updatedAt: g.updatedAt,
      updatedBy: g.updatedBy,
      ...(g.x != null ? { x: g.x } : {}),
      ...(g.y != null ? { y: g.y } : {}),
    })
  }
  for (const row of tokenRows) {
    const c = byId.get(row.canvasId)
    if (!c) continue
    ;(c.tokens ??= []).push({
      name: row.name,
      type: row.type as TokenType,
      value: row.value,
      ...(row.themes && Object.keys(row.themes).length ? { themes: row.themes } : {}),
      ...(row.description != null ? { description: row.description } : {}),
      order: row.order,
      updatedAt: row.updatedAt,
      updatedBy: row.updatedBy,
    })
  }

  const now = Date.now()
  const interruptedReason = 'The agent stopped before finishing. Retry when you are ready.'
  const tasks = new Map<string, AgentTask[]>()
  for (const row of taskRows) {
    const list = tasks.get(row.canvasId) ?? []
    /* A task still open across a restart belongs to an agent that's gone.
       Ordinary status tasks close; claimed board cards pause in a visible
       failed state and require a human retry. */
    const isOpenCard = row.queuedBy != null && row.endedAt == null
    /* the cap bounds history, never open work: an unfinished card older than
       the newest hundred rows still belongs on the board (same rule as
       actions.trimTaskLog keeps in memory) */
    if (list.length >= LOG_CAP && !isOpenCard) continue
    const endedAt = isOpenCard ? undefined : (row.endedAt ?? now)
    const interruptedCard = isOpenCard && !!row.agentName
    const failedAt = row.failedAt ?? (interruptedCard ? now : undefined)
    const failureReason = row.failureReason ?? (interruptedCard ? interruptedReason : undefined)
    if (row.endedAt == null && !isOpenCard) swallow(db.update(t.tasks).set({ endedAt }).where(eq(t.tasks.id, row.id)))
    if (interruptedCard && row.failedAt == null) {
      swallow(db.update(t.tasks).set({ failedAt, failureReason }).where(eq(t.tasks.id, row.id)))
    }
    list.push({
      id: row.id,
      agentName: row.agentName,
      ...(row.owner != null ? { owner: row.owner } : {}),
      color: row.color,
      status: row.status,
      startedAt: row.startedAt,
      ...(endedAt !== undefined ? { endedAt } : {}),
      ...(row.auto ? { auto: true } : {}),
      ...(row.queuedBy != null ? { queuedBy: row.queuedBy } : {}),
      ...(row.queuedByUserId != null ? { queuedByUserId: row.queuedByUserId } : {}),
      ...(row.claimedAt != null ? { claimedAt: row.claimedAt } : {}),
      ...(failedAt !== undefined ? { failedAt } : {}),
      ...(failureReason !== undefined ? { failureReason } : {}),
      ...(row.pipeline ? { pipeline: row.pipeline.split(',').filter(Boolean) } : {}),
      ...(row.stage != null ? { stage: row.stage } : {}),
      ...(row.attachments ? { attachments: row.attachments.split(',').filter(Boolean) } : {}),
      ...repoCardFields(row.kind, row.payload),
      ...scopeField(row.scope),
      ...(row.frameIds ? { frameIds: row.frameIds.split(',').filter(Boolean) } : {}),
      ...runnerField(row.runner),
      ...(row.reply != null ? { reply: row.reply } : {}),
      ...(row.multicaTaskId ? { multicaTaskId: row.multicaTaskId } : {}),
    })
    tasks.set(row.canvasId, list)
  }

  const feedback = new Map<string, TaskFeedback[]>()
  for (const row of feedbackRows) {
    const list = feedback.get(row.canvasId) ?? []
    if (list.length >= LOG_CAP) continue
    /* only resident runs are in-process; feedback claimed by an outside MCP
       agent may still be in flight elsewhere, so it is left alone. The claim
       records which it was, since a custom agent may share an outside agent's
       name; a claim from before that record could only be a built-in's */
    const interrupted =
      (row.claimedByResident ?? roleByAgentName(row.claimedBy ?? undefined, AGENT_ROLES) != null) &&
      row.deliveredAt != null &&
      row.completedAt == null &&
      row.failedAt == null
    const failedAt = row.failedAt ?? (interrupted ? now : undefined)
    const failureReason = row.failureReason ?? (interrupted ? interruptedReason : undefined)
    if (interrupted) swallow(db.update(t.feedback).set({ failedAt, failureReason }).where(eq(t.feedback.id, row.id)))
    list.push({
      id: row.id,
      taskId: row.taskId,
      canvasId: row.canvasId,
      agentName: row.agentName,
      ...(row.targetAgent != null ? { targetAgent: row.targetAgent } : {}),
      from: row.fromName,
      ...(row.fromUserId != null ? { fromUserId: row.fromUserId } : {}),
      ...runnerField(row.runner),
      text: row.text,
      at: row.at,
      ...(row.deliveredAt != null ? { deliveredAt: row.deliveredAt } : {}),
      ...(row.claimedBy != null ? { claimedBy: row.claimedBy } : {}),
      ...(row.claimedByResident != null ? { claimedByResident: row.claimedByResident } : {}),
      ...(row.completedAt != null ? { completedAt: row.completedAt } : {}),
      ...(failedAt !== undefined ? { failedAt } : {}),
      ...(failureReason !== undefined ? { failureReason } : {}),
      ...(row.reply != null ? { reply: row.reply } : {}),
    })
    feedback.set(row.canvasId, list)
  }

  const comments = new Map<string, ElementComment[]>()
  const legacyCommentSelectors = new Map<string, string>()
  for (const row of commentRows) {
    /* every legacy anchor is backfilled, also on a comment older than the
       window: it is restored from its row later, and resolving it would
       otherwise save the row again without its selector */
    if (row.elementId == null && row.frameId != null && row.selector && row.selector !== 'body') {
      legacyCommentSelectors.set(row.id, row.selector)
    }
    const list = comments.get(row.canvasId) ?? []
    if (list.length >= LOG_CAP) continue
    const interrupted = row.claimedBy != null && row.resolvedAt == null && row.failedAt == null
    const failedAt = row.failedAt ?? (interrupted ? now : undefined)
    const failureReason = row.failureReason ?? (interrupted ? interruptedReason : undefined)
    if (interrupted) swallow(db.update(t.comments).set({ failedAt, failureReason }).where(eq(t.comments.id, row.id)))
    list.push(commentFromRow(row, { failedAt, failureReason }))
    comments.set(row.canvasId, list)
  }

  const activity = new Map<string, ActivityItem[]>()
  for (const row of activityRows) {
    const list = activity.get(row.canvasId) ?? []
    if (list.length >= LOG_CAP) continue
    list.push({
      id: row.id,
      actorName: row.actorName,
      actorKind: row.actorKind as ActivityItem['actorKind'],
      actorColor: row.actorColor,
      message: row.message,
      frameId: row.frameId ?? undefined,
      at: row.at,
    })
    activity.set(row.canvasId, list)
  }

  const decisions = new Map<string, DesignDecision[]>()
  for (const row of decisionRows) {
    const list = decisions.get(row.canvasId) ?? []
    if (list.length >= LOG_CAP) continue
    list.push({
      id: row.id,
      text: row.text,
      ...(row.summary != null ? { summary: row.summary } : {}),
      source: row.source as DesignDecision['source'],
      ...(row.frameId != null ? { frameId: row.frameId } : {}),
      from: row.fromName,
      ...(row.agentName != null ? { agentName: row.agentName } : {}),
      at: row.at,
      ...(row.distilledAt != null ? { distilledAt: row.distilledAt } : {}),
    })
    decisions.set(row.canvasId, list)
  }

  const proposals = new Map<string, MemoryProposal[]>()
  for (const row of proposalRows) {
    const list = proposals.get(row.canvasId) ?? []
    if (list.length >= LOG_CAP) continue
    list.push({
      id: row.id,
      guideName: row.guideName,
      ...(row.guideTitle != null ? { guideTitle: row.guideTitle } : {}),
      rule: row.rule,
      rationale: row.rationale,
      basedOn: row.basedOn.split(',').filter(Boolean),
      at: row.at,
      status: row.status as MemoryProposal['status'],
      ...(row.resolvedBy != null ? { resolvedBy: row.resolvedBy } : {}),
      ...(row.resolvedAt != null ? { resolvedAt: row.resolvedAt } : {}),
    })
    proposals.set(row.canvasId, list)
  }

  return { canvases, tasks, feedback, comments, legacyCommentSelectors, activity, decisions, proposals, trash }
}

/** One-time import of the pre-DB data/store.json so existing canvases survive. */
export async function importLegacyJson(): Promise<Canvas[] | null> {
  const file = path.join(process.cwd(), 'data', 'store.json')
  let parsed: Canvas[]
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null
  for (const c of parsed) {
    await db
      .insert(t.canvases)
      .values({ id: c.id, name: c.name, createdAt: c.createdAt, updatedAt: c.updatedAt })
      .onConflictDoNothing()
    for (const f of c.frames) await writeFrame(f)
  }
  fs.renameSync(file, `${file}.imported`)
  console.log(`[db] imported ${parsed.length} canvas(es) from legacy store.json`)
  return parsed
}

/* Lock pins (CHE-7062, G5b). `frame_pins` is the truth; `frame_pin_frames` holds one row per frame of an active
   pin, its primary key being what stops two pins from holding one frame even across processes. */
function pinRowOf(pin: Pin) {
  return {
    cardRequestId: pin.cardRequestId,
    pinId: pin.pinId,
    state: pin.state,
    frames: pin.frames,
    pickRequestId: pin.pickRequestId ?? null,
    pickedFrameId: pin.pickedFrameId ?? null,
    r1: pin.r1 ?? null,
    r2: pin.r2 ?? null,
    releaseReason: pin.releaseReason ?? null,
    stateChangedAt: pin.stateChangedAt,
    createdAt: pin.createdAt,
  }
}

export async function loadPins(): Promise<Pin[]> {
  const rows = await db.select().from(t.framePins)
  return rows.map((r) => ({
    cardRequestId: r.cardRequestId,
    pinId: r.pinId,
    state: r.state,
    frames: r.frames,
    ...(r.pickRequestId ? { pickRequestId: r.pickRequestId } : {}),
    ...(r.pickedFrameId ? { pickedFrameId: r.pickedFrameId } : {}),
    ...(r.r1 ? { r1: r.r1 } : {}),
    ...(r.r2 ? { r2: r.r2 } : {}),
    ...(r.releaseReason ? { releaseReason: r.releaseReason } : {}),
    stateChangedAt: r.stateChangedAt,
    createdAt: r.createdAt,
  }))
}

/** One transaction per pin step. `insert` takes the active rows with it; a RELEASED pin gives them up and may raise
 *  the epoch of its frames in the same commit (F1 on a void card). */
export async function writePin(pin: Pin, mode: 'insert' | 'update', epochs: { frameId: string; epoch: number }[] = []) {
  await db.transaction(async (tx) => {
    if (mode === 'insert') {
      await tx.insert(t.framePins).values(pinRowOf(pin))
      await tx
        .insert(t.framePinFrames)
        .values(pin.frames.map((f) => ({ frameId: f.frameId, cardRequestId: pin.cardRequestId })))
    } else {
      const { cardRequestId, ...set } = pinRowOf(pin)
      await tx.update(t.framePins).set(set).where(eq(t.framePins.cardRequestId, cardRequestId))
      if (pin.state === 'RELEASED')
        await tx.delete(t.framePinFrames).where(eq(t.framePinFrames.cardRequestId, cardRequestId))
    }
    for (const e of epochs) await tx.update(t.frames).set({ lockEpoch: e.epoch }).where(eq(t.frames.id, e.frameId))
  })
}
