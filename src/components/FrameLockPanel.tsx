import { canEditOpenCanvas, useStore } from '@/lib/store'
import { useT } from '@/lib/i18n'
import type { Frame } from '../../shared/types'
import { ictDateTime, useLockUi, type LockError } from '@/lib/frameLock'
import { rereadLocks, setFramesLocked, unlockConfirmed } from '@/lib/layerEdits'
import { PanelState, type PanelStatus } from './PanelState'
import { AlertIcon, LockIcon } from './ui/icons'
import { Button } from './ui/button'
import { Callout } from './ui/callout'

type Translate = ReturnType<typeof useT>
const lockErrorText = (error: LockError, t: Translate) =>
  error.status === null
    ? t('panels.lockPanelUnknown', { name: error.name })
    : t('panels.lockPanelError', { name: error.name, status: error.status })
/* Try again: read the lock back when its state is unknown, else send the unlock again. */
const retryLock = (error: LockError) =>
  error.status === null ? void rereadLocks(error.frameIds) : unlockConfirmed(error.frameIds)

/* The lock's states in the Layers panel (A1): reading, nothing locked, a
   refused unlock with its retry, and the offline banner. Locked frames
   themselves show in their rows; with some locked and no trouble there is
   nothing more to draw. */
export function FrameLockPanel() {
  const t = useT()
  const frames = useStore((s) => s.canvas?.frames)
  const readOnly = useStore((s) => !canEditOpenCanvas(s))
  const connected = useStore((s) => s.connected)
  const error = useLockUi((s) => s.error)
  const reading = useLockUi((s) => s.reading.length > 0)
  if (!frames?.length) return null
  const status: PanelStatus = reading ? 'loading' : error ? 'error' : frames.some((f) => f.locked) ? 'ready' : 'empty'
  if (status === 'ready' && connected) return null
  return (
    <div data-slot="frame-lock-panel" className="flex-none px-3.5 pb-2.5">
      <PanelState
        status={status}
        loadingLabel={t('panels.lockPanelLoading')}
        empty={
          readOnly
            ? { title: t('panels.lockPanelEmptyTitle') }
            : {
                title: t('panels.lockPanelEmptyTitle'),
                hint: t('panels.lockPanelEmptyHint'),
                action: {
                  label: t('panels.lockPanelEmptyAction'),
                  icon: <LockIcon className="size-3.5" />,
                  onClick: () => {
                    const s = useStore.getState()
                    const picked = s.canvas?.frames.filter((f) => s.selectedIds.includes(f.id)) ?? []
                    if (picked.length) setFramesLocked(picked, true)
                    else s.pushNotice(t('panels.lockPanelPickFirst'))
                  },
                },
              }
        }
        error={error ? lockErrorText(error, t) : undefined}
        onRetry={error ? () => retryLock(error) : undefined}
        offline={t('panels.lockPanelOffline')}
      />
    </div>
  )
}

/* By, When and Reason of a lock (A1's lock card); a line the lock has no data
   for, such as a reason left empty, is not drawn. */
export function LockDetails({ frame }: { frame: Pick<Frame, 'lockedBy' | 'lockedAt' | 'lockReason'> }) {
  const t = useT()
  const rows = [
    [t('panels.lockInfoBy'), frame.lockedBy],
    [t('panels.lockInfoWhen'), frame.lockedAt ? ictDateTime(frame.lockedAt) : undefined],
    [t('panels.lockInfoReason'), frame.lockReason],
  ].filter((row): row is [string, string] => !!row[1])
  if (!rows.length) return null
  return (
    <dl data-slot="lock-details" className="grid grid-cols-[52px_1fr] gap-x-2 gap-y-0.5 text-label">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-ink-faint">{label}</dt>
          <dd className="min-w-0 break-words text-ink-soft">{value}</dd>
        </div>
      ))}
    </dl>
  )
}

/* The same error and Try again inside the phone's Inspector sheet (A1 at 390),
   where there is no Layers panel to draw them. Only for this frame's error. */
export function LockErrorNote({ frameId }: { frameId: string }) {
  const t = useT()
  const error = useLockUi((s) => (s.error?.frameIds.includes(frameId) ? s.error : null))
  const connected = useStore((s) => s.connected)
  if (!error) return null
  return (
    <div data-testid="inspector-lock-error" className="flex flex-col gap-2">
      <Callout role="alert" tone="error" className="flex items-start gap-2">
        <AlertIcon aria-hidden className="mt-0.5 shrink-0" />
        <span>{lockErrorText(error, t)}</span>
      </Callout>
      <Button className="self-start" disabled={!connected} onClick={() => retryLock(error)}>
        {t('panels.panelStateRetry')}
      </Button>
    </div>
  )
}
