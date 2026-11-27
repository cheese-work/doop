import { useStore } from '@/lib/store'
import { useT } from '@/lib/i18n'
import { lockedByLine, useLockUi } from '@/lib/frameLock'
import { unlockConfirmed } from '@/lib/layerEdits'
import { ConfirmDialog } from './ui/alert-dialog'

/* The one unlock confirm (A1). `setFramesLocked(frames, false)` raises it, so
   the Layers rows, the Inspector, the frame menu and ⌘⇧L all land here;
   Keep locked, Escape and a click outside send nothing. Mounted once, in the
   editor. */
export function UnlockFrameDialog() {
  const t = useT()
  const request = useLockUi((s) => s.confirm)
  const frames = useStore((s) => s.canvas?.frames)
  /* a frame someone else unlocked meanwhile has nothing left to confirm */
  const asked = (request?.frameIds ?? []).flatMap((id) => frames?.find((f) => f.id === id && f.locked) ?? [])
  const [first] = asked
  const close = () => useLockUi.setState({ confirm: null })
  return (
    <ConfirmDialog
      open={!!request && !!first}
      onOpenChange={(open) => {
        if (!open) close()
      }}
      title={
        asked.length > 1
          ? t('panels.lockConfirmTitleMany', { count: asked.length })
          : t('panels.lockConfirmTitle', { name: first?.name ?? '' })
      }
      description={
        <>
          {asked.length > 1 ? t('panels.lockConfirmBodyMany') : t('panels.lockConfirmBody')}{' '}
          {asked.length === 1 ? lockedByLine(first?.lockedBy, first?.lockedAt) : ''}
        </>
      }
      cancelLabel={t('panels.lockConfirmKeep')}
      confirmLabel={t('panels.lockConfirmUnlock')}
      onConfirm={() => {
        close()
        unlockConfirmed(asked.map((f) => f.id))
      }}
    />
  )
}
