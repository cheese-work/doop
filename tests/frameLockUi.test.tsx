// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Canvas, Frame } from '../shared/types'

/* U1 (CHE-9395): the frame lock UI. The marker, the one unlock confirm every
   entry point goes through, the 423 text, the refusal and lost-reply states.
   The API is mocked at the wire: an ApiError carries the S1 body shape. */

const updateFrame = vi.fn((_id: string, _patch: Partial<Frame>): Promise<unknown> => Promise.resolve({}))
const getCanvas = vi.fn((_id: string): Promise<unknown> => Promise.resolve({}))
vi.mock('../src/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      canvasLibrary: () => new Promise(() => {}),
      updateFrame: (id: string, patch: Partial<Frame>) => updateFrame(id, patch),
      getCanvas: (id: string) => getCanvas(id),
    },
  }
})
vi.mock('../src/lib/posthog', () => ({ posthog: { capture: vi.fn() } }))
vi.mock('../src/lib/frameBridge', () => ({ requestFrame: vi.fn(async () => null) }))

const { ApiError } = await import('../src/lib/api')
const { useStore } = await import('../src/lib/store')
const { useLockUi } = await import('../src/lib/frameLock')
const { LayersPanel } = await import('../src/components/LayersPanel')
const { Inspector } = await import('../src/components/Inspector')
const { FrameContextMenu } = await import('../src/components/FrameContextMenu')
const { UnlockFrameDialog } = await import('../src/components/UnlockFrameDialog')
const { ContextMenu, ContextMenuTrigger } = await import('../src/components/ui/context-menu')
const { TooltipProvider } = await import('../src/components/ui/tooltip')
const { ACTIONS } = await import('../src/lib/actions/registry')
const { saveFrameHtml } = await import('../src/lib/layerEdits')

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/* 13 Nov 2026 16:20 ICT is 09:20 UTC */
const LOCKED_AT = Date.UTC(2026, 10, 13, 9, 20)
const PAGE = '<!doctype html><html><head></head><body><div><p>A</p></div></body></html>'
const SHAPE =
  '<!doctype html><html><head></head><body data-doop-canvas-element="true"><div data-doop-drawing="rect">x</div></body></html>'
const DIV = 'body:nth-of-type(1) > div:nth-of-type(1)'

const base: Frame = {
  id: 'f1',
  canvasId: 'c1',
  name: 'Cart · phone',
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  html: PAGE,
  createdAt: 0,
  updatedAt: 0,
  updatedBy: 'me',
}
const locked: Frame = {
  ...base,
  locked: true,
  lockedBy: 'Cheese',
  lockedAt: LOCKED_AT,
  lockReason: 'Direction B not chosen',
}

let container: HTMLDivElement
let root: Root

function mount(frame: Frame, extra?: () => React.ReactNode) {
  const canvas = { id: 'c1', name: 'Canvas', frames: [frame] } as Canvas
  useStore.getState().setCanvas(canvas)
  useStore.setState({
    selectedId: frame.id,
    selectedIds: [frame.id],
    selectedElement: null,
    connected: true,
    notice: null,
  })
  act(() =>
    root.render(
      <TooltipProvider>
        <LayersPanel onAddFrame={() => {}} />
        <Inspector frame={frame} />
        <ContextMenu>
          <ContextMenuTrigger>
            <span data-test-menu>Frame</span>
          </ContextMenuTrigger>
          <FrameContextMenu frame={frame} at={{ current: { x: 0, y: 0 } }} />
        </ContextMenu>
        <UnlockFrameDialog />
        {extra?.()}
      </TooltipProvider>,
    ),
  )
}
const current = () => useStore.getState().canvas!.frames[0]!
const dialog = () => document.querySelector('[data-slot="confirm-dialog"]')
const button = (label: string) =>
  [...(dialog() ?? document).querySelectorAll('button')].find((b) => b.textContent === label)
const click = (el: Element | null | undefined) => act(() => (el as HTMLElement).click())
const flush = () => act(async () => {})

function layersRowLock(key: string): HTMLButtonElement {
  const row = container.querySelector<HTMLElement>(`[data-row-key^="${key}"]`)
  const el = row?.querySelector<HTMLButtonElement>('button[aria-label="Unlock"], button[aria-label="Lock"]')
  if (!el) throw new Error(`row ${key} has no lock`)
  return el
}
function openContextMenu() {
  act(() =>
    container
      .querySelector('[data-test-menu]')!
      .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, button: 2 })),
  )
  return [...document.querySelectorAll('[role="menuitem"]')].find((el) => /^Unlock/.test(el.textContent ?? ''))
}
const inspectorUnlock = () =>
  [...container.querySelectorAll('button')].find((b) => b.textContent === 'Unlock' && !b.getAttribute('aria-label'))

beforeEach(() => {
  updateFrame.mockReset().mockResolvedValue({})
  getCanvas.mockReset()
  useLockUi.setState({ confirm: null, error: null, reading: [] })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
})

describe('the unlock confirm, from every entry point', () => {
  const entries: Array<[string, () => void, Frame?]> = [
    ['the Layers frame row', () => click(layersRowLock('f1'))],
    ['the Layers element row of a standalone element', () => click(layersRowLock('f1|')), { ...locked, html: SHAPE }],
    ['the Inspector Unlock button', () => click(inspectorUnlock())],
    ['the frame context menu', () => click(openContextMenu())],
    ['Cmd+Shift+L', () => act(() => ACTIONS.find((a) => a.id === 'toggle-locked')!.run())],
  ]
  for (const [name, open, frame] of entries) {
    it(`${name} opens the confirm; Keep locked sends nothing and Unlock sends one write`, async () => {
      mount(frame ?? locked)
      expect(dialog()).toBeNull()
      open()
      expect(dialog()?.textContent).toContain('Unlock Cart · phone?')
      expect(updateFrame).not.toHaveBeenCalled()
      click(button('Keep locked'))
      expect(dialog()).toBeNull()
      expect(updateFrame).not.toHaveBeenCalled()
      expect(current().locked).toBe(true)

      open()
      click(button('Unlock'))
      await flush()
      expect(updateFrame).toHaveBeenCalledTimes(1)
      expect(updateFrame).toHaveBeenCalledWith('f1', { locked: false })
    })
  }

  it('names who locked it and when, in ICT, in the confirm', () => {
    mount(locked)
    click(layersRowLock('f1'))
    expect(dialog()?.textContent).toContain('Locked by Cheese on 13 Nov 2026 16:20 ICT.')
  })

  it('does not confirm a lock', () => {
    mount(base)
    click(layersRowLock('f1'))
    expect(dialog()).toBeNull()
    expect(updateFrame).toHaveBeenCalledWith('f1', { locked: true })
  })

  it('does not confirm an element lock toggle, and leaves the frame alone', () => {
    mount(base)
    /* the caret opens the frame's layers */
    click(container.querySelector<HTMLElement>('[data-row-key^="f1"] [data-icon]'))
    const row = container.querySelector<HTMLElement>(`[data-row-key*="${DIV}"]`)
    const toggle = row?.querySelector<HTMLButtonElement>('button[aria-label="Lock"]')
    expect(toggle).toBeTruthy()
    click(toggle)
    expect(dialog()).toBeNull()
    expect(current().locked).toBeFalsy()
  })
})

describe('the lock marker', () => {
  it('shows Locked, the actor and the ICT time on the Layers row, the Inspector and the frame title source', () => {
    mount(locked)
    const row = container.querySelector('[data-row-key^="f1"]')!
    expect(row.textContent).toContain('Locked · Cheese · 16:20 ICT')
    expect(container.textContent).toContain('Direction B not chosen')
  })

  it('hides the reason line when the reason is null, and still shows the marker', () => {
    mount({ ...locked, lockReason: undefined })
    expect(container.textContent).toContain('Locked · Cheese · 16:20 ICT')
    expect(container.textContent).not.toContain('Reason')
  })

  it('shows a bare Locked for a lock made before S1 recorded who and when', () => {
    mount({ ...base, locked: true })
    expect(container.querySelector('[data-row-key^="f1"]')!.textContent).toContain('Locked')
    expect(container.textContent).not.toContain('ICT')
  })
})

describe('a refused edit', () => {
  it('toasts who locked it, when and why from the 423 body', async () => {
    mount(locked)
    updateFrame.mockRejectedValueOnce(
      new ApiError(
        423,
        JSON.stringify({
          error: 'policy_refused: update_frame: frame is locked',
          code: 'frame_locked',
          lockedBy: 'Cheese',
          lockedAt: LOCKED_AT,
          reason: 'Direction B not chosen',
        }),
      ),
    )
    saveFrameHtml(current(), '<p>x</p>')
    await flush()
    const text = useStore.getState().notice?.text ?? ''
    expect(text).toContain('Cart · phone is locked')
    expect(text).toContain('Cheese')
    expect(text).toContain('13 Nov 2026 16:20 ICT')
    expect(text).toContain('Direction B not chosen')
  })
})

describe('an unlock the server refuses', () => {
  const shapes: Array<[string, number, Record<string, unknown>]> = [
    ['403', 403, { error: 'forbidden' }],
    [
      '423 policy_refused',
      423,
      { error: 'policy_refused: update_frame: only a lock owner can unlock it', code: 'policy_refused' },
    ],
  ]
  for (const [name, status, body] of shapes) {
    it(`${name} keeps the frame locked and shows the A1 error state`, async () => {
      mount(locked)
      click(layersRowLock('f1'))
      updateFrame.mockRejectedValueOnce(new ApiError(status, JSON.stringify(body)))
      click(button('Unlock'))
      await flush()
      expect(current().locked).toBe(true)
      expect(current().lockedBy).toBe('Cheese')
      const alert = container.querySelector('[data-testid="panel-state-error"]')
      expect(alert?.textContent).toContain(`Could not unlock Cart · phone (${status}). It is still locked.`)
      expect(alert?.textContent).toContain('Try again')
      expect(container.querySelector('[data-row-key^="f1"]')!.textContent).toContain('Locked · Cheese')
    })
  }
})

describe('a lost reply', () => {
  it('re-reads the frame before it shows the marker, then shows the server state', async () => {
    mount(base)
    let reply!: (c: unknown) => void
    getCanvas.mockReturnValueOnce(new Promise((resolve) => (reply = resolve)))
    updateFrame.mockRejectedValueOnce(new TypeError('network lost'))
    click(layersRowLock('f1'))
    await flush()
    /* the write may have landed: no marker is drawn from a guess */
    expect(getCanvas).toHaveBeenCalledWith('c1')
    expect(container.textContent).toContain('Reading lock state…')
    expect(container.querySelector('[data-row-key^="f1"]')!.textContent).not.toContain('Locked ·')
    await act(async () => reply({ id: 'c1', name: 'Canvas', frames: [locked] }))
    expect(container.textContent).not.toContain('Reading lock state…')
    expect(current().locked).toBe(true)
    expect(container.querySelector('[data-row-key^="f1"]')!.textContent).toContain('Locked · Cheese · 16:20 ICT')
  })

  it('shows the unlocked server state after a lost unlock reply that did land', async () => {
    mount(locked)
    click(layersRowLock('f1'))
    getCanvas.mockResolvedValueOnce({ id: 'c1', name: 'Canvas', frames: [{ ...base }] })
    updateFrame.mockRejectedValueOnce(new TypeError('network lost'))
    click(button('Unlock'))
    await flush()
    await flush()
    expect(current().locked).toBeFalsy()
    expect(container.querySelector('[data-row-key^="f1"]')!.textContent).not.toContain('Locked ·')
  })
})

describe('the lock states', () => {
  it('shows No locked frames and the one Lock frame action when nothing is locked', () => {
    mount(base)
    const empty = container.querySelector('[data-testid="panel-state-empty"]')
    expect(empty?.textContent).toContain('No locked frames')
    expect(empty?.textContent).toContain('Lock frame')
  })

  it('pauses lock and unlock while disconnected, with the banner', () => {
    mount(locked)
    act(() => useStore.setState({ connected: false }))
    expect(container.querySelector('[data-testid="panel-state-offline"]')?.textContent).toContain(
      'Offline. Lock and unlock are paused. Locked frames stay locked.',
    )
    click(layersRowLock('f1'))
    expect(dialog()).toBeNull()
    expect(updateFrame).not.toHaveBeenCalled()
  })
})
