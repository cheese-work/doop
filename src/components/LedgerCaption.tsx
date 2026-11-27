import type { CSSProperties } from 'react'
import { activePageOf, useStore } from '../lib/store'
import { useT } from '../lib/i18n'
import { cn } from '../lib/utils'
import { BookOpenIcon } from './ui/icons'

/** What the ledger page is and when it changes (CHE-9398 L8, A5). Shown only while the ledger page is the
 *  active page. `bar` is the desktop chip floating over the stage, `box` the note on top of the phone sheet. */
export function LedgerCaption({
  variant = 'bar',
  className,
  style,
}: {
  variant?: 'bar' | 'box'
  className?: string
  style?: CSSProperties
}) {
  const t = useT()
  const ledger = useStore((s) => !!activePageOf(s)?.ledger)
  if (!ledger) return null
  return (
    <p
      role="status"
      data-slot="ledger-caption"
      style={style}
      className={cn(
        'text-label text-ink-soft',
        variant === 'bar'
          ? 'pointer-events-none absolute z-20 flex max-w-[min(560px,50vw)] items-center gap-2 rounded-panel bg-surface px-3 py-2 shadow-float'
          : 'mx-2 mt-2 rounded-card bg-sub px-3 py-2 text-caption',
        className,
      )}
    >
      {variant === 'bar' && <BookOpenIcon className="size-3.5 flex-none text-brand" />}
      <span>
        <strong className="font-medium text-ink">{t('panels.ledgerCaptionLead')}</strong>{' '}
        {t('panels.ledgerCaptionRest')}
      </span>
    </p>
  )
}
