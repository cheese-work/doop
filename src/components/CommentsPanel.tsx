import { useMemo, useState } from 'react'
import { colorFor, type CommentResolution } from '../../shared/types'
import { canCommentOpenCanvas, useStore } from '../lib/store'
import { api, ApiError } from '../lib/api'
import { authClient } from '../lib/auth'
import { posthog } from '../lib/posthog'
import { timeAgo } from '../lib/time'
import { isComposingEnter } from '../lib/keys'
import { isCanvasComment } from '../../shared/comments'
import { canvasPages } from '../../shared/pages'
import { pageThreads, threadState, type CommentThreadGroup, type ThreadState } from '../lib/comments'
import { cn } from '@/lib/utils'
import {
  RESOLVE_MAX,
  RESOLVE_REASONS,
  multicaIssueUrl,
  readReviewAnchor,
  resolveBody,
  reviewSummary,
  waitsOn,
  writeReviewAnchor,
  type ResolveBody,
} from '../lib/commentResolution'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { Callout } from './ui/callout'
import { Input } from './ui/input'
import { PanelBody } from './ui/panel'
import { CheckIcon, ChevronDownIcon } from './ui/icons'
import { Disclosure } from './ui/collapsible'
import { Field } from './ui/field'
import { Modal, ModalActions, ModalSpacer, ModalTitle } from './ui/modal'
import {
  DropdownMenu,
  DropdownMenuCaption,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from './ui/dropdown-menu'
import { PanelState } from './PanelState'
import { isResidentLimit } from './TeamAllowance'
import { useT } from '../lib/i18n'

const emptyNote = 'px-4 py-6 text-center text-[12px] leading-[1.45] text-ink-faint'

/** Every comment thread on the current page — pinned to a frame or to the
 *  canvas itself — open ones first. Clicking a thread flies to its pin and
 *  opens it; replying and resolving work from here too, so a review pass
 *  never has to hunt pins across the canvas. */
export function CommentsPanel() {
  const comments = useStore((s) => s.comments)
  const canvas = useStore((s) => s.canvas)
  const activePageId = useStore((s) => s.activePageId)
  const [filter, setFilter] = useState<ThreadState>('open')
  const [, setReviewed] = useState(0)
  const userId = authClient.useSession().data?.user.id ?? ''
  const t = useT()

  const threads = useMemo(() => pageThreads(comments, canvas, activePageId), [comments, canvas, activePageId])
  const counts = { open: 0, resolved: 0 }
  for (const thread of threads) counts[threadState(thread)] += 1
  const shown = threads.filter((thread) => threadState(thread) === filter)

  /* the anchor is this browser's, per user and canvas: "Mark reviewed" moves it */
  const anchor = canvas && userId ? readReviewAnchor(userId, canvas.id) : 0
  /* the anchor is canvas-wide, so the summary reads every page, not the one in view */
  const canvasThreads = useMemo(
    () => (canvas ? canvasPages(canvas).flatMap((page) => pageThreads(comments, canvas, page.id)) : []),
    [comments, canvas],
  )
  const summary = reviewSummary(canvasThreads, anchor)
  const markReviewed = () => {
    if (!canvas || !userId) return
    writeReviewAnchor(userId, canvas.id, Date.now())
    setReviewed((n) => n + 1)
  }

  const status = !canvas ? 'loading' : threads.length === 0 ? 'empty' : 'ready'
  return (
    <PanelBody className="pb-2">
      <PanelState
        status={status}
        loadingLabel={t('stage.readingThreads')}
        empty={{ title: t('stage.noCommentsTitle'), hint: t('stage.noCommentsHint') }}
        offline={t('stage.offlineResolve')}
      >
        <ReviewSummary summary={summary} anchor={anchor} canMark={userId !== ''} onMark={markReviewed} />
        {/* the same quiet segmented switch as the panel's own tabs */}
        <div role="group" aria-label={t('stage.commentFilter')} className="flex gap-0.5 pb-1">
          <FilterTab active={filter === 'open'} count={counts.open} onClick={() => setFilter('open')}>
            {t('stage.filterOpen')}
          </FilterTab>
          <FilterTab active={filter === 'resolved'} count={counts.resolved} onClick={() => setFilter('resolved')}>
            {t('stage.filterResolved')}
          </FilterTab>
        </div>
        {shown.length === 0 ? (
          <div className={emptyNote}>{t(filter === 'open' ? 'stage.noOpenThreads' : 'stage.noResolvedThreads')}</div>
        ) : (
          shown.map((thread) => <ThreadRow key={thread.root.id} thread={thread} />)
        )}
      </PanelState>
    </PanelBody>
  )
}

/** "Since last review": what was resolved after the anchor, and what is still open. */
function ReviewSummary({
  summary,
  anchor,
  canMark,
  onMark,
}: {
  summary: ReturnType<typeof reviewSummary>
  anchor: number
  canMark: boolean
  onMark: () => void
}) {
  const t = useT()
  const kinds = [
    summary.addressed > 0 && t('stage.reviewAddressed', { count: summary.addressed }),
    summary.wontFix > 0 && t('stage.reviewWontFix', { count: summary.wontFix }),
    summary.moved > 0 && t('stage.reviewMoved', { count: summary.moved }),
  ].filter(Boolean)
  const open = [
    t('stage.reviewOpen', { count: summary.open }),
    summary.waiting > 0 && t('stage.reviewWaits', { count: summary.waiting }),
  ].filter(Boolean)
  return (
    <div data-testid="review-summary" className="flex items-start gap-2 rounded-row bg-sub px-2.5 py-2">
      <div className="min-w-0 flex-1 text-label text-ink-soft">
        <div className="text-caption font-medium text-ink">
          {t('stage.reviewSince')}
          {anchor > 0 && <span className="font-normal text-ink-faint"> · {timeAgo(anchor)}</span>}
        </div>
        <div>
          {[t('stage.reviewResolved', { count: summary.resolved }), kinds.join(', ')].filter(Boolean).join(' · ')}
        </div>
        <div>{open.join(' · ')}</div>
      </div>
      {canMark && (
        <Button variant="bare" className="h-7 flex-none rounded-row px-2 text-label font-normal" onClick={onMark}>
          {t('stage.reviewMark')}
        </Button>
      )}
    </div>
  )
}

function FilterTab({
  active,
  count,
  children,
  onClick,
}: {
  active: boolean
  count: number
  children: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'flex h-[26px] items-center gap-1.5 rounded-[7px] px-2 text-[12px] transition-colors',
        active ? 'bg-paper-deep font-medium text-ink' : 'text-ink-soft hover:bg-sub hover:text-ink',
      )}
    >
      {children}
      <span className={cn('text-[11px] tabular-nums', active ? 'text-ink-soft' : 'text-ink-faint')}>{count}</span>
    </button>
  )
}

/* replies and resolves are metered like any other resident task when they
   @mention an agent — a 403 means the free tier ran out, so raise the wall */
function reportLimit(err: unknown) {
  if (isResidentLimit(err)) useStore.getState().setLimitWall(true)
  else console.error(err)
}

/** One thread, in the same shape as a task row: who and when on the first
 *  line, the comment under it, then where it is pinned and how many replies.
 *  Open threads carry a reply field and a Resolve action. */
function ThreadRow({ thread }: { thread: CommentThreadGroup }) {
  const { root, frame } = thread
  const resolved = threadState(thread) === 'resolved'
  /* a view link reads threads; it neither replies nor resolves */
  const canComment = useStore(canCommentOpenCanvas)
  const t = useT()
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [failed, setFailed] = useState(false)
  const connected = useStore((s) => s.connected)
  const [picked, setPicked] = useState<CommentResolution | null>(null)
  const [resolveFailure, setResolveFailure] = useState<{ status: number; body: ResolveBody } | null>(null)
  const waitingOn = waitsOn(thread)

  /* fly to the pin (its frame, or its point on the canvas) and pop it — the
     pin shows the whole conversation, this row is the index entry */
  const goToThread = () => {
    const s = useStore.getState()
    if (frame) {
      s.select(frame.id)
      s.requestFlyTo(frame.id)
    } else if (isCanvasComment(root)) {
      s.select(null)
      s.setActivePage(root.pageId)
      s.requestFlyToPoint(root.x, root.y)
    }
    if (!resolved) s.requestOpenThread(root.id)
  }

  async function reply() {
    const text = draft.trim()
    if (!text || sending) return
    setSending(true)
    setFailed(false)
    try {
      await api.replyComment(root.id, text)
      posthog.capture('element_comment_replied')
      setDraft((current) => (current === draft ? '' : current))
    } catch (err) {
      setFailed(true)
      reportLimit(err)
    } finally {
      setSending(false)
    }
  }

  /* a failed resolve leaves the thread open and keeps what was sent for Try again */
  async function resolve(body: ResolveBody) {
    setResolveFailure(null)
    try {
      await api.resolveComment(root.id, body)
      posthog.capture('element_comment_resolved', { reason: body.reason })
    } catch (err) {
      if (isResidentLimit(err)) reportLimit(err)
      else setResolveFailure({ status: err instanceof ApiError ? err.status : 0, body })
    }
  }

  return (
    <div className="mx-1.5 py-1">
      <div
        role="button"
        tabIndex={0}
        title={frame ? t('stage.goToFrame', { name: frame.name }) : t('stage.goToPin')}
        onClick={goToThread}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            goToThread()
          }
        }}
        className="grid cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 gap-y-[2px] rounded-[8px] px-1.5 py-2 text-[12px] leading-[18px] hover:bg-sub focus-visible:bg-sub focus-visible:outline-none"
      >
        <span className="flex min-w-0 items-center gap-1.5 whitespace-nowrap">
          <span
            aria-hidden
            className="grid size-4 flex-none place-items-center rounded-full text-[8px] leading-none font-medium text-white"
            style={{ background: colorFor(root.from) }}
          >
            {root.from.slice(0, 1).toUpperCase()}
          </span>
          <b className="truncate font-medium text-ink">{root.from}</b>
        </span>
        <span className="text-[11px] text-ink-faint tabular-nums">{timeAgo(root.at)}</span>
        {/* open threads clamp (the pin shows the whole conversation); a
            resolved one has no pin to open, so it reads in full here */}
        <span className={cn('col-span-2 min-w-0 break-words pl-[22px] text-ink-soft', !resolved && 'line-clamp-3')}>
          {root.text}
        </span>
        {(frame || resolved) && (
          <span className="col-span-2 flex min-w-0 items-center gap-[7px] pl-[22px] text-[11px] text-ink-faint">
            {resolved && (
              <span className="grid size-3 flex-none place-items-center rounded-full bg-ink text-paper">
                <CheckIcon className="size-[8px]" strokeWidth={2.4} />
              </span>
            )}
            {frame && (
              <span className="min-w-0 truncate" title={frame.name}>
                {frame.name}
              </span>
            )}
            {resolved && root.resolvedBy && (
              <span className="min-w-0 truncate">
                {frame ? '· ' : ''}
                {t('stage.resolvedBy', { name: root.resolvedBy })}
              </span>
            )}
          </span>
        )}
      </div>
      {resolved && root.resolution && <ResolutionLine root={root} />}
      {waitingOn && (
        <div className="flex flex-col gap-1 pr-1.5 pb-1 pl-[28px]">
          <Badge tone="outline" className="self-start">
            {t('stage.waitsOnMultica')}
          </Badge>
          <span className="text-caption text-ink-faint">
            {waitingOn.issueKey && (
              <>
                {t('stage.questionOn')} <IssueLink issueKey={waitingOn.issueKey} />.{' '}
              </>
            )}
            {t('stage.staysOpen')}
          </span>
        </div>
      )}
      {resolved && thread.replies.length > 0 && (
        <Disclosure
          label={t('stage.replies', { count: thread.replies.length })}
          className="py-1 pr-1.5 pl-[28px] text-label text-ink-soft"
        >
          <ol className="space-y-3" aria-label={t('stage.resolvedReplies')}>
            {thread.replies.map((reply) => (
              <li key={reply.id}>
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate font-medium text-ink">{reply.from}</span>
                  <span className="shrink-0 text-caption text-ink-faint">{timeAgo(reply.at)}</span>
                </div>
                <p className="whitespace-pre-wrap break-words">{reply.text}</p>
              </li>
            ))}
          </ol>
        </Disclosure>
      )}
      {!resolved && canComment && (
        <div className="flex items-center gap-1.5 py-1 pr-1.5 pl-[28px]">
          <Input
            variant="bare"
            inputSize="auto"
            className="h-7 min-w-0 flex-1 rounded-[7px] bg-surface px-2.5 shadow-ring focus:shadow-elevation-1-focus md:text-[12px]"
            placeholder={t('stage.replyPanelPlaceholder')}
            aria-label={t('stage.replyTo', { name: root.from })}
            value={draft}
            disabled={sending}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !isComposingEnter(e)) void reply()
            }}
          />
          {/* a thread that waits on a Multica question stays open until it is answered there */}
          {!waitingOn && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="bare"
                  className="h-7 flex-none gap-1 rounded-[7px] px-2 text-[12px] font-normal"
                  title={t('stage.markResolved')}
                  disabled={!connected}
                >
                  {t('stage.resolve')}
                  <ChevronDownIcon className="size-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" width="md">
                <DropdownMenuCaption>{t('stage.resolveAs')}</DropdownMenuCaption>
                {RESOLVE_REASONS.map((reason) => (
                  <DropdownMenuItem
                    key={reason}
                    data-reason={reason}
                    description={t(`stage.${HINT_KEY[reason]}`)}
                    onSelect={() => setPicked(reason)}
                  >
                    {t(`stage.${REASON_KEY[reason]}`)}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      )}
      {picked && (
        <ResolveDialog
          reason={picked}
          onClose={() => setPicked(null)}
          onSubmit={(body) => {
            setPicked(null)
            void resolve(body)
          }}
        />
      )}
      {resolveFailure && (
        <Callout tone="error" role="alert" className="mt-1 ml-[28px] flex items-center gap-2">
          <span className="min-w-0 flex-1">{t('stage.resolveFailed', { status: resolveFailure.status })}</span>
          <Button
            variant="bare"
            className="h-6 flex-none px-2 text-label"
            disabled={!connected}
            onClick={() => void resolve(resolveFailure.body)}
          >
            {t('panels.panelStateRetry')}
          </Button>
        </Callout>
      )}
      {failed && <div className="pl-[28px] text-[11px] leading-[1.4] text-accent-ink">{t('stage.replyFailed')}</div>}
    </div>
  )
}

const REASON_KEY = { addressed: 'reasonAddressed', wont_fix: 'reasonWontFix', moved: 'reasonMoved' } as const
const HINT_KEY = {
  addressed: 'reasonAddressedHint',
  wont_fix: 'reasonWontFixHint',
  moved: 'reasonMovedHint',
} as const
const WHY_KEY = { addressed: 'resolveWhyAddressed', wont_fix: 'resolveWhyWontFix', moved: 'resolveWhyMoved' } as const

/** A Multica issue key, a link when the build knows where Multica lives. */
function IssueLink({ issueKey }: { issueKey: string }) {
  const url = multicaIssueUrl(issueKey)
  return url ? (
    <a data-slot="issue-link" href={url} target="_blank" rel="noreferrer" className="text-ink underline">
      {issueKey}
    </a>
  ) : (
    <span data-slot="issue-link" className="text-ink">
      {issueKey}
    </span>
  )
}

/** The reason chip of a resolved thread and what it points at. */
function ResolutionLine({ root }: { root: CommentThreadGroup['root'] }) {
  const t = useT()
  const { resolution, resolutionRef: ref, resolutionNote: note } = root
  if (!resolution) return null
  return (
    <div className="flex min-w-0 items-center gap-1.5 pr-1.5 pb-1 pl-[28px]">
      <Badge tone={resolution === 'addressed' ? 'success' : 'outline'}>{t(`stage.${REASON_KEY[resolution]}`)}</Badge>
      <span className="min-w-0 truncate text-caption text-ink-faint">
        {resolution === 'addressed' && ref && t('stage.resolvedIn', { ref })}
        {resolution === 'moved' && ref && <IssueLink issueKey={ref} />}
        {resolution === 'wont_fix' && note}
      </span>
    </div>
  )
}

/** One line per reason: the ref it names, or for Won't fix the note. Resolve
 *  stays off while the line is empty. */
function ResolveDialog({
  reason,
  onClose,
  onSubmit,
}: {
  reason: CommentResolution
  onClose: () => void
  onSubmit: (body: ResolveBody) => void
}) {
  const t = useT()
  const [typed, setTyped] = useState('')
  const body = resolveBody(reason, typed)
  return (
    <Modal size="sm" onClose={onClose}>
      <ModalTitle>{t('stage.resolveDialogTitle', { reason: t(`stage.${REASON_KEY[reason]}`) })}</ModalTitle>
      <Field label={t(`stage.${WHY_KEY[reason]}`)} htmlFor="resolve-line" className="mt-3">
        <Input
          id="resolve-line"
          variant="well"
          autoFocus
          maxLength={RESOLVE_MAX[reason]}
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !isComposingEnter(e) && body) onSubmit(body)
          }}
        />
      </Field>
      <ModalActions>
        <ModalSpacer />
        <Button onClick={onClose}>{t('stage.resolveCancel')}</Button>
        <Button variant="primary" disabled={!body} onClick={() => body && onSubmit(body)}>
          {t('stage.resolve')}
        </Button>
      </ModalActions>
    </Modal>
  )
}
