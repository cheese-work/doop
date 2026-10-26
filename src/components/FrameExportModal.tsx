import { readingOrder } from '../../shared/frameOrder'
import type { Frame } from '../../shared/types'
import { navigate } from '../App'
import { downloadFrameExport, downloadFramesPdf, type FrameExportFormat } from '../lib/frameExport'
import { sendFramesToCanva, useCanvaStatus } from '../integrations/canva/export'
import { Button } from './ui/button'
import { Modal, ModalActions, ModalLede, ModalTitle } from './ui/modal'

export function FrameExportModal({
  frame,
  groupFrames = [frame],
  onClose,
  onSendToFigma,
  figmaFrameCount,
}: {
  frame: Frame
  /** the selection the menu acts on; the PDF binds all of it, a page per
   *  frame in reading order */
  groupFrames?: Frame[]
  onClose: () => void
  onSendToFigma: () => void
  figmaFrameCount: number
}) {
  const canva = useCanvaStatus()

  function download(format: FrameExportFormat) {
    void downloadFrameExport(frame, format)
    onClose()
  }

  function downloadPdf() {
    void downloadFramesPdf(frame.canvasId, readingOrder(groupFrames))
    onClose()
  }

  function openIntegrations() {
    onClose()
    navigate('/integrations')
  }

  return (
    <Modal size="sm" onClose={onClose}>
      <ModalTitle className="break-words">Export “{frame.name}”</ModalTitle>
      <ModalLede>
        {canva?.enabled === false
          ? 'Download an image or layered file, or continue editing in Figma.'
          : 'Download an image or layered file, or continue editing in Canva or Figma.'}
      </ModalLede>
      <div className="mt-5 grid gap-2">
        <Button variant="ghost" className="justify-start" onClick={() => download('png')}>
          Download PNG
        </Button>
        <Button variant="ghost" className="justify-start" onClick={() => download('jpg')}>
          Download JPG
        </Button>
        <Button
          variant="ghost"
          className="h-auto flex-col items-start gap-1 whitespace-normal text-left"
          onClick={() => download('psd')}
        >
          <span>Download PSD</span>
          <span className="text-xs font-normal text-ink-soft">
            Layered Photoshop file with editable text and groups
          </span>
        </Button>
        <Button
          variant="ghost"
          className="h-auto flex-col items-start gap-1 whitespace-normal text-left"
          onClick={downloadPdf}
        >
          <span>{groupFrames.length > 1 ? `Download PDF of ${groupFrames.length} frames` : 'Download PDF'}</span>
          <span className="text-xs font-normal text-ink-soft">
            {groupFrames.length > 1
              ? 'One vector page per frame, top to bottom then left to right'
              : 'Vector page the size of the frame, text stays selectable'}
          </span>
        </Button>
        {canva?.connected ? (
          <Button
            variant="ghost"
            className="justify-start"
            onClick={() => {
              void sendFramesToCanva([frame])
              onClose()
            }}
          >
            Export to Canva
          </Button>
        ) : (
          canva?.enabled !== false && (
            /* not a disabled Button: the Integrations link inside must stay
               clickable, and a button can't hold another button */
            <div
              aria-disabled
              className="grid gap-1 rounded-md border border-line px-3.5 py-2 text-[13px] font-medium text-ink"
            >
              <span className="opacity-45">Export to Canva</span>
              {canva && (
                <span className="text-xs font-normal text-ink-soft">
                  Connect Canva in the{' '}
                  <button
                    type="button"
                    className="font-semibold text-ink underline underline-offset-2 hover:text-accent-ink"
                    onClick={openIntegrations}
                  >
                    Integrations
                  </button>{' '}
                  tab first.
                </span>
              )}
            </div>
          )
        )}
        <Button variant="ghost" className="justify-start" onClick={onSendToFigma}>
          {figmaFrameCount > 1 ? `Send ${figmaFrameCount} frames to Figma…` : 'Send to Figma…'}
        </Button>
      </div>
      <ModalActions>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
      </ModalActions>
    </Modal>
  )
}
