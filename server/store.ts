import { nanoid } from 'nanoid'
import {
  ARCHIVE_PAGE_ID,
  ARCHIVE_PAGE_NAME,
  pageOrder,
  canvasPages,
  copyPageName,
  defaultWritePageId,
  framePageId,
  pageFrames,
  recoveryPageId,
  samePages,
} from '../shared/pages.ts'
import { defaultSpot } from './frameLayout.ts'
import * as persist from './db/persist.ts'
import { exclusive, isPinned, pinHooks } from './pinState.ts'
import { assertWritable, FrameLockedError, PolicyRefused, type WriteContext } from './writePolicy.ts'
import { assertPagesOpen, restoring } from './pageState.ts'
import type { LinkAccess } from '../shared/canvasRole.ts'
import { MAX_GUIDES } from '../shared/guides.ts'
import { remapFrameTargets } from '../shared/prototype.ts'
import type { ComponentDef } from '../shared/components.ts'
import { byStack, frontOf, stackOf } from '../shared/frameStack.ts'
import { htmlLoaded, setHtml, setHtmlMissHandler, unloadHtml, withHtml } from './frameHtml.ts'
import { afterCommit, inTransaction, recordUndo, requireBoundary } from './journal.ts'
import type { DesignToken } from '../shared/designTokens.ts'
import { deriveDesignLinks, isUuid, type DesignIssue } from '../shared/pageIssue.ts'
import type {
  Canvas,
  CanvasGuide,
  CanvasPageInfo,
  CommunityCategory,
  DeletedPage,
  Frame,
  GuidelineDoc,
  MemoryReference,
  ServerMessage,
} from '../shared/types.ts'
import type { PurgeReceipt } from './db/purge.ts'

export { FrameLockedError }

export const MAX_PAGES = 100

export class PageLimitError extends Error {
  constructor() {
    super(`A canvas holds at most ${MAX_PAGES} pages.`)
  }
}

export class GuideLimitError extends Error {
  constructor() {
    super(`A canvas holds at most ${MAX_GUIDES} guides.`)
  }
}

/** Frame columns a lock protects. `store.updateFrame` and `persist.writeFrame` share this list. */
export const DESIGN_KEYS = ['html', 'width', 'height'] as const

/** A new frame, or a restored one whose page is gone, has no page to go to: every page is the ledger, Finished or
 *  Archive (CHE-9398 L1). Nothing is written. REST answers 409 `no_open_page`, MCP an error. */
export const NO_OPEN_PAGE = 'no open page: pass page_id'
export class NoOpenPageError extends Error {
  override readonly name = 'NoOpenPageError'
  readonly code = 'no_open_page'
  constructor() {
    super(NO_OPEN_PAGE)
  }
}

/** A conditional write whose `expectedUpdatedAt` no longer matches the frame. Carries the current frame. */
export class FrameStaleError extends Error {
  override readonly name = 'FrameStaleError'
  constructor(readonly frame: Frame) {
    super(
      `Frame "${frame.name}" (${frame.id}) changed since you read it (updatedAt is ${frame.updatedAt}). Re-read it and retry.`,
    )
  }
}

/** A write reached a frame that sits in the trash (CHE-5306). The message
 *  names the frame so a person or an agent knows what to restore. */
export class FrameDeletedError extends Error {
  constructor(frame: Pick<Frame, 'id' | 'name'>) {
    super(`Frame “${frame.name}” (${frame.id}) is deleted; restore it before changing it.`)
  }
}

/** A restore reached a frame that is being deleted forever (CHE-9399). Nothing changed. This is not a policy refusal:
 *  the same person may try again once the purge ends, so REST answers 409 and not 423. */
export class PurgeInProgressError extends Error {
  override readonly name = 'PurgeInProgressError'
  readonly code = 'purge_in_progress'
  constructor(readonly frameId: string) {
    super(`purge_in_progress: frame ${frameId} is being deleted forever; nothing changed`)
  }
}

/** `beginPurge` turned the purge away before it changed anything. */
export type PurgeRefusalCode = 'not_in_trash' | 'stale_confirmation' | 'has_comments' | 'component_main'
export class PurgeRefusedError extends Error {
  override readonly name = 'PurgeRefusedError'
  constructor(
    readonly code: PurgeRefusalCode,
    readonly frameId: string,
  ) {
    super(`purge_refused: ${code} (frame ${frameId}); nothing changed`)
  }
}

/** What the lease tells the room: a Trash frame's purge state, and its end. */
export type PurgeEvent = Extract<ServerMessage, { type: 'trash:purge_state' | 'frame:purged' }>

/** One open "delete forever" on a Trash frame. `release()` calls it off; the finalizer (`actions.finishCommitted`)
 *  ends it for good. The persist fence under it holds back the frame's writers until one of them happens. */
export interface PurgeLease {
  readonly frameId: string
  readonly canvasId: string
  readonly frameName: string
  /** `kept` once released, `purged` once finished */
  readonly outcome: Promise<'kept' | 'purged'>
  /** set by the finalizer: what the purge removed */
  receipt?: PurgeReceipt
  release(): void
}

type PurgeState = {
  lease: PurgeLease
  frame: Frame
  status: 'open' | 'released' | 'purged'
  send: (event: PurgeEvent) => void
}
const leases = new WeakMap<PurgeLease, PurgeState>()

type PageCopy = {
  source: CanvasPageInfo
  page: CanvasPageInfo
  pages: CanvasPageInfo[]
  frames: Frame[]
  guides: CanvasGuide[]
}

const names = (pages: CanvasPageInfo[]) => pages.map((page) => page.name)

/** A frame as it stands, to put back if the write about to change it is undone. Its html
 *  is read only when loaded: an unloaded frame goes back to unloaded. */
function frameState(frame: Frame) {
  const fields: Record<string, unknown> = {}
  for (const key of Object.keys(frame)) if (key !== 'html') fields[key] = (frame as never)[key]
  const loaded = htmlLoaded(frame)
  return { fields, loaded, html: loaded ? frame.html : '' }
}

function restoreFrame(frame: Frame, state: ReturnType<typeof frameState>) {
  for (const key of Object.keys(frame)) if (key !== 'html' && !(key in state.fields)) delete (frame as never)[key]
  Object.assign(frame, state.fields)
  if (state.loaded) setHtml(frame, state.html)
  else unloadHtml(frame)
}

/**
 * In-memory canvas/frame state — the hot path for reads, reveals and
 * broadcasts. Every committed mutation is mirrored to the database via
 * the write-through helpers in db/persist.ts; boot hydrates from there.
 *
 * Every write here is journaled (server/journal.ts): memory changes at once,
 * with a way back recorded, and the database write waits for the commit of
 * the operation it is part of. An operation that is refused part of the way
 * leaves memory as it was and the database untouched. An undo puts back only
 * what is still its own: a frame or component someone else has written since
 * is theirs. The copies (duplicateCanvas, duplicatePage) are the exception:
 * they are durable before memory changes, and are not undone.
 *
 * Every canvas and frame is in memory except frame HTML, which is most of
 * the data: boot leaves it out and `load` reads one canvas's when something
 * needs it (frameHtml.ts). Entry points (a REST route, the room join, an MCP
 * tool, an agent run, a job) await `load`; everything past them reads the
 * store synchronously as before. `evictIdle` drops the HTML of a canvas
 * nobody has used for a while, never one that is held or in use.
 */
/** A copy is a new draft: it carries no lock, no epoch, no attestation and no who, when or why of the frame it came from. */
const UNLOCKED = {
  locked: undefined,
  lockEpoch: undefined,
  lockAttestationId: undefined,
  lockedBy: undefined,
  lockedAt: undefined,
  lockReason: undefined,
} as const

/** `lockedBy` of a lock whose caller named nobody (a test calling the store directly) */
const UNKNOWN_LOCKER = 'unknown'

/** The lock's own record (S1): who, when and why. One place sets it and one clears it, so no writer half-does either. */
function stampLock(frame: Frame, by: string, at: number, reason?: string): void {
  frame.lockedBy = by
  frame.lockedAt = at
  if (reason === undefined) delete frame.lockReason
  else frame.lockReason = reason
}
function clearLockStamp(frame: Frame): void {
  delete frame.lockedBy
  delete frame.lockedAt
  delete frame.lockReason
}

class Store {
  canvases = new Map<string, Canvas>()
  private frameIndex = new Map<string, string>() // frameId -> canvasId
  /** the page copy in flight per canvas, so the next one waits for it */
  private pageCopies = new Map<string, Promise<unknown>>()
  /** canvases whose frame HTML is in memory -> when they were last used */
  private loaded = new Map<string, number>()
  private loading = new Map<string, Promise<void>>()
  /** canvases an agent run or job is working on, counted */
  private holds = new Map<string, number>()
  /** rooms, agents and streams the store cannot see (wired by index.ts) */
  private inUse: (canvasId: string) => boolean = () => false

  /** Put these fields of the canvas back if the transaction is undone. `deep` for the ones
   *  whose items are changed in place (tokens, guideline docs). */
  private remember(c: Canvas, keys: readonly (keyof Canvas)[], deep = false) {
    if (!inTransaction()) return
    const fields = c as unknown as Record<string, unknown>
    const before = keys.map((key) => {
      const value = fields[key]
      return { key, had: key in c, value: deep ? structuredClone(value) : Array.isArray(value) ? [...value] : value }
    })
    recordUndo(() => {
      for (const { key, had, value } of before) {
        if (had) fields[key] = value
        else delete fields[key]
      }
    })
  }

  /** The canvas row is written once per transaction, with what the canvas holds by then. */
  private saveCanvasLater(c: Canvas) {
    afterCommit(() => {
      if (this.canvases.get(c.id) === c) persist.saveCanvas(c)
    }, `canvas:${c.id}`)
  }

  /** A design edit landed: the canvas is as recent as it. */
  private touchCanvas(c: Canvas, at: number) {
    const before = c.updatedAt
    c.updatedAt = at
    recordUndo(() => {
      if (c.updatedAt === at) c.updatedAt = before
    })
  }

  /** The frame row is written at the commit, as the frame stands then; `now` skips the debounce. */
  private saveFrameLater(frame: Frame, now = false) {
    afterCommit(() => {
      if (this.getFrame(frame.id) === frame) persist.saveFrame(frame, now)
    }, `frame:${frame.id}`)
  }

  /** A frame moved into or out of the trash is written at the commit. Its html is not touched
   *  unless it is in memory: a delete or restore never changes it, and it may not be loaded. */
  private saveTrashedFrameLater(frame: Frame, canvasId: string) {
    afterCommit(() => {
      const trashed = this.deletedIndex.get(frame.id) === canvasId
      if (!trashed && this.getFrame(frame.id) !== frame) return
      if (htmlLoaded(frame)) persist.saveFrame(frame, true)
      else persist.saveFrameTrash(frame)
    }, `trash:${frame.id}`)
  }

  constructor() {
    /* a missed load still fails, but the canvas is on its way for a retry */
    setHtmlMissHandler((canvasId) => {
      this.load(canvasId).catch((error: unknown) =>
        console.error('[store] loading after a miss failed', canvasId, error),
      )
    })
  }

  /** Soft-deleted frames and pages per canvas. Kept off `Canvas` so the canvas
   *  JSON every route returns never carries the trash. */
  private trash = new Map<string, { frames: Frame[]; pages: DeletedPage[] }>()
  private deletedIndex = new Map<string, string>() // deleted frameId -> canvasId
  /** Trash frames with an open "delete forever": the mark restores and snapshot restores check (CHE-9399) */
  private purging = new Map<string, PurgeState>()

  init(canvases: Canvas[], trash?: Map<string, { frames: Frame[]; pages: DeletedPage[] }>) {
    for (const [canvasId, entry] of trash ?? []) {
      this.trash.set(canvasId, entry)
      for (const f of entry.frames) this.deletedIndex.set(f.id, canvasId)
    }
    for (const c of canvases) {
      c.pages = canvasPages(c)
      this.canvases.set(c.id, c)
      for (const f of c.frames) {
        /* A frame whose page is gone (the server died between a frame move
           and the page's deletion: moves persist on a debounce, pages at
           once) rejoins the first page instead of vanishing from every page. */
        if (!f.pageId || !c.pages.some((page) => page.id === f.pageId)) {
          f.pageId = c.pages[0]!.id
          if (htmlLoaded(f)) persist.saveFrame(f, true)
          else persist.saveFramePage(f.id, f.pageId)
        }
        this.frameIndex.set(f.id, c.id)
      }
      if (c.frames.every(htmlLoaded) && (this.trash.get(c.id)?.frames ?? []).every(htmlLoaded))
        this.loaded.set(c.id, Date.now())
      else this.loaded.delete(c.id)
    }
  }

  /** The canvas with every frame's HTML in memory, read from the database
   *  the first time and kept until `evictIdle`. Concurrent calls share one
   *  read. Undefined for a canvas that does not exist. */
  async load(canvasId: string): Promise<Canvas | undefined> {
    if (!this.canvases.has(canvasId)) return undefined
    if (this.loaded.has(canvasId)) {
      this.loaded.set(canvasId, Date.now())
      return this.canvases.get(canvasId)
    }
    let pending = this.loading.get(canvasId)
    if (!pending) {
      pending = this.fill(canvasId).finally(() => this.loading.delete(canvasId))
      this.loading.set(canvasId, pending)
    }
    await pending
    return this.canvases.get(canvasId)
  }

  /** The canvas of a frame, loaded; undefined when the frame is gone. */
  async loadFrame(frameId: string): Promise<Frame | undefined> {
    const canvasId = this.frameIndex.get(frameId)
    if (canvasId) await this.load(canvasId)
    return this.getFrame(frameId)
  }

  private async fill(canvasId: string) {
    /* a canvas whose every frame was written since boot needs no read */
    const kept = () => [...(this.canvases.get(canvasId)?.frames ?? []), ...(this.trash.get(canvasId)?.frames ?? [])]
    if (kept().every(htmlLoaded)) {
      this.loaded.set(canvasId, Date.now())
      return
    }
    const rows = await persist.loadFrameHtml(canvasId)
    const canvas = this.canvases.get(canvasId)
    if (!canvas) return
    const stored = new Map(rows.map((row) => [row.id, row.html]))
    /* a frame written while the read was in flight already holds newer html */
    for (const frame of kept()) {
      if (htmlLoaded(frame)) continue
      const html = stored.get(frame.id)
      if (html === undefined) console.error('[store] frame has no stored html', frame.id)
      setHtml(frame, html ?? '')
    }
    this.loaded.set(canvasId, Date.now())
  }

  /** Keep a canvas loaded while an agent run or job works on it; call the
   *  returned function when done. Load it first. */
  hold(canvasId: string): () => void {
    this.holds.set(canvasId, (this.holds.get(canvasId) ?? 0) + 1)
    let released = false
    return () => {
      if (released) return
      released = true
      const count = (this.holds.get(canvasId) ?? 1) - 1
      if (count > 0) this.holds.set(canvasId, count)
      else this.holds.delete(canvasId)
      if (this.loaded.has(canvasId)) this.loaded.set(canvasId, Date.now())
    }
  }

  /** Load, hold for the length of `work`, release. */
  async withCanvas<T>(canvasId: string, work: (canvas: Canvas | undefined) => Promise<T>): Promise<T> {
    const canvas = await this.load(canvasId)
    const release = this.hold(canvasId)
    try {
      return await work(canvas)
    } finally {
      release()
    }
  }

  setInUse(check: (canvasId: string) => boolean) {
    this.inUse = check
  }

  isLoaded(canvasId: string): boolean {
    return this.loaded.has(canvasId)
  }

  /** Drop the frame HTML of canvases unused for `idleMs`: never one that is
   *  held, in use (a room, an agent, a stream) or waiting on a frame write.
   *  Returns how many were dropped. */
  evictIdle(idleMs: number, now = Date.now()): number {
    let evicted = 0
    for (const [canvasId, usedAt] of this.loaded) {
      if (now - usedAt < idleMs) continue
      /* in use counts as used: the idle wait starts when the last one leaves */
      if (this.holds.has(canvasId) || this.inUse(canvasId)) {
        this.loaded.set(canvasId, now)
        continue
      }
      const canvas = this.canvases.get(canvasId)
      const frames = [...(canvas?.frames ?? []), ...(this.trash.get(canvasId)?.frames ?? [])]
      const unsaved = frames.filter((frame) => persist.frameWritePending(frame.id))
      if (unsaved.length) {
        /* idle with unsaved frames means a write failed: try it again */
        for (const frame of unsaved) persist.retryFrameWrite(frame)
        continue
      }
      for (const frame of frames) unloadHtml(frame)
      this.loaded.delete(canvasId)
      evicted++
    }
    return evicted
  }

  /** A standalone copy of a frame with its HTML, for a render: from memory
   *  when its canvas is loaded, else read from the database, so one
   *  thumbnail never pulls a whole canvas into memory. A copy, so a canvas
   *  dropped while the render waits for a slot cannot take the html away. */
  async renderableFrame(frameId: string): Promise<Frame | undefined> {
    const frame = this.getFrame(frameId)
    if (!frame) return undefined
    if (htmlLoaded(frame)) return withHtml(frame, frame.html)
    const html = await persist.loadOneFrameHtml(frameId)
    const current = this.getFrame(frameId)
    if (!current) return undefined
    return withHtml(current, htmlLoaded(current) ? current.html : (html ?? ''))
  }

  /** The renderable copy of `frame`, for a render that was handed the
   *  frame's metadata. A frame the store no longer holds renders as given
   *  when it carries its html; otherwise this rejects. */
  async renderSource(frame: Frame): Promise<Frame> {
    const source = await this.renderableFrame(frame.id)
    if (source) return source
    if (htmlLoaded(frame)) return frame
    throw new Error(`frame ${frame.id} no longer exists`)
  }

  stats() {
    return {
      canvases: this.canvases.size,
      loaded: this.loaded.size,
      loading: this.loading.size,
      held: this.holds.size,
    }
  }

  /** The dashboard row for one canvas. `viewerId` decides only whether the
   *  canvas is marked as shared-with-me; pass undefined for views that have
   *  no viewer-relative meaning (the admin index). */
  private toMeta(c: Canvas, viewerId?: string) {
    return {
      id: c.id,
      name: c.name,
      ownerId: c.ownerId,
      shared: viewerId !== undefined ? c.ownerId !== viewerId || undefined : undefined,
      ...(c.workspaceId ? { workspaceId: c.workspaceId } : {}),
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      frameCount: c.frames.length,
      /* most recently touched frame — the home dashboard renders it as the
         canvas preview via the public /i/ image pipeline */
      previewFrameId: c.frames.length ? c.frames.reduce((a, b) => (b.updatedAt > a.updatedAt ? b : a)).id : undefined,
    }
  }

  /** Canvases visible to a user: their own, ones they were invited to, and
   *  every canvas in the workspaces they belong to (the caller resolves
   *  membership — see workspaces.canvasesFor). Unowned (legacy/seeded)
   *  canvases are NOT listed — listing them to everyone leaked one user's
   *  work onto every other user's dashboard. They remain reachable by their
   *  unguessable id and claimable there. */
  listCanvases(userId: string, workspaceIds: readonly string[] = []) {
    return [...this.canvases.values()]
      .filter(
        (c) =>
          c.ownerId === userId ||
          c.memberIds?.includes(userId) ||
          (c.workspaceId !== undefined && workspaceIds.includes(c.workspaceId)),
      )
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((c) => this.toMeta(c, userId))
  }

  /** The canvas signup made for this user (server/auth.ts): the oldest one
   *  they own. Undefined once they have deleted it, or for an account that
   *  predates the signup hook. */
  firstCanvasOf(userId: string): Canvas | undefined {
    let first: Canvas | undefined
    for (const c of this.canvases.values()) {
      if (c.ownerId === userId && (!first || c.createdAt < first.createdAt)) first = c
    }
    return first
  }

  /** Every canvas on the instance, for the admin index only. Access is the
   *  caller's problem — the only caller is server/admin.ts, behind isAdmin.
   *  A deliberately separate method rather than a flag on listCanvases: a
   *  boolean parameter is the kind of thing that eventually gets passed
   *  `true` from a route that shouldn't. */
  /** Every canvas, unfiltered and unsummarised, for server-side loops that
   *  apply their own access check per user (Live Activity push-to-start). */
  allCanvases(): Canvas[] {
    return [...this.canvases.values()]
  }

  listAllCanvases(limit = 200) {
    const all = [...this.canvases.values()].sort((a, b) => b.updatedAt - a.updatedAt)
    return {
      total: all.length,
      canvases: all.slice(0, limit).map((c) => ({
        ...this.toMeta(c),
        linkAccess: c.linkAccess ?? 'none',
        memberCount: c.memberIds?.length ?? 0,
      })),
    }
  }

  createCanvas(name: string, ownerId?: string, workspaceId?: string): Canvas {
    const now = Date.now()
    const canvas: Canvas = { id: nanoid(10), name, ownerId, createdAt: now, updatedAt: now, frames: [] }
    if (workspaceId) canvas.workspaceId = workspaceId
    requireBoundary('store.createCanvas')
    this.canvases.set(canvas.id, canvas)
    this.loaded.set(canvas.id, now)
    canvas.pages = canvasPages(canvas)
    recordUndo(() => {
      if (this.canvases.get(canvas.id) !== canvas) return
      for (const frame of canvas.frames) this.frameIndex.delete(frame.id)
      this.canvases.delete(canvas.id)
      this.loaded.delete(canvas.id)
    })
    this.saveCanvasLater(canvas)
    return canvas
  }

  /** Copy reusable design content into a new private canvas. Collaboration,
   * activity, tasks, external connections and the gallery listing belong to
   * the source only. `name` defaults to "<source> copy"; `dropDemo` leaves
   * product-made onboarding frames behind (a gallery copy is the design,
   * not the welcome tour that happened to sit next to it); `workspaceId`
   * files the copy in a workspace (the caller checks membership). */
  async duplicateCanvas(
    id: string,
    ownerId: string,
    by: string,
    options: { name?: string; dropDemo?: boolean; workspaceId?: string } = {},
  ): Promise<Canvas | undefined> {
    const source = await this.load(id)
    if (!source) return undefined
    const now = Date.now()
    const canvasId = nanoid(10)
    const sourceFrames = options.dropDemo ? source.frames.filter((frame) => !frame.demo) : source.frames
    const frameIds = new Map(sourceFrames.map((frame) => [frame.id, nanoid(10)]))
    /* the copies share one createdAt, so each keeps its place in the stack */
    const frames = sourceFrames.map((frame) => ({
      ...frame,
      id: frameIds.get(frame.id)!,
      html: remapFrameTargets(frame.html, frameIds),
      approval: null,
      ...UNLOCKED,
      archiveOrigin: undefined,
      z: stackOf(frame),
      canvasId,
      createdAt: now,
      updatedAt: now,
      updatedBy: by,
    }))
    const guidelines = source.guidelines?.map((doc) => ({ ...doc, updatedAt: now, updatedBy: by }))
    const tokens = source.tokens?.map((token) => ({ ...token, updatedAt: now, updatedBy: by }))
    const references = source.references?.map((ref) => ({
      ...ref,
      id: nanoid(10),
      frameId: frameIds.get(ref.frameId) ?? ref.frameId,
      pinnedBy: by,
      pinnedAt: now,
    }))
    const canvas: Canvas = {
      id: canvasId,
      name: options.name ?? `${source.name} copy`,
      ownerId,
      createdAt: now,
      updatedAt: now,
      frames,
      pages: canvasPages(source).map(({ startFrameId, issueId: _issue, issueSource: _source, ...page }) => {
        const start = startFrameId && frameIds.get(startFrameId)
        return start ? { ...page, startFrameId: start } : page
      }),
      ...(source.guides?.length ? { guides: source.guides.map((guide) => ({ ...guide })) } : {}),
      ...(options.workspaceId ? { workspaceId: options.workspaceId } : {}),
      ...(guidelines?.length ? { guidelines } : {}),
      /* same ids: the markers in the copied frames keep pointing at them */
      ...(source.components?.length
        ? {
            components: source.components.map((def) => ({
              ...def,
              mainFrameId: def.mainFrameId ? (frameIds.get(def.mainFrameId) ?? null) : null,
              updatedAt: now,
              updatedBy: by,
            })),
          }
        : {}),
      ...(tokens?.length ? { tokens } : {}),
      ...(source.tokenThemes?.length ? { tokenThemes: [...source.tokenThemes] } : {}),
      ...(references?.length ? { references } : {}),
    }
    await persist.saveCanvasCopy(canvas)
    this.canvases.set(canvas.id, canvas)
    this.loaded.set(canvas.id, Date.now())
    for (const frame of frames) this.frameIndex.set(frame.id, canvas.id)
    return canvas
  }

  /** Copy a page and every frame on it (same names, geometry and html under
   * fresh ids) into a new page right after the source, named "<source> copy"
   * (numbered when that name is taken). Copies of one canvas run one after
   * another so two at once cannot pick the same name or overshoot the page
   * limit; memory changes only once the copy is durable, as with
   * duplicateCanvas. Rejects with PageLimitError when the canvas is full. */
  duplicatePage(ctx: WriteContext, canvasId: string, pageId: string, by: string): Promise<PageCopy | undefined> {
    const previous = this.pageCopies.get(canvasId) ?? Promise.resolve()
    const task = previous.then(
      () => this.copyPage(ctx, canvasId, pageId, by),
      () => this.copyPage(ctx, canvasId, pageId, by),
    )
    this.pageCopies.set(canvasId, task)
    const release = () => {
      if (this.pageCopies.get(canvasId) === task) this.pageCopies.delete(canvasId)
    }
    void task.then(release, release)
    return task
  }

  private async copyPage(
    ctx: WriteContext,
    canvasId: string,
    pageId: string,
    by: string,
  ): Promise<PageCopy | undefined> {
    const canvas = await this.load(canvasId)
    if (!canvas) return undefined
    const pages = canvasPages(canvas)
    const source = pages.find((page) => page.id === pageId)
    if (!source) return undefined
    assertWritable(ctx, 'copy_page', { canvas, pageIds: [pageId] })
    if (pages.length >= MAX_PAGES) throw new PageLimitError()
    const now = Date.now()
    const sourceFrames = pageFrames(canvas, pageId)
    const frameIds = new Map(sourceFrames.map((frame) => [frame.id, nanoid(10)]))
    const start = source.startFrameId && frameIds.get(source.startFrameId)
    const page: CanvasPageInfo = {
      id: nanoid(10),
      name: copyPageName(source.name, names(pages)),
      ...(start ? { startFrameId: start } : {}),
      ...(source.background ? { background: source.background } : {}),
    }
    /* links within the page follow the copy; links to other pages stay */
    const frames: Frame[] = sourceFrames.map((frame) => ({
      ...frame,
      id: frameIds.get(frame.id)!,
      html: remapFrameTargets(frame.html, frameIds),
      pageId: page.id,
      approval: null,
      ...UNLOCKED,
      archiveOrigin: undefined,
      z: stackOf(frame),
      createdAt: now,
      updatedAt: now,
      updatedBy: by,
    }))
    const guides: CanvasGuide[] = (canvas.guides ?? [])
      .filter((guide) => guide.pageId === pageId)
      .map((guide) => ({ ...guide, id: nanoid(10), pageId: page.id }))
    /* the copy's guides count against the canvas like any other */
    if ((canvas.guides?.length ?? 0) + guides.length > MAX_GUIDES) throw new GuideLimitError()
    const spliced = [...pages]
    spliced.splice(pages.indexOf(source) + 1, 0, page)
    const next = pageOrder(spliced)
    /* the copy is async: judge again at the commit, not only at the start. The check runs inside the
       database transaction, before it commits, so a refusal rolls the copy back and nothing becomes durable. */
    await persist.savePageCopy(
      { ...canvas, pages: next, guides: [...(canvas.guides ?? []), ...guides], updatedAt: now },
      frames,
      () => {
        if (this.canvases.get(canvasId) === canvas) assertWritable(ctx, 'copy_page', { canvas, pageIds: [pageId] })
      },
    )
    if (this.canvases.get(canvasId) !== canvas) return undefined
    /* a page save may have landed during the write: slot the copy after the
       source wherever it is now (or last, if the source is gone), under a
       name the live list does not use */
    const live = canvasPages(canvas)
    if (names(live).includes(page.name)) page.name = copyPageName(source.name, names(live))
    const at = live.findIndex((candidate) => candidate.id === pageId)
    const placed = [...live]
    placed.splice(at === -1 ? live.length : at + 1, 0, page)
    canvas.pages = pageOrder(placed)
    canvas.frames.push(...frames)
    canvas.frames.sort(byStack)
    for (const frame of frames) this.frameIndex.set(frame.id, canvasId)
    /* guides placed while the copy was being written stay alongside; the
       copy keeps only as many of its own as the limit still has room for */
    const copied = guides.length > 0
    const room = Math.max(0, MAX_GUIDES - (canvas.guides?.length ?? 0))
    if (guides.length > room) guides.splice(room)
    if (guides.length) canvas.guides = [...(canvas.guides ?? []), ...guides]
    canvas.updatedAt = Math.max(canvas.updatedAt, now)
    if (!samePages(canvas.pages, next) || copied) persist.saveCanvas(canvas)
    return { source, page, pages: canvas.pages, frames, guides }
  }

  /** Replace the page list. Returns the saved pages (flow starts kept) and
   *  the guides that went with deleted pages, so peers can drop them;
   *  undefined when the canvas is gone. */
  setPages(
    ctx: WriteContext,
    canvasId: string,
    pages: import('../shared/types.ts').CanvasPageInfo[],
  ): { pages: import('../shared/types.ts').CanvasPageInfo[]; dropped: CanvasGuide[] } | undefined {
    const canvas = this.canvases.get(canvasId)
    if (!canvas) return undefined
    requireBoundary('store.setPages')
    assertWritable(ctx, 'set_pages', { canvas, nextPages: pages })
    this.remember(canvas, ['pages', 'guides', 'updatedAt'])
    this.fillFramePageIds(canvas)
    /* a page-list save renames, reorders, adds or deletes pages — it never
       moves a flow start or recolours a page, which only setFlowStart and
       setPageBackground change; the ledger and Finished flags stay with the page the same way */
    const current = canvasPages(canvas)
    const merged = pages.map(
      ({
        startFrameId: _start,
        background: _background,
        issueId: _issue,
        issueSource: _source,
        ledger: _ledger,
        finished: _finished,
        ...page
      }) => {
        const kept = current.find((p) => p.id === page.id)
        return {
          ...page,
          ...(kept?.ledger ? { ledger: true as const } : {}),
          ...(kept?.finished ? { finished: kept.finished } : {}),
          ...(kept?.startFrameId ? { startFrameId: kept.startFrameId } : {}),
          ...(kept?.background ? { background: kept.background } : {}),
          ...(kept?.issueId ? { issueId: kept.issueId, issueSource: kept.issueSource } : {}),
        }
      },
    )
    const ordered = pageOrder(merged)
    /* a removed page is kept in the trash, with its (deleted) frames still pointing at it */
    const now = Date.now()
    const removed = current.filter((page) => !ordered.some((p) => p.id === page.id))
    if (removed.length || this.trash.get(canvasId)?.pages.some((d) => ordered.some((p) => p.id === d.page.id))) {
      const entry = this.trashOf(canvasId)
      entry.pages = [
        ...entry.pages.filter(
          (d) => !ordered.some((p) => p.id === d.page.id) && !removed.some((p) => p.id === d.page.id),
        ),
        ...removed.map((page) => ({ page, deletedAt: now })),
      ]
      const kept = [...entry.pages]
      afterCommit(() => persist.saveDeletedPages(canvasId, kept), `trashpages:${canvasId}`)
    }
    canvas.pages = ordered
    /* a deleted page takes its guides with it */
    const kept = (guide: CanvasGuide) => ordered.some((page) => page.id === guide.pageId)
    const dropped = (canvas.guides ?? []).filter((guide) => !kept(guide))
    if (dropped.length) canvas.guides = canvas.guides!.filter(kept)
    canvas.updatedAt = Date.now()
    this.saveCanvasLater(canvas)
    return { pages: ordered, dropped }
  }

  /** Bind (projectId) or unbind (null) the Multica project this canvas belongs to.
   *  Server-owned like a page's issueId: only a user or the system may change it,
   *  never an agent (assertWritable). Undefined for an unknown canvas. */
  bindProject(ctx: WriteContext, canvasId: string, projectId: string | null): Canvas | undefined {
    const canvas = this.canvases.get(canvasId)
    if (!canvas) return undefined
    assertWritable(ctx, 'bind_project', { canvas })
    /* a page copy judged its binding at the start and commits later: a rebind in between is held off */
    if (this.pageCopies.has(canvasId)) throw new PolicyRefused('bind_project', 'a page copy is in progress')
    if (projectId) canvas.projectId = projectId
    else delete canvas.projectId
    persist.saveCanvas(canvas)
    return canvas
  }

  /** Set (frameId) or clear (null) the frame a page's prototype starts on. */
  setFlowStart(canvasId: string, pageId: string, frameId: string | null) {
    const canvas = this.canvases.get(canvasId)
    if (!canvas) return undefined
    const pages = canvasPages(canvas)
    if (!pages.some((p) => p.id === pageId)) return undefined
    assertPagesOpen(canvas, [pageId], 'set_flow_start')
    requireBoundary('store.setFlowStart')
    this.remember(canvas, ['pages', 'updatedAt'])
    canvas.pages = pages.map((page) => {
      if (page.id !== pageId) return page
      const { startFrameId: _previous, ...rest } = page
      return frameId ? { ...rest, startFrameId: frameId } : rest
    })
    canvas.updatedAt = Date.now()
    this.saveCanvasLater(canvas)
    return canvas.pages
  }

  /** A frame with no page id is on the first page; name it before the order can move that page. */
  private fillFramePageIds(canvas: Canvas) {
    const firstId = canvasPages(canvas)[0]!.id
    for (const frame of canvas.frames) {
      if (frame.pageId) continue
      frame.pageId = firstId
      recordUndo(() => {
        if (frame.pageId === firstId) delete frame.pageId
      })
      this.saveFrameLater(frame, true)
    }
  }

  /** Mark a page as the ledger (clearing it everywhere else) or clear the mark, then put the pages in
   *  `pageOrder`: one write. Archive and Finished pages cannot be the ledger. A repeat writes nothing
   *  (`changed: false`). Server-owned like `issueId`: no page-list save, copy or restore sets it. */
  setLedger(canvasId: string, pageId: string, on: boolean): LedgerResult {
    const canvas = this.canvases.get(canvasId)
    const page = canvas && canvasPages(canvas).find((p) => p.id === pageId)
    if (!canvas || !page) return { ok: false, code: 'not_found' }
    const pages = canvasPages(canvas)
    if (on && pageId === ARCHIVE_PAGE_ID) return { ok: false, code: 'archive_page' }
    if (on && page.finished) return { ok: false, code: 'page_finished' }
    const current = pages.filter((p) => p.ledger).map((p) => p.id)
    if (on ? current.length === 1 && current[0] === pageId : !page.ledger) return { ok: true, pages, changed: false }
    requireBoundary('store.setLedger')
    this.remember(canvas, ['pages', 'updatedAt'])
    this.fillFramePageIds(canvas)
    canvas.pages = pageOrder(
      pages.map((p) => {
        const { ledger: _ledger, ...rest } = p
        return on && p.id === pageId ? { ...rest, ledger: true as const } : rest
      }),
    )
    canvas.updatedAt = Date.now()
    this.saveCanvasLater(canvas)
    return { ok: true, pages: canvas.pages, changed: true }
  }

  /** Move a page to Finished (`on`) or restore it (CHE-9398 L5). `expectedName` is the name the caller saw:
   *  a page renamed since answers `page_changed`. The ledger and Archive cannot be finished, and a page a
   *  snapshot restore is writing answers `page_busy` (finishing only). The page goes to the END of its new
   *  group: behind the other Finished pages, or behind the open pages. A repeat writes nothing
   *  (`changed: false`); the first `{at, by}` stands. Agent binding runs as `set_page_state`. */
  setPageFinished(
    ctx: WriteContext,
    canvasId: string,
    pageId: string,
    on: boolean,
    expectedName: string,
    by: string,
  ): PageFinishedResult {
    const canvas = this.canvases.get(canvasId)
    if (!canvas) return { ok: false, code: 'not_found' }
    if (pageId === ARCHIVE_PAGE_ID) return { ok: false, code: 'archive_page' }
    const pages = canvasPages(canvas)
    const page = pages.find((p) => p.id === pageId)
    if (!page) return { ok: false, code: 'not_found' }
    if (page.name !== expectedName) return { ok: false, code: 'page_changed', pages }
    if (page.ledger) return { ok: false, code: 'ledger_page' }
    assertWritable(ctx, 'set_page_state', { canvas, pageIds: [pageId] })
    if (on === !!page.finished) return { ok: true, pages, changed: false }
    if (on && restoring(canvasId, pageId)) return { ok: false, code: 'page_busy' }
    requireBoundary('store.setPageFinished')
    this.remember(canvas, ['pages', 'updatedAt'])
    this.fillFramePageIds(canvas)
    const moved = pages.map((p) => {
      if (p.id !== pageId) return p
      const { finished: _finished, ...rest } = p
      return on ? { ...rest, finished: { at: Date.now(), by } } : rest
    })
    const mine = moved.find((p) => p.id === pageId)!
    canvas.pages = pageOrder([...moved.filter((p) => p.id !== pageId), mine])
    canvas.updatedAt = Date.now()
    this.saveCanvasLater(canvas)
    return { ok: true, pages: canvas.pages, changed: true }
  }

  /** Set (a `#rrggbb`) or clear (null) a page's own canvas colour. */
  setPageBackground(canvasId: string, pageId: string, background: string | null) {
    const canvas = this.canvases.get(canvasId)
    if (!canvas) return undefined
    const pages = canvasPages(canvas)
    if (!pages.some((p) => p.id === pageId)) return undefined
    assertPagesOpen(canvas, [pageId], 'set_page_background')
    requireBoundary('store.setPageBackground')
    this.remember(canvas, ['pages', 'updatedAt'])
    canvas.pages = pages.map((page) => {
      if (page.id !== pageId) return page
      const { background: _previous, ...rest } = page
      return background ? { ...rest, background } : rest
    })
    canvas.updatedAt = Date.now()
    this.saveCanvasLater(canvas)
    return canvas.pages
  }

  /** Bind (issueId) or unbind (null) a page's Multica issue. Only the member
   *  route and the Design-URL derivation call this — page-list saves, copies
   *  and MCP tools never reach it. Undefined for an unknown canvas or page or
   *  a malformed issue id. */
  setPageIssue(canvasId: string, pageId: string, issueId: string | null, source: 'member' | 'design') {
    const canvas = this.canvases.get(canvasId)
    if (!canvas || (issueId !== null && !isUuid(issueId))) return undefined
    const pages = canvasPages(canvas)
    if (!pages.some((p) => p.id === pageId)) return undefined
    canvas.pages = pages.map((page) => {
      if (page.id !== pageId) return page
      const { issueId: _previous, issueSource: _source, ...rest } = page
      return issueId ? { ...rest, issueId: issueId.toLowerCase(), issueSource: source } : rest
    })
    canvas.updatedAt = Date.now()
    persist.saveCanvas(canvas)
    return canvas.pages
  }

  /** Reconcile the 'design' links with the issues' Design URLs: link a page an
   *  issue alone names, and clear a design link the URLs no longer support (stale
   *  or in conflict). Member links are never touched. */
  applyDesignLinks(canvasId: string, issues: DesignIssue[]) {
    const canvas = this.canvases.get(canvasId)
    if (!canvas) return undefined
    const pages = canvasPages(canvas)
    const frameIds = new Map(canvas.frames.map((f) => [f.id, framePageId(canvas, f)]))
    const { links } = deriveDesignLinks(canvasId, pages, issues, (id) => frameIds.get(id))
    let changed = false
    const next = pages.map((page) => {
      if (page.issueSource === 'member') return page
      const want = links.get(page.id)
      if (want === page.issueId) return page
      changed = true
      const { issueId: _previous, issueSource: _source, ...rest } = page
      return want ? { ...rest, issueId: want, issueSource: 'design' as const } : rest
    })
    if (changed) {
      canvas.pages = next
      canvas.updatedAt = Date.now()
      persist.saveCanvas(canvas)
    }
    return canvas.pages ?? next
  }

  /** Add a ruler guide, or move one that exists. Undefined when the canvas
   *  is gone; throws GuideLimitError on a canvas already holding the most. */
  setGuide(canvasId: string, guide: CanvasGuide): CanvasGuide | undefined {
    const canvas = this.canvases.get(canvasId)
    if (!canvas) return undefined
    const guides = canvas.guides ?? []
    const exists = guides.some((g) => g.id === guide.id)
    if (!exists && guides.length >= MAX_GUIDES) throw new GuideLimitError()
    requireBoundary('store.setGuide')
    this.remember(canvas, ['guides'])
    canvas.guides = exists ? guides.map((g) => (g.id === guide.id ? guide : g)) : [...guides, guide]
    this.saveCanvasLater(canvas)
    return guide
  }

  /** Remove a ruler guide; false when there was no such guide. */
  deleteGuide(canvasId: string, guideId: string): boolean {
    const canvas = this.canvases.get(canvasId)
    if (!canvas?.guides?.some((g) => g.id === guideId)) return false
    requireBoundary('store.deleteGuide')
    this.remember(canvas, ['guides'])
    canvas.guides = canvas.guides.filter((g) => g.id !== guideId)
    this.saveCanvasLater(canvas)
    return true
  }

  getCanvas(id: string) {
    return this.canvases.get(id)
  }

  /** Remove a canvas and its frames from memory + database. */
  deleteCanvas(ctx: WriteContext, id: string): Canvas | undefined {
    const c = this.canvases.get(id)
    if (!c) return undefined
    requireBoundary('store.deleteCanvas')
    assertWritable(ctx, 'delete_canvas', { canvas: c })
    const loadedAt = this.loaded.get(id)
    for (const f of c.frames) this.frameIndex.delete(f.id)
    for (const f of this.trash.get(id)?.frames ?? []) this.deletedIndex.delete(f.id)
    this.trash.delete(id)
    this.canvases.delete(id)
    this.loaded.delete(id)
    recordUndo(() => {
      if (this.canvases.has(id)) return
      this.canvases.set(id, c)
      for (const f of c.frames) this.frameIndex.set(f.id, id)
      if (loadedAt !== undefined) this.loaded.set(id, loadedAt)
    })
    afterCommit(() => {
      if (!this.canvases.has(id)) persist.deleteCanvas(id)
    })
    return c
  }

  /** Take ownership of a pre-auth (unowned) canvas. No-op if already owned. */
  claimCanvas(id: string, userId: string): Canvas | undefined {
    const c = this.canvases.get(id)
    if (!c || c.ownerId) return undefined
    requireBoundary('store.claimCanvas')
    this.remember(c, ['ownerId'])
    c.ownerId = userId
    this.saveCanvasLater(c)
    return c
  }

  /** Owner-set link policy ('none' is the default and stored as unset).
   *  Deliberately does not bump updatedAt — a privacy toggle is not a
   *  design edit. */
  setLinkAccess(id: string, mode: LinkAccess): Canvas | undefined {
    const c = this.canvases.get(id)
    if (!c) return undefined
    requireBoundary('store.setLinkAccess')
    this.remember(c, ['linkAccess'])
    if (mode === 'none') delete c.linkAccess
    else c.linkAccess = mode
    this.saveCanvasLater(c)
    return c
  }

  /* ---- workspaces ---- */

  /** File a canvas in a workspace, or take it back to its owner's personal
   *  space (undefined). Access checks are the caller's; like the privacy
   *  toggles this is not a design edit, so updatedAt stays put. */
  setWorkspace(id: string, workspaceId: string | undefined): Canvas | undefined {
    const c = this.canvases.get(id)
    if (!c) return undefined
    requireBoundary('store.setWorkspace')
    this.remember(c, ['workspaceId'])
    if (workspaceId) c.workspaceId = workspaceId
    else delete c.workspaceId
    this.saveCanvasLater(c)
    return c
  }

  countWorkspaceCanvases(workspaceId: string): number {
    let n = 0
    for (const c of this.canvases.values()) if (c.workspaceId === workspaceId) n++
    return n
  }

  /** A workspace is going away: every canvas in it becomes personal again.
   *  Returns the ids of the canvases it moved. */
  detachWorkspace(workspaceId: string): string[] {
    const moved: string[] = []
    for (const c of this.canvases.values()) {
      if (c.workspaceId === workspaceId) {
        requireBoundary('store.detachWorkspace')
        this.remember(c, ['workspaceId'])
        delete c.workspaceId
        this.saveCanvasLater(c)
        moved.push(c.id)
      }
    }
    return moved
  }

  /* ---- community gallery ---- */

  /** List (or re-describe) a canvas in the gallery. Keeps the original
   *  publish date on edits so "newest" stays honest. Not a design edit, so
   *  updatedAt is left alone. */
  publishCanvas(id: string, listing: { description: string; category: CommunityCategory }): Canvas | undefined {
    const c = this.canvases.get(id)
    if (!c) return undefined
    requireBoundary('store.publishCanvas')
    this.remember(c, ['publishedAt', 'category', 'description'])
    c.publishedAt ??= Date.now()
    c.category = listing.category
    if (listing.description) c.description = listing.description
    else delete c.description
    this.saveCanvasLater(c)
    return c
  }

  unpublishCanvas(id: string): Canvas | undefined {
    const c = this.canvases.get(id)
    if (!c) return undefined
    requireBoundary('store.unpublishCanvas')
    this.remember(c, ['publishedAt', 'category', 'description'])
    delete c.publishedAt
    delete c.description
    delete c.category
    this.saveCanvasLater(c)
    return c
  }

  /** Every published canvas, newest listing first. Access is deliberately
   *  not a question here: publishing is the owner's opt-in, and the gallery
   *  exposes previews and copies, never the canvas itself. */
  listPublished(): Canvas[] {
    return [...this.canvases.values()]
      .filter((c) => c.publishedAt !== undefined)
      .sort((a, b) => b.publishedAt! - a.publishedAt!)
  }

  /** A gallery copy went out — the trending signal. */
  recordCommunityCopy(id: string) {
    const c = this.canvases.get(id)
    if (!c) return
    requireBoundary('store.recordCommunityCopy')
    this.remember(c, ['copyCount'])
    c.copyCount = (c.copyCount ?? 0) + 1
    this.saveCanvasLater(c)
  }

  /** Invite a user to collaborate. Idempotent; the owner is never listed. */
  addMember(canvasId: string, userId: string, addedBy: string): Canvas | undefined {
    const c = this.canvases.get(canvasId)
    if (!c || c.ownerId === userId) return c
    if (!c.memberIds?.includes(userId)) {
      requireBoundary('store.addMember')
      this.remember(c, ['memberIds'])
      ;(c.memberIds ??= []).push(userId)
      const at = Date.now()
      afterCommit(() => persist.saveMember(canvasId, userId, addedBy, at))
    }
    return c
  }

  removeMember(canvasId: string, userId: string): boolean {
    const c = this.canvases.get(canvasId)
    const idx = c?.memberIds?.indexOf(userId) ?? -1
    if (!c || idx === -1) return false
    requireBoundary('store.removeMember')
    this.remember(c, ['memberIds'])
    c.memberIds!.splice(idx, 1)
    afterCommit(() => persist.deleteMember(canvasId, userId))
    return true
  }

  renameCanvas(id: string, name: string) {
    const c = this.canvases.get(id)
    if (!c) return undefined
    requireBoundary('store.renameCanvas')
    this.remember(c, ['name', 'updatedAt'])
    c.name = name
    c.updatedAt = Date.now()
    this.saveCanvasLater(c)
    return c
  }

  getComponents(canvasId: string): ComponentDef[] {
    return this.canvases.get(canvasId)?.components ?? []
  }

  /** Add or replace by id; the database hears at the commit. Definitions are replaced,
   *  never changed in place, so the one this replaced is what an undo puts back. */
  saveComponent(canvasId: string, def: ComponentDef) {
    const c = this.canvases.get(canvasId)
    if (!c) return
    requireBoundary('store.saveComponent')
    const list = (c.components ??= [])
    const at = list.findIndex((existing) => existing.id === def.id)
    const replaced = at === -1 ? undefined : list[at]
    if (at === -1) list.push(def)
    else list[at] = def
    recordUndo(() => {
      /* saved again since by someone else: theirs stands */
      const now = c.components?.indexOf(def) ?? -1
      if (now === -1) return
      if (replaced) c.components![now] = replaced
      else c.components!.splice(now, 1)
    })
    /* a definition replaced again before the commit was never the stored one */
    afterCommit(() => {
      if (this.canvases.get(canvasId) === c && c.components?.includes(def)) persist.saveComponent(canvasId, def)
    })
  }

  deleteComponent(canvasId: string, id: string): boolean {
    const c = this.canvases.get(canvasId)
    const at = c?.components?.findIndex((def) => def.id === id) ?? -1
    if (!c?.components || at === -1) return false
    requireBoundary('store.deleteComponent')
    const [removed] = c.components.splice(at, 1)
    recordUndo(() => {
      const list = (c.components ??= [])
      if (removed && !list.some((def) => def.id === id)) list.splice(Math.min(at, list.length), 0, removed)
    })
    afterCommit(() => {
      if (!c.components?.some((def) => def.id === id)) persist.deleteComponent(canvasId, id)
    })
    return true
  }

  getGuidelines(canvasId: string): GuidelineDoc[] {
    return this.canvases.get(canvasId)?.guidelines ?? []
  }

  /** Upsert a design doc by name. New docs without a position are auto-placed
   *  as a card to the left of the frames, stacked downward. */
  setGuideline(
    canvasId: string,
    name: string,
    markdown: string,
    by: string,
    pos?: { x: number; y: number },
    title?: string,
  ): GuidelineDoc | undefined {
    const c = this.canvases.get(canvasId)
    if (!c) return undefined
    requireBoundary('store.setGuideline')
    this.remember(c, ['guidelines', 'updatedAt'], true)
    const docs = (c.guidelines ??= [])
    const now = Date.now()
    let doc = docs.find((d) => d.name === name)
    if (doc) {
      doc.markdown = markdown
      doc.updatedAt = now
      doc.updatedBy = by
      if (pos) Object.assign(doc, pos)
      if (title !== undefined) doc.title = title || undefined
    } else {
      const placed = pos ?? this.placeGuideline(c, docs.length)
      doc = { name, markdown, ...(title ? { title } : {}), updatedAt: now, updatedBy: by, ...placed }
      docs.push(doc)
      docs.sort((a, b) => a.name.localeCompare(b.name))
    }
    c.updatedAt = now
    const saved = doc
    afterCommit(() => persist.saveGuideline(canvasId, saved))
    this.saveCanvasLater(c)
    return doc
  }

  private placeGuideline(c: Canvas, index: number): { x: number; y: number } {
    const CARD_W = 360
    if (!c.frames.length) return { x: 120, y: 120 + index * 380 }
    const minX = Math.min(...c.frames.map((f) => f.x))
    const minY = Math.min(...c.frames.map((f) => f.y))
    return { x: minX - CARD_W - 100, y: minY + index * 380 }
  }

  /** Patch card position / display title; content and history stay untouched. */
  patchGuideline(
    canvasId: string,
    name: string,
    patch: { x?: number; y?: number; title?: string },
  ): GuidelineDoc | undefined {
    const c = this.canvases.get(canvasId)
    const doc = c?.guidelines?.find((d) => d.name === name)
    if (!c || !doc) return undefined
    requireBoundary('store.patchGuideline')
    const before = { x: doc.x, y: doc.y, title: doc.title }
    recordUndo(() => Object.assign(doc, before))
    if (patch.x !== undefined) doc.x = patch.x
    if (patch.y !== undefined) doc.y = patch.y
    if (patch.title !== undefined) doc.title = patch.title || undefined
    afterCommit(() => persist.saveGuideline(canvasId, doc))
    return doc
  }

  deleteGuideline(canvasId: string, name: string): boolean {
    const c = this.canvases.get(canvasId)
    const idx = c?.guidelines?.findIndex((d) => d.name === name) ?? -1
    if (!c || idx === -1) return false
    requireBoundary('store.deleteGuideline')
    this.remember(c, ['guidelines', 'updatedAt'])
    c.guidelines!.splice(idx, 1)
    c.updatedAt = Date.now()
    afterCommit(() => persist.deleteGuideline(canvasId, name))
    this.saveCanvasLater(c)
    return true
  }

  getTokens(canvasId: string): DesignToken[] {
    return this.canvases.get(canvasId)?.tokens ?? []
  }

  /** Upsert tokens by name: a new one lands at the end of its canvas's
   *  order, an existing one keeps its place unless the patch moves it. */
  setTokens(
    canvasId: string,
    inputs: (Pick<DesignToken, 'name' | 'type' | 'value'> & {
      themes?: Record<string, string>
      description?: string
      order?: number
    })[],
    by: string,
  ): DesignToken[] | undefined {
    const c = this.canvases.get(canvasId)
    if (!c) return undefined
    requireBoundary('store.setTokens')
    this.remember(c, ['tokens', 'updatedAt'], true)
    const tokens = (c.tokens ??= [])
    const now = Date.now()
    const written: DesignToken[] = []
    for (const input of inputs) {
      let token = tokens.find((t) => t.name === input.name)
      if (token) {
        token.type = input.type
        token.value = input.value
        token.themes = input.themes && Object.keys(input.themes).length ? input.themes : undefined
        token.description = input.description || undefined
        if (input.order !== undefined) token.order = input.order
        token.updatedAt = now
        token.updatedBy = by
      } else {
        const last = tokens.reduce((max, t) => Math.max(max, t.order), 0)
        token = {
          name: input.name,
          type: input.type,
          value: input.value,
          ...(input.themes && Object.keys(input.themes).length ? { themes: input.themes } : {}),
          ...(input.description ? { description: input.description } : {}),
          order: input.order ?? last + 1,
          updatedAt: now,
          updatedBy: by,
        }
        tokens.push(token)
      }
      const saved = token
      afterCommit(() => persist.saveToken(canvasId, saved))
      written.push(token)
    }
    tokens.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
    c.updatedAt = now
    this.saveCanvasLater(c)
    return written
  }

  /** Rename a token in place: its order and description ride along. */
  renameToken(canvasId: string, name: string, newName: string, by: string): DesignToken | undefined {
    const c = this.canvases.get(canvasId)
    const token = c?.tokens?.find((t) => t.name === name)
    if (!c || !token) return undefined
    requireBoundary('store.renameToken')
    /* the whole list, as setTokens does: a later setTokens undo swaps in its own copies of the
       tokens, so putting the old name back on this object alone would miss the one in the list */
    this.remember(c, ['tokens', 'updatedAt'], true)
    afterCommit(() => persist.deleteToken(canvasId, name))
    token.name = newName
    token.updatedAt = Date.now()
    token.updatedBy = by
    afterCommit(() => persist.saveToken(canvasId, token))
    c.updatedAt = token.updatedAt
    this.saveCanvasLater(c)
    return token
  }

  getTokenThemes(canvasId: string): string[] {
    return this.canvases.get(canvasId)?.tokenThemes ?? []
  }

  /** Replace the theme list; tokens drop the values of themes that left. */
  setTokenThemes(canvasId: string, themes: string[], by: string): string[] | undefined {
    const c = this.canvases.get(canvasId)
    if (!c) return undefined
    requireBoundary('store.setTokenThemes')
    this.remember(c, ['tokens', 'tokenThemes', 'updatedAt'], true)
    c.tokenThemes = themes.length ? [...themes] : undefined
    const now = Date.now()
    for (const token of c.tokens ?? []) {
      if (!token.themes) continue
      const kept = Object.fromEntries(Object.entries(token.themes).filter(([theme]) => themes.includes(theme)))
      if (Object.keys(kept).length === Object.keys(token.themes).length) continue
      token.themes = Object.keys(kept).length ? kept : undefined
      token.updatedAt = now
      token.updatedBy = by
      afterCommit(() => persist.saveToken(canvasId, token))
    }
    c.updatedAt = now
    this.saveCanvasLater(c)
    return themes
  }

  /** Rename a theme: the list entry and every token's value under it. */
  renameTokenTheme(canvasId: string, from: string, to: string, by: string): boolean {
    const c = this.canvases.get(canvasId)
    if (!c || !c.tokenThemes?.includes(from)) return false
    requireBoundary('store.renameTokenTheme')
    this.remember(c, ['tokens', 'tokenThemes', 'updatedAt'], true)
    c.tokenThemes = c.tokenThemes.map((theme) => (theme === from ? to : theme))
    const now = Date.now()
    for (const token of c.tokens ?? []) {
      if (!token.themes || !(from in token.themes)) continue
      const { [from]: moved, ...rest } = token.themes
      token.themes = { ...rest, ...(moved === undefined ? {} : { [to]: moved }) }
      token.updatedAt = now
      token.updatedBy = by
      afterCommit(() => persist.saveToken(canvasId, token))
    }
    c.updatedAt = now
    this.saveCanvasLater(c)
    return true
  }

  deleteToken(canvasId: string, name: string): boolean {
    const c = this.canvases.get(canvasId)
    const idx = c?.tokens?.findIndex((t) => t.name === name) ?? -1
    if (!c || idx === -1) return false
    requireBoundary('store.deleteToken')
    this.remember(c, ['tokens', 'updatedAt'])
    c.tokens!.splice(idx, 1)
    c.updatedAt = Date.now()
    afterCommit(() => persist.deleteToken(canvasId, name))
    this.saveCanvasLater(c)
    return true
  }

  getReferences(canvasId: string): MemoryReference[] {
    return this.canvases.get(canvasId)?.references ?? []
  }

  /** Pin a frame to Memory: snapshot its HTML now, decoupled from the frame. */
  addReference(canvasId: string, frame: Frame, by: string): MemoryReference | undefined {
    const c = this.canvases.get(canvasId)
    if (!c) return undefined
    const ref: MemoryReference = {
      id: nanoid(10),
      frameId: frame.id,
      title: frame.name,
      html: frame.html,
      width: frame.width,
      height: frame.height,
      pinnedBy: by,
      pinnedAt: Date.now(),
    }
    requireBoundary('store.addReference')
    this.remember(c, ['references'])
    ;(c.references ??= []).unshift(ref)
    afterCommit(() => persist.saveReference(canvasId, ref))
    return ref
  }

  deleteReference(canvasId: string, id: string): MemoryReference | undefined {
    const c = this.canvases.get(canvasId)
    const idx = c?.references?.findIndex((r) => r.id === id) ?? -1
    if (!c || idx === -1) return undefined
    requireBoundary('store.deleteReference')
    this.remember(c, ['references'])
    const [ref] = c.references!.splice(idx, 1)
    afterCommit(() => persist.deleteReference(id))
    return ref
  }

  getFrame(frameId: string): Frame | undefined {
    const canvasId = this.frameIndex.get(frameId)
    if (!canvasId) return undefined
    return this.canvases.get(canvasId)?.frames.find((f) => f.id === frameId)
  }

  /** The live frame, undefined when there is none, and FrameDeletedError when
   *  it sits in the trash. Every writer asks here, so a deleted frame is
   *  refused in one place. */
  writableFrame(frameId: string): Frame | undefined {
    const frame = this.getFrame(frameId)
    if (frame) return frame
    const deleted = this.getDeletedFrame(frameId)
    if (deleted) throw new FrameDeletedError(deleted)
    return undefined
  }

  getDeletedFrame(frameId: string): Frame | undefined {
    const canvasId = this.deletedIndex.get(frameId)
    return canvasId ? this.trash.get(canvasId)?.frames.find((f) => f.id === frameId) : undefined
  }

  getDeletedPage(canvasId: string, pageId: string): CanvasPageInfo | undefined {
    return this.trash.get(canvasId)?.pages.find((d) => d.page.id === pageId)?.page
  }

  /** What a canvas's trash holds: deleted frames and deleted pages. A frame being deleted forever is listed as a
   *  copy marked `purging: true`; the stored frame is never marked. */
  listTrash(canvasId: string): { frames: Array<Frame & { purging?: true }>; pages: DeletedPage[] } {
    const entry = this.trash.get(canvasId)
    const frames = (entry?.frames ?? []).map((f) => (this.purging.has(f.id) ? { ...f, purging: true as const } : f))
    return { frames, pages: [...(entry?.pages ?? [])] }
  }

  /** Is a "delete forever" open on this frame? Restores and snapshot restores leave such a frame alone. */
  isPurging(frameId: string): boolean {
    return this.purging.has(frameId)
  }

  /**
   * Open a "delete forever" on a Trash frame (CHE-9399 step 2): raise the persist fence, mark the frame purging
   * and tell the room. Every check runs before the first change, so a refusal leaves nothing behind: no mark, no
   * fence, nothing sent. Writes nothing and removes nothing; the caller ends the lease with `release()` (purge
   * called off) or `actions.finishCommitted` (purge committed), and an undone transaction releases it too.
   *  - `PolicyRefused` / `FrameLockedError`: `purge_frame` is a person's act and the lock rule holds;
   *  - `PurgeRefusedError`: `not_in_trash`, `stale_confirmation` (the caller's `deletedAt` is not the frame's),
   *    `has_comments` (`hasComments()` says so, or a comment write for it is still on its way to the database);
   *  - `PurgeInProgressError`: another lease is open on the frame.
   * `notify` is called in its own try/catch each time: a throw there is logged and changes nothing.
   */
  beginPurge(
    ctx: WriteContext,
    frameId: string,
    deletedAt: number,
    hasComments: () => boolean,
    notify: (event: PurgeEvent) => void,
  ): PurgeLease {
    const canvasId = this.deletedIndex.get(frameId)
    const canvas = canvasId ? this.canvases.get(canvasId) : undefined
    const frame = canvasId ? this.trash.get(canvasId)?.frames.find((f) => f.id === frameId) : undefined
    if (!canvasId || !canvas || !frame) throw new PurgeRefusedError('not_in_trash', frameId)
    requireBoundary('store.beginPurge')
    assertWritable(ctx, 'purge_frame', { canvas, frame, pageIds: frame.pageId ? [frame.pageId] : [] })
    if (this.purging.has(frameId)) throw new PurgeInProgressError(frameId)
    if (frame.deletedAt !== deletedAt) throw new PurgeRefusedError('stale_confirmation', frameId)
    if (canvas.components?.some((def) => def.mainFrameId === frameId))
      throw new PurgeRefusedError('component_main', frameId)
    if (hasComments() || persist.commentWritesPending(frameId) > 0) throw new PurgeRefusedError('has_comments', frameId)

    const fence = persist.fenceFrame(frameId)
    const send = (event: PurgeEvent) => {
      try {
        notify(event)
      } catch (error) {
        console.error('[purge] notify failed', event.type, frameId, error)
      }
    }
    const lease: PurgeLease = {
      frameId,
      canvasId,
      frameName: frame.name,
      outcome: fence.outcome,
      release: () => {
        const state = leases.get(lease)
        if (!state || state.status !== 'open') return
        state.status = 'released'
        if (this.purging.get(frameId) === state) this.purging.delete(frameId)
        fence.release()
        send({ type: 'trash:purge_state', frameId, canvasId, purging: false })
      },
    }
    const state: PurgeState = { lease, frame, status: 'open', send }
    leases.set(lease, state)
    this.purging.set(frameId, state)
    recordUndo(() => lease.release())
    send({ type: 'trash:purge_state', frameId, canvasId, purging: true })
    return lease
  }

  /**
   * The purge's rows are gone (the database committed): take the frame out of memory and settle the fence as
   * `purged`, so held writers drop. Idempotent: a second call changes nothing and returns the first receipt.
   * Only the same frame object leaves the Trash. Not undoable: the rows cannot come back.
   */
  /** Has `commitPurge` run for this lease? (`lease.receipt` is not the answer: the commit path sets it before COMMIT.) */
  purgeFinalized(lease: PurgeLease): boolean {
    return leases.get(lease)?.status === 'purged'
  }

  commitPurge(lease: PurgeLease, receipt: PurgeReceipt): PurgeReceipt {
    const state = leases.get(lease)
    if (!state) throw new Error(`commitPurge: no lease for frame ${lease.frameId}`)
    if (state.status === 'purged') return lease.receipt ?? receipt
    state.status = 'purged'
    lease.receipt = receipt
    if (this.purging.get(lease.frameId) === state) this.purging.delete(lease.frameId)
    const entry = this.trash.get(lease.canvasId)
    if (entry?.frames.includes(state.frame)) {
      entry.frames = entry.frames.filter((f) => f !== state.frame)
      this.deletedIndex.delete(lease.frameId)
    }
    persist.forgetFrame(lease.frameId)
    state.send({ type: 'frame:purged', frameId: lease.frameId, canvasId: lease.canvasId })
    return receipt
  }

  private trashOf(canvasId: string) {
    let entry = this.trash.get(canvasId)
    if (!entry) this.trash.set(canvasId, (entry = { frames: [], pages: [] }))
    return entry
  }

  createFrame(
    ctx: WriteContext,
    canvasId: string,
    input: {
      name: string
      pageId?: string
      x?: number
      y?: number
      width?: number
      height?: number
      html?: string
      demo?: boolean
      hidden?: boolean
      locked?: boolean
      /** why it is locked (only read with `locked`) */
      lockReason?: string
      /** where it stacks (undo brings a deleted frame back to its place);
       *  in front of everything on the page when unset */
      z?: number
      rotation?: number
    },
    by: string,
  ): Frame | undefined {
    const c = this.canvases.get(canvasId)
    if (!c) return undefined
    const pageId = input.pageId ?? defaultWritePageId(c)
    if (!pageId) throw new NoOpenPageError()
    if (!canvasPages(c).some((page) => page.id === pageId)) return undefined
    assertWritable(ctx, 'create_frame', { canvas: c, pageIds: [pageId], html: input.html })
    const frames = pageFrames(c, pageId)
    const now = Date.now()
    // auto-place: to the right of the right-most frame
    const at = defaultSpot(frames)
    const x = input.x ?? at.x
    const y = input.y ?? at.y
    const frame: Frame = {
      id: nanoid(10),
      canvasId,
      pageId,
      name: input.name,
      x,
      y,
      width: input.width ?? 640,
      height: input.height ?? 480,
      html: input.html ?? '',
      createdAt: now,
      updatedAt: now,
      updatedBy: by,
      z: input.z ?? frontOf(frames) ?? now,
    }
    if (input.demo) frame.demo = true
    if (input.hidden) frame.hidden = true
    if (input.locked) {
      frame.locked = true
      stampLock(frame, by, now, input.lockReason)
    }
    if (input.rotation) frame.rotation = input.rotation
    requireBoundary('store.createFrame')
    c.frames.push(frame)
    c.frames.sort(byStack)
    this.frameIndex.set(frame.id, canvasId)
    recordUndo(() => {
      const at = c.frames.indexOf(frame)
      if (at !== -1) c.frames.splice(at, 1)
      if (this.frameIndex.get(frame.id) === canvasId) this.frameIndex.delete(frame.id)
    })
    this.touchCanvas(c, now)
    this.saveFrameLater(frame, true)
    this.saveCanvasLater(c)
    return frame
  }

  updateFrame(
    ctx: WriteContext,
    frameId: string,
    patch: Partial<
      Pick<
        Frame,
        | 'name'
        | 'pageId'
        | 'x'
        | 'y'
        | 'width'
        | 'height'
        | 'html'
        | 'hidden'
        | 'locked'
        | 'lockReason'
        | 'z'
        | 'rotation'
        | 'approval'
        | 'archiveOrigin'
      >
    >,
    by: string,
    opts: {
      /** the html change only marks elements up (a `data-doop-id` stamp):
       *  nothing a reviewer signed off on moved, so sign-off stands */
      annotation?: boolean
      /** conditional write: refused with `FrameStaleError` unless the frame's
       *  `updatedAt` is still this value, so a writer that read an old version
       *  cannot overwrite a newer one */
      expectedUpdatedAt?: number
    } = {},
  ): Frame | undefined {
    const frame = this.writableFrame(frameId)
    if (!frame) return undefined
    // The one guard for a locked frame (every actor, every path, CHE-6626). Synchronous: the check and
    // the write below share one tick, so a lock cannot land between them. Nothing but an owner's
    // unlock, and only on its own, gets past it; `assertWritable` decides whose unlock that is.
    const unlocking = frame.locked === true && patch.locked === false
    if (
      unlocking &&
      Object.keys(patch).some((key) => key !== 'locked' && patch[key as keyof typeof patch] !== undefined)
    )
      throw new PolicyRefused('unlock_frame', 'unlock changes nothing else; edit after it')
    /* the reason rides with a lock and is no part of any other write: it is read here and kept off the frame */
    const { lockReason, ...unreasoned } = patch
    patch = unreasoned
    const c = this.canvases.get(frame.canvasId)!
    /* a lock on a frame that is already locked changes nothing (S1): a retry keeps the first who, when and why.
       The policy still decides whether this actor may lock; any other key on the patch is a write, refused below. */
    if (
      frame.locked &&
      patch.locked === true &&
      Object.keys(patch).every((key) => key === 'locked' || patch[key as keyof typeof patch] === undefined)
    ) {
      assertWritable(ctx, 'lock_frame', { canvas: c, frame, pageIds: [framePageId(c, frame)] })
      return frame
    }
    if (frame.locked && !unlocking) throw new FrameLockedError(frame)
    if (opts.expectedUpdatedAt !== undefined && opts.expectedUpdatedAt !== frame.updatedAt)
      throw new FrameStaleError(frame)
    if (
      patch.pageId !== undefined &&
      !canvasPages(this.canvases.get(frame.canvasId)!).some((p) => p.id === patch.pageId)
    )
      return undefined
    /* the one write a Finished page lets through: the lifecycle locking a frame, with nothing else in the patch */
    const lockOnly =
      !frame.locked &&
      patch.locked === true &&
      Object.keys(patch).every((key) => key === 'locked' || patch[key as keyof typeof patch] === undefined)
    assertWritable(ctx, unlocking ? 'unlock_frame' : 'update_frame', {
      canvas: c,
      frame,
      pageIds: patch.pageId !== undefined ? [framePageId(c, frame), patch.pageId] : [framePageId(c, frame)],
      ...(lockOnly ? { lockOnly } : {}),
    })
    /* B5: a pin outranks an owner; the owner's way out is force_release */
    if (unlocking && isPinned(frameId))
      throw new PolicyRefused('unlock_frame', 'pinned: a decision card holds this frame')
    const designChanged =
      !opts.annotation && DESIGN_KEYS.some((key) => patch[key] !== undefined && patch[key] !== frame[key])
    requireBoundary('store.updateFrame')
    const before = inTransaction() ? frameState(frame) : undefined
    /* a frame moved to another page lands in front there, as Figma does */
    if (patch.pageId !== undefined && patch.pageId !== frame.pageId && patch.z === undefined)
      patch = { ...patch, z: frontOf(pageFrames(c, patch.pageId)) ?? frame.z }
    /* a frame moved out of the Archive by any writer is no longer archived: its origin goes with it */
    if (
      patch.pageId !== undefined &&
      patch.pageId !== ARCHIVE_PAGE_ID &&
      frame.archiveOrigin &&
      !('archiveOrigin' in patch)
    )
      patch = { ...patch, archiveOrigin: undefined }
    Object.assign(frame, patch)
    if (patch.locked === true) stampLock(frame, by, Date.now(), lockReason)
    if (unlocking) {
      /* the epoch only goes up, so a lock decision made before this unlock can never be replayed after it */
      frame.lockEpoch = (frame.lockEpoch ?? 0) + 1
      delete frame.lockAttestationId
      clearLockStamp(frame)
    }
    if (patch.z !== undefined) c.frames.sort(byStack)
    // All writers (including streams, sync and restores) invalidate sign-off.
    if (designChanged && frame.approval?.status === 'ready_for_dev') {
      frame.approval = { ...frame.approval, status: 'needs_review' }
    }
    // Also serves as the optimistic-save version, including writes in the same millisecond.
    frame.updatedAt = Math.max(Date.now(), frame.updatedAt + 1)
    frame.updatedBy = by
    const stamp = frame.updatedAt
    const restacked = patch.z !== undefined
    if (before)
      recordUndo(({ yielded, repair }) => {
        /* written again since by someone else (this one awaited meanwhile), or gone: theirs stands */
        if (this.getFrame(frame.id) !== frame || frame.updatedAt !== stamp) return
        restoreFrame(frame, before)
        if (restacked) c.frames.sort(byStack)
        /* a write already on its debounce may have stored this frame while the operation
           awaited: the row goes back to what the frame is again, once every undo has run,
           and only if the frame is still there (one this transaction created is not) */
        if (yielded && before.loaded)
          repair(`frame:${frame.id}`, () => {
            if (this.getFrame(frame.id) === frame) persist.saveFrame(frame)
          })
      })
    this.touchCanvas(c, stamp)
    this.saveFrameLater(frame) // debounced: streaming appends land as one write per burst
    this.saveCanvasLater(c)
    return frame
  }

  /** Compare-and-set lock (CHE-6626): locks the frame only if it is still at `attestedUpdatedAt`, the
   *  version a G3 attestation covers. A lock does not move `updatedAt`, so the attestation stays current.
   *  A frame that is already locked keeps its attestation: the same id again at the current version is a no-op
   *  (`already`, a retry), at another version `version_changed`; any other id, or a lock that carries none,
   *  is refused until an owner unlocks it.
   *  Undefined = not found; a refused write throws PolicyRefused. */
  lockIfVersion(
    ctx: WriteContext,
    frameId: string,
    attestedUpdatedAt: number,
    attestationId: string,
    /** who locks (the actor's name), recorded as `lockedBy` */
    by: string = UNKNOWN_LOCKER,
  ):
    | { ok: true; frame: Frame; already?: true }
    | { ok: false; error: 'version_changed'; currentUpdatedAt: number }
    | undefined {
    const out = this.applyLock(ctx, frameId, attestedUpdatedAt, attestationId, by)
    if (out?.ok && !out.already) this.saveFrameLater(out.frame, true)
    return out
  }

  /** The in-memory half of a lock; the callers decide how it becomes durable. */
  private applyLock(ctx: WriteContext, frameId: string, attestedUpdatedAt: number, attestationId: string, by: string) {
    const frame = this.writableFrame(frameId)
    if (!frame) return undefined
    const c = this.canvases.get(frame.canvasId)!
    assertWritable(ctx, 'lock_frame', { canvas: c, frame, pageIds: [framePageId(c, frame)] })
    if (frame.locked && frame.lockAttestationId !== attestationId)
      throw new PolicyRefused('lock_frame', 'the frame is locked with another attestation; an owner unlocks it first')
    /* the version check comes first for a retry too: a late retry of an older attempt must not pass */
    if (frame.updatedAt !== attestedUpdatedAt)
      return { ok: false as const, error: 'version_changed' as const, currentUpdatedAt: frame.updatedAt }
    if (frame.locked) return { ok: true as const, frame, already: true as const }
    requireBoundary('store.lockIfVersion')
    const before = inTransaction() ? frameState(frame) : undefined
    frame.locked = true
    frame.lockAttestationId = attestationId
    stampLock(frame, by, Date.now())
    if (before)
      recordUndo(() => {
        if (this.getFrame(frame.id) === frame && frame.lockAttestationId === attestationId) restoreFrame(frame, before)
      })
    return { ok: true as const, frame }
  }

  /** Durable lock (CHE-7062 B7): a narrowing write. The lock shows in memory at once (so nothing slips in) but the
   *  answer waits for the row; a failed write puts the frame back as it was. Serialised with every pin step. */
  lockIfVersionDurable(
    ctx: WriteContext,
    frameId: string,
    attestedUpdatedAt: number,
    attestationId: string,
    by: string = UNKNOWN_LOCKER,
  ): Promise<
    | { ok: true; frame: Frame; epoch: number; already?: true }
    | { ok: false; error: 'version_changed' | 'persist_failed'; currentUpdatedAt?: number }
    | undefined
  > {
    return exclusive(async () => {
      const before = this.getFrame(frameId)
      const was = {
        locked: before?.locked,
        attestationId: before?.lockAttestationId,
        lockedBy: before?.lockedBy,
        lockedAt: before?.lockedAt,
        lockReason: before?.lockReason,
      }
      const out = this.applyLock(ctx, frameId, attestedUpdatedAt, attestationId, by)
      if (!out || !out.ok) return out
      const { frame } = out
      if (out.already) return { ...out, epoch: frame.lockEpoch ?? 0 }
      try {
        await pinHooks.beforeWrite?.('lock')
        await persist.saveFrameNow(frame)
      } catch {
        frame.locked = was.locked
        if (was.attestationId === undefined) delete frame.lockAttestationId
        else frame.lockAttestationId = was.attestationId
        clearLockStamp(frame)
        if (was.lockedBy !== undefined) stampLock(frame, was.lockedBy, was.lockedAt!, was.lockReason)
        return { ok: false, error: 'persist_failed' }
      }
      return { ...out, epoch: frame.lockEpoch ?? 0 }
    })
  }

  /** Durable unlock (CHE-7062 B5/B7): `pinned` while a pin holds the frame; otherwise a loosening write, so the row
   *  goes first and memory changes only once it is durable. Same policy as the synchronous unlock (owners only). */
  unlockFrame(
    ctx: WriteContext,
    frameId: string,
    by: string,
    expectedUpdatedAt?: number,
  ): Promise<
    | { ok: true; frame: Frame }
    | { ok: false; error: 'pinned' | 'version_changed' | 'persist_failed' | 'not_locked' }
    | undefined
  > {
    return exclusive(async () => {
      const frame = this.getFrame(frameId)
      if (!frame) return undefined
      if (!frame.locked) return { ok: false, error: 'not_locked' }
      const c = this.canvases.get(frame.canvasId)!
      assertWritable(ctx, 'unlock_frame', { canvas: c, frame, pageIds: [framePageId(c, frame)] })
      if (isPinned(frameId)) return { ok: false, error: 'pinned' }
      if (expectedUpdatedAt !== undefined && frame.updatedAt !== expectedUpdatedAt)
        return { ok: false, error: 'version_changed' }
      const next: Frame = {
        ...frame,
        locked: false,
        lockEpoch: (frame.lockEpoch ?? 0) + 1,
        updatedAt: Math.max(Date.now(), frame.updatedAt + 1),
        updatedBy: by,
      }
      delete next.lockAttestationId
      clearLockStamp(next)
      try {
        await pinHooks.beforeWrite?.('unlock')
        await persist.saveFrameNow(next)
      } catch {
        return { ok: false, error: 'persist_failed' }
      }
      frame.locked = false
      frame.lockEpoch = next.lockEpoch
      delete frame.lockAttestationId
      clearLockStamp(frame)
      frame.updatedAt = next.updatedAt
      frame.updatedBy = by
      c.updatedAt = frame.updatedAt
      persist.saveCanvas(c)
      return { ok: true, frame }
    })
  }

  /** F1 on a void card (CHE-7062): after the database has the new epochs, memory takes them. */
  setLockEpochs(epochs: { frameId: string; epoch: number }[]): void {
    for (const e of epochs) {
      const frame = this.getFrame(e.frameId)
      if (frame) frame.lockEpoch = e.epoch
    }
  }

  /** Schedule the write of a frame as it is now, without changing it. A pass-through for callers outside
   *  the store (an undo that kept part of a write, a trashed frame whose row an in-flight save overwrote):
   *  the state was already changed under a policy check, this only puts it on disk. */
  persistFrame(frame: Frame, immediate = false): void {
    persist.saveFrame(frame, immediate)
  }

  /** Put back html, size and (optionally) the stamp and approval of a write that did not commit. This
   *  undoes the caller's own write, so it passes the lock: the frame goes back to a state it already had.
   *  Synchronous, like `updateFrame`; the caller decides what is still theirs to take back. */
  rollbackFrame(
    frameId: string,
    to: Pick<Frame, 'html' | 'width' | 'height' | 'approval'> & Partial<Pick<Frame, 'updatedAt' | 'updatedBy'>>,
  ): Frame | undefined {
    const frame = this.getFrame(frameId)
    if (!frame) return undefined
    frame.html = to.html
    frame.width = to.width
    frame.height = to.height
    frame.approval = to.approval
    if (to.updatedAt !== undefined) frame.updatedAt = to.updatedAt
    if (to.updatedBy !== undefined) frame.updatedBy = to.updatedBy
    const c = this.canvases.get(frame.canvasId)
    if (c && to.updatedAt !== undefined) c.updatedAt = frame.updatedAt
    return frame
  }

  /** Soft delete: the frame leaves the canvas and waits in the trash with
   *  its version rows; nothing is removed from the database. */
  deleteFrame(ctx: WriteContext, frameId: string): Frame | undefined {
    const canvasId = this.frameIndex.get(frameId)
    if (!canvasId) return undefined
    const c = this.canvases.get(canvasId)
    if (!c) return undefined
    const idx = c.frames.findIndex((f) => f.id === frameId)
    if (idx === -1) return undefined
    requireBoundary('store.deleteFrame')
    assertWritable(ctx, 'delete_frame', { canvas: c, frame: c.frames[idx]!, pageIds: [framePageId(c, c.frames[idx]!)] })
    const [frame] = c.frames.splice(idx, 1)
    const deletedAt = Date.now()
    frame!.deletedAt = deletedAt
    this.frameIndex.delete(frameId)
    this.trashOf(canvasId).frames.push(frame!)
    this.deletedIndex.set(frameId, canvasId)
    recordUndo(() => {
      if (!frame || this.canvases.get(canvasId) !== c || this.frameIndex.has(frameId)) return
      const entry = this.trashOf(canvasId)
      entry.frames = entry.frames.filter((f) => f !== frame)
      this.deletedIndex.delete(frameId)
      delete frame.deletedAt
      c.frames.push(frame)
      c.frames.sort(byStack)
      this.frameIndex.set(frameId, canvasId)
    })
    this.touchCanvas(c, deletedAt)
    this.saveTrashedFrameLater(frame!, canvasId)
    this.saveCanvasLater(c)
    return frame
  }

  /** Bring a deleted frame back to its page (an open page, else the ledger, when that page is gone;
   *  NoOpenPageError when neither exists). Undefined when it is not in the trash. */
  restoreFrame(frameId: string): Frame | undefined {
    const canvasId = this.deletedIndex.get(frameId)
    const c = canvasId ? this.canvases.get(canvasId) : undefined
    const entry = canvasId ? this.trash.get(canvasId) : undefined
    const frame = entry?.frames.find((f) => f.id === frameId)
    if (!canvasId || !c || !entry || !frame) return undefined
    /* before anything moves: a frame being deleted forever stays in the trash */
    if (this.purging.has(frameId)) throw new PurgeInProgressError(frameId)
    const pages = canvasPages(c)
    const pageId = frame.pageId && pages.some((page) => page.id === frame.pageId) ? frame.pageId : recoveryPageId(c)
    /* before anything moves: the frame stays in the trash */
    if (!pageId) throw new NoOpenPageError()
    assertPagesOpen(c, [pageId], 'restore_frame')
    requireBoundary('store.restoreFrame')
    const before = { pageId: frame.pageId, updatedAt: frame.updatedAt, deletedAt: frame.deletedAt }
    entry.frames = entry.frames.filter((f) => f !== frame)
    this.deletedIndex.delete(frameId)
    delete frame.deletedAt
    frame.pageId = pageId
    frame.updatedAt = Math.max(Date.now(), frame.updatedAt + 1)
    c.frames.push(frame)
    c.frames.sort(byStack)
    this.frameIndex.set(frameId, canvasId)
    recordUndo(() => {
      if (this.canvases.get(canvasId) !== c || this.deletedIndex.has(frameId)) return
      c.frames = c.frames.filter((f) => f !== frame)
      this.frameIndex.delete(frameId)
      Object.assign(frame, { pageId: before.pageId, updatedAt: before.updatedAt, deletedAt: before.deletedAt })
      this.trashOf(canvasId).frames.push(frame)
      this.deletedIndex.set(frameId, canvasId)
    })
    this.touchCanvas(c, frame.updatedAt)
    this.saveTrashedFrameLater(frame, canvasId)
    this.saveCanvasLater(c)
    return frame
  }

  /** Bring a deleted page back (before Archive) with every deleted frame that
   *  was on it. Undefined when the page is not in the trash. */
  restorePage(
    canvasId: string,
    pageId: string,
  ): { pages: CanvasPageInfo[]; page: CanvasPageInfo; frames: Frame[] } | undefined {
    const c = this.canvases.get(canvasId)
    const entry = this.trash.get(canvasId)
    const deleted = entry?.pages.find((d) => d.page.id === pageId)
    if (!c || !entry || !deleted) return undefined
    /* before the page or any frame moves: one frame being deleted forever refuses the whole restore */
    const purgingHere = entry.frames.find((f) => f.pageId === pageId && this.purging.has(f.id))
    if (purgingHere) throw new PurgeInProgressError(purgingHere.id)
    const pages = canvasPages(c)
    if (pages.length >= MAX_PAGES) throw new PageLimitError()
    const page = pages.some((p) => p.name === deleted.page.name)
      ? { ...deleted.page, name: copyPageName(deleted.page.name, names(pages)) }
      : deleted.page
    entry.pages = entry.pages.filter((d) => d !== deleted)
    /* the flags are the page's own state, set by their routes: a restored page comes back open */
    const { ledger: _ledger, finished: _finished, ...restoredPage } = page
    c.pages = pageOrder([...pages, restoredPage])
    const keptPages = [...entry.pages]
    afterCommit(() => persist.saveDeletedPages(canvasId, keptPages), `trashpages:${canvasId}`)
    this.saveCanvasLater(c)
    const frames = entry.frames
      .filter((f) => f.pageId === pageId)
      .map((f) => this.restoreFrame(f.id))
      .filter((f): f is Frame => !!f)
    return { pages: c.pages, page: restoredPage, frames }
  }

  /** Move frames to the Archive page (made last on first use) and hide them, recording where each came from
   *  in the same write. A frame already on the Archive page is left as it is and keeps its first origin, so a
   *  retried request changes nothing (FP-01). `changed` is the frames this call moved. */
  archiveFrames(
    ctx: WriteContext,
    canvasId: string,
    frameIds: string[],
    by: string,
  ): { pages: CanvasPageInfo[]; frames: Frame[]; changed: Frame[] } | undefined {
    const c = this.canvases.get(canvasId)
    if (!c) return undefined
    const frames = frameIds.map((id) => this.getFrame(id)).filter((f): f is Frame => !!f && f.canvasId === canvasId)
    if (!frames.length) return undefined
    const changed = frames.filter((f) => framePageId(c, f) !== ARCHIVE_PAGE_ID)
    /* before the Archive page is made or any frame moves, so a refusal leaves nothing half done; a locked
       frame is left to updateFrame, whose lock refusal answers first */
    assertPagesOpen(
      c,
      changed.filter((f) => !f.locked).map((f) => framePageId(c, f)),
      'archive_frames',
    )
    const pages = canvasPages(c)
    if (changed.length && !pages.some((p) => p.id === ARCHIVE_PAGE_ID)) {
      if (pages.length >= MAX_PAGES) throw new PageLimitError()
      c.pages = pageOrder([...pages, { id: ARCHIVE_PAGE_ID, name: ARCHIVE_PAGE_NAME }])
      this.saveCanvasLater(c)
    }
    const archivedAt = Date.now()
    for (const frame of changed) {
      const archiveOrigin = { pageId: framePageId(c, frame), hidden: frame.hidden === true, archivedAt, by }
      this.updateFrame(ctx, frame.id, { pageId: ARCHIVE_PAGE_ID, hidden: true, archiveOrigin }, by)
    }
    return { pages: canvasPages(c), frames, changed }
  }

  /** Take a frame out of the Archive: to `pageId`, else to the page it came from, with the `hidden` it had.
   *  A frame that is not on the Archive page is left as it is (`changed: false`), so a retry is harmless.
   *  Refused with `origin_missing` (no `pageId`, and no origin page left) before anything moves.
   *  Undefined = no such frame. */
  unarchiveFrame(
    ctx: WriteContext,
    frameId: string,
    pageId: string | undefined,
    by: string,
  ): UnarchiveResult | undefined {
    const frame = this.getFrame(frameId)
    const c = frame && this.canvases.get(frame.canvasId)
    if (!frame || !c) return undefined
    if (framePageId(c, frame) !== ARCHIVE_PAGE_ID) return { ok: true, frame, changed: false }
    const pages = canvasPages(c)
    const origin = frame.archiveOrigin
    const target = pageId ?? origin?.pageId ?? undefined
    if (pageId === ARCHIVE_PAGE_ID) return { ok: false, code: 'archive_page' }
    if (!target || !pages.some((p) => p.id === target))
      return { ok: false, code: pageId === undefined ? 'origin_missing' : 'page_not_found' }
    const moved = this.updateFrame(
      ctx,
      frame.id,
      { pageId: target, hidden: origin?.hidden === true, archiveOrigin: undefined },
      by,
    )
    return moved ? { ok: true, frame: moved, changed: true } : undefined
  }
}

export type UnarchiveResult =
  | { ok: true; frame: Frame; changed: boolean }
  | { ok: false; code: 'origin_missing' | 'page_not_found' | 'archive_page' }

export type LedgerResult =
  | { ok: true; pages: CanvasPageInfo[]; changed: boolean }
  | { ok: false; code: 'not_found' | 'archive_page' | 'page_finished' }

export type PageFinishedResult =
  | { ok: true; pages: CanvasPageInfo[]; changed: boolean }
  | { ok: false; code: 'page_changed'; pages: CanvasPageInfo[] }
  | { ok: false; code: 'not_found' | 'ledger_page' | 'archive_page' | 'page_busy' }

export const store = new Store()
