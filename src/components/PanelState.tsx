import type { ReactNode } from 'react'

import { useT } from '@/lib/i18n'
import { useStore } from '@/lib/store'
import { AlertIcon, WifiOffIcon } from './ui/icons'
import { Button } from './ui/button'
import { Callout } from './ui/callout'
import { Note } from './ui/note'
import { Skeleton } from './ui/skeleton'

/** An action a state offers: the empty state's one button. */
export type PanelAction = { label: string; onClick: () => void; icon?: ReactNode }

export type PanelStatus = 'loading' | 'empty' | 'error' | 'ready'

/* The skeleton bars of the approved lifecycle design: three rows, narrowing. */
const BARS = ['w-2/5', 'w-full', 'w-7/10'] as const

/* The shared states of the lifecycle panels (frame lock, Archive and Trash,
   comment threads; design/lifecycle-ui/approved): loading, empty, error with
   a retry, and the offline banner with its reconnect line. The panel passes
   its own copy. While `store.connected` is false the banner shows above
   whatever the status draws, and every action passed in is disabled: reading
   keeps working, writing pauses. */
function PanelState({
  status,
  loadingLabel,
  empty,
  error,
  onRetry,
  offline,
  children,
}: {
  status: PanelStatus
  /** loading: the line under the skeleton, "Reading lock state…" */
  loadingLabel?: string
  /** empty: the title, the line of why and the one action */
  empty?: { title: string; hint?: string; action?: PanelAction }
  /** error: what failed and what state things are still in */
  error?: string
  /** error: the Try again action; left out, the banner has none */
  onRetry?: () => void
  /** disconnected: what is paused, "Offline. Restore and delete forever are paused." */
  offline?: string
  /** ready: the panel's own content */
  children?: ReactNode
}) {
  const t = useT()
  const connected = useStore((s) => s.connected)
  return (
    <div data-slot="panel-state" className="flex flex-col gap-2.5">
      {connected ? null : (
        <>
          <Callout role="status" data-testid="panel-state-offline" className="flex items-start gap-2">
            <WifiOffIcon aria-hidden className="mt-0.5 shrink-0" />
            <span>{offline}</span>
          </Callout>
          <Note>{t('panels.panelStateReconnecting')}</Note>
        </>
      )}
      {status === 'loading' ? (
        <div className="flex flex-col gap-2" data-testid="panel-state-loading">
          {BARS.map((width, i) => (
            <Skeleton key={width} index={i} className={`h-3 ${width}`} />
          ))}
          {loadingLabel ? <Note>{loadingLabel}</Note> : null}
        </div>
      ) : null}
      {status === 'empty' && empty ? (
        <div className="flex flex-col gap-1.5" data-testid="panel-state-empty">
          <b className="text-body font-semibold">{empty.title}</b>
          {empty.hint ? <Note size="sm">{empty.hint}</Note> : null}
          {empty.action ? (
            <Button className="mt-1.5 self-start" disabled={!connected} onClick={empty.action.onClick}>
              {empty.action.icon}
              {empty.action.label}
            </Button>
          ) : null}
        </div>
      ) : null}
      {status === 'error' ? (
        <div className="flex flex-col gap-2" data-testid="panel-state-error">
          <Callout role="alert" tone="error" className="flex items-start gap-2">
            <AlertIcon aria-hidden className="mt-0.5 shrink-0" />
            <span>{error}</span>
          </Callout>
          {onRetry ? (
            <Button className="self-start" disabled={!connected} onClick={onRetry}>
              {t('panels.panelStateRetry')}
            </Button>
          ) : null}
        </div>
      ) : null}
      {status === 'ready' ? children : null}
    </div>
  )
}

export { PanelState }
