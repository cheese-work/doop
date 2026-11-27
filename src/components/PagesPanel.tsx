import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { nanoid } from 'nanoid'
import { ARCHIVE_PAGE_ID, canvasPages, pageOrder } from '../../shared/pages'
import type { CanvasPageInfo } from '../../shared/types'
import { canEditOpenCanvas, useStore } from '../lib/store'
import {
  changePageState,
  duplicatePage,
  moveFramesToPage,
  reloadPages,
  savePages,
  type PageStateOutcome,
} from '../lib/pageEdits'
import { copyPageLink } from '../lib/pageUrl'
import { api, ApiError } from '../lib/api'
import { Button } from './ui/button'
import { ArchiveIcon, BookOpenIcon, ChevronDownIcon, ChevronRightIcon, PageIcon, PlusIcon } from './ui/icons'
import { cn } from '../lib/utils'
import { ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem } from './ui/context-menu'
import { PanelState } from './PanelState'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select'
import { useT } from '@/lib/i18n'

/** The small grey sub-heading over a section of the Layers panel, shared with
 *  its "Layers" row: the two must read as one family (a browser test checks
 *  their typography). */
export const sectionHeading = 'text-[11px] font-normal text-ink-faint'
const sectionBtn = 'size-5 rounded-[5px] text-ink-faint hover:bg-paper-deep hover:text-ink'

/** A page the work goes on in: not the ledger, not Finished, not the Archive. */
const isOpenPage = (page: CanvasPageInfo) => !page.ledger && !page.finished && page.id !== ARCHIVE_PAGE_ID

type StateChange = 'ledger' | 'finish' | 'restore'
/** A ledger or Finished change that did not settle, kept for the panel's error row. */
type StateFailure = { outcome: PageStateOutcome; action: string; retry: () => void }

export function PagesPanel({ fill = false }: { fill?: boolean }) {
  const canvas = useStore((s) => s.canvas)
  const activePageId = useStore((s) => s.activePageId)
  const selectedIds = useStore((s) => s.selectedIds)
  /* view and comment links switch pages; they add, rename and move none */
  const readOnly = useStore((s) => !canEditOpenCanvas(s))
  /* disconnected: reading keeps working, every page write pauses */
  const connected = useStore((s) => s.connected)
  const [busy, setBusy] = useState(false)
  const [finishedOpen, setFinishedOpen] = useState(false)
  const [failure, setFailure] = useState<StateFailure | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [name, setName] = useState('')
  /* set once Enter, Esc or a blur has settled the rename, so the blur that
     follows (the field unmounting, or being disabled while it saves) does
     not settle it a second time */
  const renameSettled = useRef(false)
  const saveQueue = useRef<Promise<unknown>>(Promise.resolve())
  const [drag, setDrag] = useState<{ id: string; targetId: string | null; after: boolean } | null>(null)
  const didDrag = useRef(false)
  const stopDrag = useRef<(() => void) | null>(null)
  useEffect(() => () => stopDrag.current?.(), [])
  const t = useT()
  if (!canvas) {
    return (
      <div className={cn('flex flex-none flex-col', fill && 'min-h-0 flex-1')}>
        <div className={cn('mt-1.5 flex h-6 flex-none items-center pl-3.5', sectionHeading)}>
          <span data-slot="page-section-heading" className={sectionHeading}>
            {t('panels.pagesTitle')}
          </span>
        </div>
        <div className="px-3.5 pb-2">
          <PanelState status="loading" loadingLabel={t('panels.pagesLoading')} />
        </div>
      </div>
    )
  }
  const pages = pageOrder(canvasPages(canvas))
  const finishedPages = pages.filter((page) => page.finished)
  const archivePage = pages.find((page) => page.id === ARCHIVE_PAGE_ID)
  const listedPages = pages.filter((page) => !page.finished && page.id !== ARCHIVE_PAGE_ID)
  const canWrite = !readOnly && connected
  /* the Archive row shows how many frames it holds */
  const archivedCount = canvas.frames.filter((f) => f.pageId === ARCHIVE_PAGE_ID).length
  /* the page "Mark … as ledger" offers: Baseline, else the first open page */
  const ledgerCandidate = pages.find((page) => isOpenPage(page) && page.name === 'Baseline') ?? pages.find(isOpenPage)
  const movableIds = canvas.frames.filter((f) => selectedIds.includes(f.id) && !f.locked).map((f) => f.id)

  async function moveSelection(pageId: string) {
    if (!canvas || busy || !movableIds.length) return
    setBusy(true)
    try {
      await moveFramesToPage(canvas, movableIds, pageId)
    } catch {
      if (useStore.getState().canvas?.id === canvas.id) useStore.getState().pushNotice(t('panels.pagesMoveFailed'))
    } finally {
      setBusy(false)
    }
  }

  /** Page-list edits run one after another, each built from the pages as the
   *  previous one left them: a rename committed by the press that starts a
   *  drag must not race the reorder that drag drops. Resolves to whether the
   *  edit saved. */
  function save(edit: (pages: CanvasPageInfo[]) => CanvasPageInfo[] | null, selectId?: string) {
    const canvasId = canvas?.id
    const task = saveQueue.current.then(async () => {
      const current = useStore.getState().canvas
      if (!current || current.id !== canvasId) return false
      const next = edit(canvasPages(current))
      if (!next) return false
      setBusy(true)
      try {
        await savePages(current, next, selectId)
        return true
      } catch (error) {
        if (useStore.getState().canvas?.id === canvasId) {
          useStore
            .getState()
            .pushNotice(
              error instanceof ApiError && typeof error.body.error === 'string'
                ? error.body.error
                : t('panels.pagesSaveFailed'),
            )
        }
        return false
      } finally {
        setBusy(false)
      }
    })
    saveQueue.current = task.then(() => undefined)
    return task
  }

  /** Mark or unmark the ledger, move a page to Finished, or restore it. Runs after the page-list saves
   *  in flight; a result is shown only once it is known (a lost reply re-reads the canvas first). */
  function changeState(kind: StateChange, page: CanvasPageInfo) {
    const canvasId = canvas?.id
    const flag = kind === 'ledger' ? !page.ledger : kind === 'finish'
    const action = t(
      kind === 'ledger'
        ? 'panels.pagesActionLedger'
        : kind === 'finish'
          ? 'panels.pagesActionFinish'
          : 'panels.pagesActionRestore',
    )
    const run = () => {
      const task = saveQueue.current.then(async () => {
        const current = useStore.getState().canvas
        if (!current || current.id !== canvasId || !useStore.getState().connected) return
        setBusy(true)
        setFailure(null)
        try {
          const outcome = await changePageState(
            current,
            () =>
              kind === 'ledger'
                ? api.setPageLedger(current.id, page.id, flag)
                : api.setPageFinished(current.id, page.id, flag, page.name),
            (fresh) => {
              const landed = fresh.find((p) => p.id === page.id)
              return kind === 'ledger' ? !!landed?.ledger === flag : !!landed?.finished === flag
            },
          )
          if (useStore.getState().canvas?.id !== canvasId) return
          if (outcome.kind === 'failed') {
            useStore.getState().pushNotice(outcome.message ?? t('panels.pagesStateFailed', { action }))
          } else if (outcome.kind !== 'done') setFailure({ outcome, action, retry: run })
        } finally {
          setBusy(false)
        }
      })
      saveQueue.current = task.then(() => undefined)
      return task
    }
    return run()
  }

  /** The error row's "Reload pages": re-read the canvas, then clear the row. */
  async function reload() {
    const canvasId = canvas?.id
    if (!canvasId) return
    try {
      await reloadPages(canvasId)
      setFailure(null)
    } catch {
      if (useStore.getState().canvas?.id === canvasId) useStore.getState().pushNotice(t('panels.pagesSaveFailed'))
    }
  }

  function startRename(page: CanvasPageInfo) {
    renameSettled.current = false
    setRenaming(page.id)
    setName(page.name)
  }

  /** Enter or a click elsewhere keeps the typed name, as in Figma; an empty or
   *  unchanged one just closes the field. A failed save leaves it open. */
  async function commitRename(page: CanvasPageInfo) {
    if (renameSettled.current) return
    renameSettled.current = true
    const next = name.trim()
    if (!next || next === page.name) return setRenaming(null)
    const saved = await save((current) => current.map((p) => (p.id === page.id ? { ...p, name: next } : p)))
    if (saved) setRenaming(null)
    else renameSettled.current = false
  }

  function startDrag(e: ReactPointerEvent<HTMLButtonElement>, id: string) {
    if (busy || !connected || e.button !== 0 || e.detail > 1) return
    stopDrag.current?.()
    const startY = e.clientY
    const startX = e.clientX
    const pointerId = e.pointerId
    const controller = new AbortController()
    let moving = false
    let drop: { targetId: string; after: boolean } | null = null
    const cleanup = () => {
      controller.abort()
      stopDrag.current = null
      setDrag(null)
    }
    stopDrag.current = cleanup
    const move = (event: PointerEvent) => {
      if (event.pointerId !== pointerId) return
      if (!moving && Math.abs(event.clientY - startY) + Math.abs(event.clientX - startX) < 4) return
      moving = true
      didDrag.current = true
      event.preventDefault()
      const row = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-page-id]')
      const targetId = row?.dataset.pageId
      drop = null
      if (targetId && row && targetId !== id) {
        const box = row.getBoundingClientRect()
        const after = event.clientY >= box.y + box.height / 2
        const latest = useStore.getState().canvas
        const target = latest && canvasPages(latest).find((page) => page.id === targetId)
        /* the ledger stays first and Finished and Archive stay below: a page
           drops among the open pages, or just under the ledger, nowhere else */
        if (target && (isOpenPage(target) || (target.ledger && after))) drop = { targetId, after }
      }
      setDrag({ id, targetId: drop?.targetId ?? null, after: drop?.after ?? false })
    }
    window.addEventListener('pointermove', move, { signal: controller.signal, passive: false })
    window.addEventListener(
      'pointerup',
      (event) => {
        if (event.pointerId !== pointerId) return
        cleanup()
        if (!moving || !drop) return
        const { targetId, after } = drop
        void save((current) => {
          const page = current.find((p) => p.id === id)
          const next = current.filter((p) => p.id !== id)
          const target = next.findIndex((p) => p.id === targetId)
          if (!page || target < 0) return null
          next.splice(target + (after ? 1 : 0), 0, page)
          return next
        })
      },
      { signal: controller.signal },
    )
    window.addEventListener('pointercancel', cleanup, { signal: controller.signal })
  }

  function duplicate(pageId: string) {
    const canvasId = canvas?.id
    const task = saveQueue.current.then(async () => {
      const current = useStore.getState().canvas
      if (!current || current.id !== canvasId) return
      setBusy(true)
      try {
        await duplicatePage(current, pageId)
      } catch (error) {
        if (useStore.getState().canvas?.id !== canvasId) return
        useStore
          .getState()
          .pushNotice(
            error instanceof ApiError && typeof error.body.error === 'string'
              ? error.body.error
              : t('panels.pagesDuplicateFailed'),
          )
      } finally {
        setBusy(false)
      }
    })
    saveQueue.current = task
    return task
  }

  const addPage = (
    <Button
      variant="bare"
      size="icon-sm"
      className={sectionBtn}
      aria-label={t('panels.pagesAdd')}
      disabled={busy}
      onClick={() => {
        const id = nanoid(10)
        void save((current) => [...current, { id, name: `Page ${current.length + 1}` }], id)
      }}
    >
      <PlusIcon className="size-3.5" />
    </Button>
  )

  const ledgerTag = (
    <span className="flex flex-none items-center gap-1 rounded-tag bg-paper-deep px-1.5 py-px text-micro text-ink-soft">
      <BookOpenIcon className="size-3" />
      {t('panels.pagesLedgerTag')}
    </span>
  )

  const row = (page: CanvasPageInfo) => {
    const finished = !!page.finished
    const draggable = isOpenPage(page)
    const notOpenable = page.id === ARCHIVE_PAGE_ID
    return (
      <ContextMenu key={page.id}>
        <ContextMenuTrigger asChild>
          <div
            data-page-id={page.id}
            onContextMenu={() => useStore.getState().setActivePage(page.id)}
            className={cn(
              'group relative flex h-[27px] items-center gap-1 rounded-[7px] pr-2.5 text-[12px] text-ink-soft hover:bg-sub',
              page.id === activePageId && 'bg-paper-deep text-ink hover:bg-paper-deep',
              drag?.id === page.id && 'opacity-40',
              finished && 'pl-3.5',
            )}
          >
            {drag?.targetId === page.id && (
              <div
                className={`pointer-events-none absolute inset-x-0 h-0.5 bg-brand ${drag.after ? 'bottom-0' : 'top-0'}`}
              />
            )}
            <span
              className={cn(
                'grid size-4 flex-none place-items-center pl-2.5 pr-0 box-content text-ink-faint',
                page.id === activePageId && 'text-ink',
              )}
            >
              {page.id === ARCHIVE_PAGE_ID ? <ArchiveIcon className="size-3.5" /> : <PageIcon className="size-3.5" />}
            </span>
            {renaming === page.id ? (
              <form
                className="min-w-0 flex-1"
                onSubmit={(e) => {
                  e.preventDefault()
                  void commitRename(page)
                }}
              >
                <input
                  autoFocus
                  aria-label={t('panels.pagesName')}
                  maxLength={100}
                  disabled={busy}
                  onFocus={(e) => e.target.select()}
                  className="w-full rounded-[6px] bg-surface px-2 py-1 text-[12px] text-ink shadow-elevation-1-focus outline-none"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onBlur={() => void commitRename(page)}
                  onKeyDown={(e) => {
                    if (e.key !== 'Escape') return
                    renameSettled.current = true
                    setRenaming(null)
                  }}
                />
              </form>
            ) : (
              <button
                className={`min-w-0 flex-1 touch-none select-none truncate py-1.5 pl-0.5 text-left text-[12px] ${drag ? 'cursor-grabbing' : draggable && canWrite ? 'cursor-grab' : ''} ${page.id === activePageId ? 'font-medium' : ''}`}
                aria-current={page.id === activePageId ? 'page' : undefined}
                onPointerDown={(e) => {
                  didDrag.current = false
                  if (canWrite && draggable) startDrag(e, page.id)
                }}
                onClick={(e) => {
                  if (didDrag.current) {
                    e.preventDefault()
                    return
                  }
                  useStore.getState().setActivePage(page.id)
                }}
                onDoubleClick={() => {
                  /* a Finished page is frozen: it cannot be renamed until it is restored */
                  if (busy || !canWrite || didDrag.current || finished) return
                  startRename(page)
                }}
              >
                {page.name}
              </button>
            )}
            {page.id === ARCHIVE_PAGE_ID && (
              <span
                data-testid="archive-count"
                aria-label={t('panels.archiveTrashCount', { count: archivedCount })}
                className="flex-none font-mono text-micro text-ink-faint"
              >
                {archivedCount}
              </span>
            )}
            {page.ledger && renaming !== page.id && ledgerTag}
            {finished && canWrite && (
              <Button
                variant="bare"
                size="inline"
                className="flex-none px-1.5 py-0.5"
                disabled={busy}
                onClick={() => void changeState('restore', page)}
              >
                {t('panels.pagesRestore')}
              </Button>
            )}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent
          onCloseAutoFocus={(e) => {
            if (renaming === page.id) e.preventDefault()
          }}
        >
          {!readOnly && !finished && (
            <>
              <ContextMenuItem disabled={busy || !connected} onSelect={() => startRename(page)}>
                {t('panels.pagesRename')}
              </ContextMenuItem>
              <ContextMenuItem
                disabled={busy || !connected || pages.length >= 100}
                onSelect={() => void duplicate(page.id)}
              >
                {t('panels.pagesDuplicate')}
              </ContextMenuItem>
            </>
          )}
          {/* the one entry a viewer has too: a link changes nothing */}
          <ContextMenuItem onSelect={() => void copyPageLink(canvas.id, page.id)}>
            {t('panels.pagesCopyLink')}
          </ContextMenuItem>
          {!readOnly && finished && (
            <ContextMenuItem disabled={busy || !connected} onSelect={() => void changeState('restore', page)}>
              {t('panels.pagesRestore')}
            </ContextMenuItem>
          )}
          {!readOnly && !finished && !notOpenable && (
            <>
              <ContextMenuItem disabled={busy || !connected} onSelect={() => void changeState('ledger', page)}>
                {page.ledger ? t('panels.pagesLedgerOn') : t('panels.pagesLedgerOff')}
              </ContextMenuItem>
              <ContextMenuItem
                disabled={busy || !connected || !!page.ledger}
                onSelect={() => void changeState('finish', page)}
              >
                {t('panels.pagesMoveFinished')}
                {page.ledger && (
                  <span className="ml-auto text-caption text-ink-faint">{t('panels.pagesNotForLedger')}</span>
                )}
              </ContextMenuItem>
            </>
          )}
          {!readOnly && !finished && (
            <ContextMenuItem
              tone="danger"
              disabled={busy || !connected || pages.length === 1 || !!page.ledger}
              onSelect={() =>
                void save((current) => (current.length > 1 ? current.filter((p) => p.id !== page.id) : null))
              }
            >
              {t('panels.pagesDelete')}
              {page.ledger && (
                <span className="ml-auto text-caption text-ink-faint">{t('panels.pagesLedgerKept')}</span>
              )}
            </ContextMenuItem>
          )}
        </ContextMenuContent>
      </ContextMenu>
    )
  }

  const finishedGroup = finishedPages.length > 0 && (
    <>
      <button
        className="flex h-[27px] w-full items-center gap-1 rounded-[7px] pr-2.5 pl-2.5 text-left text-[12px] text-ink-soft hover:bg-sub"
        aria-expanded={finishedOpen}
        onClick={() => setFinishedOpen((open) => !open)}
      >
        {finishedOpen ? <ChevronDownIcon className="size-3.5" /> : <ChevronRightIcon className="size-3.5" />}
        <span className="min-w-0 flex-1 truncate">{t('panels.pagesFinishedGroup')}</span>
        <span className="font-mono text-micro text-ink-faint">{finishedPages.length}</span>
      </button>
      {finishedOpen && (
        <>
          {finishedPages.map(row)}
          <span className="block px-3.5 py-1 text-caption text-ink-faint">{t('panels.pagesFinishedHint')}</span>
        </>
      )}
    </>
  )

  const list = (
    <>
      {listedPages.map(row)}
      {finishedGroup}
      {archivePage && row(archivePage)}
    </>
  )

  /* the one state above the list, most urgent first: a change that did not settle, then no ledger yet */
  const stateStatus = failure
    ? 'error'
    : !readOnly && ledgerCandidate && !pages.some((p) => p.ledger)
      ? 'empty'
      : 'ready'
  const failureText = failure
    ? failure.outcome.kind === 'changed'
      ? t('panels.pagesChanged', { action: failure.action })
      : failure.outcome.kind === 'busy'
        ? t('panels.pagesBusy')
        : failure.outcome.kind === 'lost'
          ? t('panels.pagesLost', { action: failure.action })
          : t('panels.pagesLostUnknown', { action: failure.action })
    : undefined
  const reloads = failure?.outcome.kind === 'changed' || failure?.outcome.kind === 'unknown'

  return (
    <div className={cn('flex flex-none flex-col', fill && 'min-h-0 flex-1')}>
      <div className={cn('mt-1.5 flex h-6 flex-none items-center justify-between pr-2.5 pl-3.5', sectionHeading)}>
        <span data-slot="page-section-heading" className={sectionHeading}>
          {t('panels.pagesTitle')}
        </span>
        {!readOnly && addPage}
      </div>
      {(stateStatus !== 'ready' || !connected) && (
        <div className="px-3.5 pb-2">
          <PanelState
            status={stateStatus}
            offline={t('panels.pagesOffline')}
            error={failureText}
            onRetry={failure ? (reloads ? () => void reload() : () => void failure.retry()) : undefined}
            retryLabel={reloads ? t('panels.pagesReload') : undefined}
            empty={
              ledgerCandidate
                ? {
                    title: t('panels.pagesNoLedger'),
                    hint: t('panels.pagesNoLedgerHint'),
                    action: {
                      label: t('panels.pagesMarkLedger', { name: ledgerCandidate.name }),
                      onClick: () => void changeState('ledger', ledgerCandidate),
                    },
                  }
                : undefined
            }
          />
        </div>
      )}
      <div className={cn('overflow-y-auto px-2 pb-1', fill ? 'min-h-0 flex-1' : 'max-h-[30vh]')}>{list}</div>
      {canWrite && selectedIds.length > 0 && pages.length > 1 && (
        /* the canvas shortcuts listen on window: ⌫ would delete the frames
           being moved and typed letters would switch tools, so the picker's
           keys stop here; React bubbles the portalled list's keys through this
           div too, before the native event reaches window */
        <div className="px-2 pb-2" onKeyDown={(e) => e.stopPropagation()}>
          <Select value="" disabled={busy || !movableIds.length} onValueChange={(id) => void moveSelection(id)}>
            <SelectTrigger size="sm" className="w-full" aria-label={t('panels.pagesMoveSelection')}>
              <SelectValue placeholder={t('panels.pagesMoveSelectionPlaceholder')} />
            </SelectTrigger>
            <SelectContent>
              {pages
                .filter((page) => page.id !== activePageId && !page.finished)
                .map((page) => (
                  <SelectItem key={page.id} value={page.id}>
                    {page.name}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        </div>
      )}
    </div>
  )
}
