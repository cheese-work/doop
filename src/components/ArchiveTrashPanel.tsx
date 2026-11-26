import { useCallback, useEffect, useRef, useState } from 'react'
import { ARCHIVE_PAGE_ID, canvasPages } from '../../shared/pages'
import type { Canvas, Frame } from '../../shared/types'
import { ApiError, api } from '@/lib/api'
import { getLocale, useT } from '@/lib/i18n'
import { canEditOpenCanvas, useStore } from '@/lib/store'
import { PanelState } from './PanelState'
import { sectionHeading } from './PagesPanel'
import { Button } from './ui/button'
import { Note } from './ui/note'
import { Toast, ToastAction } from './ui/toast'

type Result = { tone: 'muted' | 'error' | 'success'; text: string }
type TrashFrame = Frame & { purging?: true }

/* How long the archive toast keeps its Undo. */
const TOAST_MS = 10_000

/* A reply that tells us nothing about what the server did: no response at all (network error, timeout)
   or a 5xx. Anything else is the server's own answer. */
const isAmbiguous = (err: unknown) => !(err instanceof ApiError) || err.status >= 500

/* The canvas as the server has it, put into the store. Only what the panel acts on moves: the page
   list, the frames that changed page or archive state, and an archived frame the server no longer has. */
function applyServerCanvas(server: Canvas) {
  const s = useStore.getState()
  if (s.canvas?.id !== server.id) return
  s.setPages(canvasPages(server), server.id)
  const kept = new Set(server.frames.map((f) => f.id))
  for (const f of s.canvas.frames) if (f.pageId === ARCHIVE_PAGE_ID && !kept.has(f.id)) s.removeFrame(f.id)
  for (const f of server.frames) {
    const mine = useStore.getState().canvas?.frames.find((x) => x.id === f.id)
    if (!mine || mine.pageId !== f.pageId || !mine.archiveOrigin !== !f.archiveOrigin) s.upsertFrame(f)
  }
}

const pageName = (pageId: string | null | undefined) => {
  const canvas = useStore.getState().canvas
  return canvas ? canvasPages(canvas).find((p) => p.id === pageId)?.name : undefined
}

/** The Archive and Trash sections of the Layers tab (CHE-9394, screen A2). After every reconnect and
 *  every ambiguous reply it re-reads the trash and the page list before it shows a result. */
export function ArchiveTrashPanel() {
  const t = useT()
  const canvas = useStore((s) => s.canvas)
  const connected = useStore((s) => s.connected)
  const selectedIds = useStore((s) => s.selectedIds)
  const readOnly = useStore((s) => !canEditOpenCanvas(s))
  const [trash, setTrash] = useState<TrashFrame[] | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [result, setResult] = useState<Result | null>(null)
  const [picker, setPicker] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState<string[] | null>(null)
  const canvasId = canvas?.id
  const active = !!canvasId && !readOnly

  /** Read the trash (and, `full`, the canvas too) again. False when the server could not be read. */
  const resync = useCallback(
    async (full: boolean): Promise<boolean> => {
      if (!canvasId || !active) return false
      const same = () => useStore.getState().canvas?.id === canvasId
      try {
        const [fresh, server] = await Promise.all([api.canvasTrash(canvasId), full ? api.getCanvas(canvasId) : null])
        if (!same()) return false
        if (server) applyServerCanvas(server)
        setTrash(fresh.frames)
        setLoadFailed(false)
        return true
      } catch {
        if (same()) setLoadFailed(true)
        return false
      }
    },
    [canvasId, active],
  )

  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- a server fetch: it sets state only after the reply lands
    void resync(false)
  }, [resync])

  const wasConnected = useRef(connected)
  useEffect(() => {
    if (connected && !wasConnected.current) void resync(true)
    wasConnected.current = connected
  }, [connected, resync])

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(null), TOAST_MS)
    return () => window.clearTimeout(timer)
  }, [toast])

  if (!canvas || readOnly) return null
  const archived = canvas.frames.filter((f) => f.pageId === ARCHIVE_PAGE_ID)
  const livePages = canvasPages(canvas).filter((p) => p.id !== ARCHIVE_PAGE_ID)
  const archivable = selectedIds.filter((id) => canvas.frames.some((f) => f.id === id && f.pageId !== ARCHIVE_PAGE_ID))
  const locked = !connected || busy

  const inStore = (id: string) => useStore.getState().canvas?.frames.find((f) => f.id === id)
  const failure = (text: string): Result => ({ tone: 'error', text })

  async function archiveSelected() {
    if (!archivable.length || !canvasId) return
    setBusy(true)
    setResult(null)
    try {
      const out = await api.archiveFrames(canvasId, archivable)
      useStore.getState().setPages(out.pages, canvasId)
      for (const f of out.frames) useStore.getState().upsertFrame(f)
      setToast(out.frames.map((f) => f.id))
    } catch (err) {
      if (!isAmbiguous(err)) return setResult(failure(t('panels.archiveFailed')))
      if (!(await resync(true))) return
      const done = archivable.filter((id) => inStore(id)?.pageId === ARCHIVE_PAGE_ID)
      if (done.length) setToast(done)
      else setResult(failure(t('panels.archiveFailed')))
    } finally {
      setBusy(false)
    }
  }

  /** Take an archived frame out of the Archive: to `pageId`, else to where it came from. */
  async function restoreArchived(frame: Frame, pageId?: string) {
    setBusy(true)
    setPicker(null)
    setResult(null)
    const restored = (at: Frame | undefined) =>
      setResult({
        tone: 'success',
        text: t('panels.archiveRestored', { frame: frame.name, page: pageName(at?.pageId) ?? '' }),
      })
    try {
      const out = await api.unarchiveFrame(frame.id, pageId)
      useStore.getState().upsertFrame(out.frame)
      restored(out.frame)
    } catch (err) {
      if (err instanceof ApiError && err.body.code === 'origin_missing') {
        setPicker(frame.id)
        setResult({ tone: 'muted', text: t('panels.archiveOriginMissing', { frame: frame.name }) })
      } else if (isAmbiguous(err)) {
        if (!(await resync(true))) return
        const now = inStore(frame.id)
        if (now && now.pageId !== ARCHIVE_PAGE_ID) restored(now)
        else setResult(failure(t('panels.archiveRestoreFailed', { frame: frame.name })))
      } else setResult(failure(t('panels.archiveRestoreFailed', { frame: frame.name })))
    } finally {
      setBusy(false)
    }
  }

  async function undoArchive(ids: string[]) {
    setToast(null)
    for (const id of ids) {
      const frame = inStore(id)
      if (frame) await restoreArchived(frame)
    }
  }

  async function moveToTrash(frame: Frame) {
    setBusy(true)
    setResult(null)
    const trashed = async () => {
      useStore.getState().removeFrame(frame.id)
      await resync(false)
    }
    try {
      await api.deleteFrame(frame.id)
      await trashed()
    } catch (err) {
      if (!isAmbiguous(err)) return setResult(failure(t('panels.archiveTrashFailed', { frame: frame.name })))
      if (!(await resync(true))) return
      if (!inStore(frame.id)) await trashed()
      else setResult(failure(t('panels.archiveTrashFailed', { frame: frame.name })))
    } finally {
      setBusy(false)
    }
  }

  async function restoreTrashed(frame: Frame) {
    setBusy(true)
    setResult(null)
    const restored = (text: string) => setResult({ tone: 'success', text })
    const failed = () => setResult(failure(t('panels.trashRestoreFailed', { frame: frame.name })))
    try {
      const back = await api.restoreFrame(frame.id)
      useStore.getState().upsertFrame(back)
      setTrash((list) => list?.filter((f) => f.id !== frame.id) ?? list)
      restored(t('panels.trashRestored', { frame: frame.name }))
    } catch (err) {
      if (!isAmbiguous(err)) return failed()
      if (!(await resync(true))) return
      if (inStore(frame.id)) restored(t('panels.trashRestored', { frame: frame.name }))
      else failed()
    } finally {
      setBusy(false)
    }
  }

  const rows = trash ?? []
  /* a result stays on screen even when the last row it names has just left */
  const nothing = !archived.length && !rows.length && !result
  const status = loadFailed ? 'error' : trash === null ? 'loading' : nothing ? 'empty' : 'ready'
  const selectAction = archivable.length
    ? { label: t('panels.archiveSelected'), onClick: () => void archiveSelected() }
    : undefined

  return (
    <div data-slot="archive-trash-panel" className="flex flex-col px-3.5 pb-3">
      <PanelState
        status={status}
        loadingLabel={t('panels.archiveTrashLoading')}
        empty={{ title: t('panels.archiveTrashEmpty'), hint: t('panels.archiveTrashEmptyHint'), action: selectAction }}
        error={t('panels.archiveTrashError')}
        onRetry={() => void resync(true)}
        offline={t('panels.archiveTrashOffline')}
      >
        {result && (
          <Note role="status" size="sm" tone={result.tone}>
            {result.text}
          </Note>
        )}
        <section aria-label={t('panels.archiveTitle')} className="flex flex-col gap-1">
          <div className="flex h-6 items-center justify-between">
            <span className={sectionHeading}>
              {t('panels.archiveTitle')} · {archived.length}
            </span>
            {selectAction && (
              <Button size="sm" variant="bare" disabled={locked} onClick={selectAction.onClick}>
                {selectAction.label}
              </Button>
            )}
          </div>
          {archived.map((frame) => {
            const originId = frame.archiveOrigin?.pageId
            const origin = livePages.find((p) => p.id === originId)
            return (
              <div
                key={frame.id}
                data-archive-row={frame.id}
                className="flex flex-col gap-1 rounded-row px-2 py-1.5 hover:bg-sub"
              >
                <span className="truncate text-body text-ink">{frame.name}</span>
                {frame.archiveOrigin && <Note>{t('panels.archiveArchivedBy', { name: frame.archiveOrigin.by })}</Note>}
                <div className="flex flex-wrap gap-1">
                  <Button
                    size="sm"
                    disabled={locked}
                    onClick={() => (origin ? void restoreArchived(frame) : setPicker(frame.id))}
                  >
                    {origin ? t('panels.archiveRestoreTo', { page: origin.name }) : t('panels.archiveRestoreToPage')}
                  </Button>
                  {origin && (
                    <Button size="sm" variant="bare" disabled={locked} onClick={() => setPicker(frame.id)}>
                      {t('panels.archiveRestoreToPage')}
                    </Button>
                  )}
                  <Button size="sm" variant="bare" disabled={locked} onClick={() => void moveToTrash(frame)}>
                    {t('panels.archiveMoveToTrash')}
                  </Button>
                </div>
                {picker === frame.id && (
                  <div role="listbox" aria-label={t('panels.archivePickPage')} className="flex flex-col gap-0.5">
                    {livePages.map((page) => (
                      <Button
                        key={page.id}
                        role="option"
                        aria-selected={false}
                        size="sm"
                        variant="bare"
                        className="justify-start"
                        disabled={locked}
                        onClick={() => void restoreArchived(frame, page.id)}
                      >
                        {page.name}
                      </Button>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </section>
        <section aria-label={t('panels.trashTitle')} className="flex flex-col gap-1">
          <div className="flex h-6 items-center">
            <span className={sectionHeading}>
              {t('panels.trashTitle')} · {rows.length}
            </span>
          </div>
          {rows.map((frame) => (
            <div key={frame.id} data-trash-row={frame.id} className="flex items-center gap-2 rounded-row px-2 py-1.5">
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-body text-ink">{frame.name}</span>
                <Note>
                  {t('panels.trashDeletedBy', {
                    name: frame.updatedBy,
                    when: frame.deletedAt
                      ? new Date(frame.deletedAt).toLocaleString(getLocale(), {
                          dateStyle: 'medium',
                          timeStyle: 'short',
                        })
                      : '',
                  })}
                </Note>
              </div>
              <Button size="sm" disabled={locked || !!frame.purging} onClick={() => void restoreTrashed(frame)}>
                {t('panels.trashRestore')}
              </Button>
            </div>
          ))}
        </section>
      </PanelState>
      {toast && (
        <Toast>
          {t('panels.archiveToast', { count: toast.length })}
          <ToastAction onClick={() => void undoArchive(toast)}>{t('panels.archiveUndo')}</ToastAction>
        </Toast>
      )}
    </div>
  )
}
