// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Canvas, CanvasPageInfo, Frame } from '../shared/types'

/* The canvas side of the A5 ledger (CHE-9398 L8): the ledger caption, the read-only Finished page, and the
   notice a `page_finished` refusal shows. Design: design/lifecycle-ui/approved/A5-project-ledger.html and
   A-phone-390-all-five.html @ 572cc77. */

const updateFrame = vi.fn(() => Promise.resolve())
const deleteFrame = vi.fn(() => Promise.resolve())
const restackFrames = vi.fn(() => Promise.resolve([]))
const setPageFinished = vi.fn()
const getCanvas = vi.fn()
vi.mock('../src/lib/api', async (original) => {
  const actual = await original<typeof import('../src/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      /* the Components tab's dot asks; nothing waits in these tests */
      canvasLibrary: () => new Promise(() => {}),
      updateFrame: () => updateFrame(),
      deleteFrame: () => deleteFrame(),
      restackFrames: () => restackFrames(),
      setPageFinished: (...args: unknown[]) => setPageFinished(...args),
      getCanvas: (...args: unknown[]) => getCanvas(...args),
    },
  }
})
vi.mock('../src/lib/posthog', () => ({ posthog: { capture: vi.fn() } }))

const storeModule = await import('../src/lib/store')
const { useStore } = storeModule
const { ApiError, req } = await import('../src/lib/api')
const { LayersPanel } = await import('../src/components/LayersPanel')
const { TooltipProvider } = await import('../src/components/ui/tooltip')

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver

const AT = { at: 1, by: 'user' }
const PAGES: CanvasPageInfo[] = [
  { id: 'base', name: 'Baseline', ledger: true },
  { id: 'flows', name: 'Flows' },
  { id: 'fin1', name: 'CHE-5162 · checkout', finished: AT },
]
const CAPTION = 'Ledger page. The latest approved designs. It changes only when a locked proposal lands.'

const frame = (id: string, pageId: string, createdAt: number): Frame => ({
  id,
  canvasId: 'c1',
  pageId,
  name: `Frame ${id}`,
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  html: '<!doctype html><html><head></head><body><div><p>A</p></div></body></html>',
  createdAt,
  updatedAt: 0,
  updatedBy: 'me',
})
const canvasOf = (over: Partial<Canvas> = {}) =>
  ({
    id: 'c1',
    name: 'Canvas',
    pages: PAGES,
    frames: [frame('f1', 'fin1', 1), frame('f2', 'fin1', 2), frame('o1', 'flows', 3), frame('o2', 'flows', 4)],
    ...over,
  }) as unknown as Canvas
function openPage(pageId: string, canvas: Canvas = canvasOf()) {
  useStore.getState().setCanvas(canvas)
  act(() => useStore.getState().setActivePage(pageId))
}

let container: HTMLDivElement
let root: Root
const text = () => container.textContent ?? ''
const settle = () =>
  act(async () => {
    for (let i = 0; i < 12; i++) await Promise.resolve()
  })
const row = (key: string) => {
  const el = container.querySelector<HTMLElement>(`[data-row-key="${key}"]`)
  if (!el) throw new Error(`row ${key} not rendered`)
  return el
}
/* happy-dom has no layout: the row under the pointer is the one the test names */
function dragRow(from: string, onto: string) {
  const target = row(onto)
  document.elementFromPoint = () => target
  target.getBoundingClientRect = () => ({ top: 0, height: 28 }) as DOMRect
  act(() => {
    row(from).dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 0, clientY: 0 }))
  })
  act(() => {
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: 10, clientY: 2 }))
  })
  act(() => {
    window.dispatchEvent(new PointerEvent('pointerup', { clientX: 10, clientY: 2 }))
  })
}
const menuItems = () => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].map((el) => el.textContent)
const isDisabled = (el: HTMLElement) => el.hasAttribute('data-disabled') || el.getAttribute('aria-disabled') === 'true'

describe('canEditActivePage', () => {
  beforeEach(() => useStore.setState({ connected: true, selectedIds: [], selectedId: null }))

  it('is false on a Finished page and true on an open page and on the ledger page', () => {
    openPage('fin1')
    expect(storeModule.canEditActivePage(useStore.getState())).toBe(false)
    openPage('flows')
    expect(storeModule.canEditActivePage(useStore.getState())).toBe(true)
    openPage('base')
    expect(storeModule.canEditActivePage(useStore.getState())).toBe(true)
  })

  it('stays false for a viewer on an open page, and the canvas role rule itself does not change', () => {
    openPage('flows', canvasOf({ role: 'view' }))
    expect(storeModule.canEditActivePage(useStore.getState())).toBe(false)
    openPage('fin1', canvasOf())
    expect(storeModule.canEditOpenCanvas(useStore.getState())).toBe(true)
  })
})

describe('the ledger caption', () => {
  async function renderCaption() {
    const { LedgerCaption } = await import('../src/components/LedgerCaption')
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    act(() => root.render(<LedgerCaption />))
  }
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('shows on the ledger page, with the lead in bold', async () => {
    openPage('base')
    await renderCaption()
    expect(text()).toBe(CAPTION)
    expect(container.querySelector('strong')?.textContent).toBe('Ledger page.')
  })

  it('shows on no other page', async () => {
    openPage('flows')
    await renderCaption()
    expect(text()).toBe('')
    openPage('fin1')
    expect(text()).toBe('')
  })
})

describe('a Finished page in the Layers panel', () => {
  beforeEach(() => {
    for (const spy of [updateFrame, deleteFrame, restackFrames, setPageFinished, getCanvas]) spy.mockClear()
    setPageFinished.mockResolvedValue({ pages: PAGES, skipped: [] })
    getCanvas.mockResolvedValue(canvasOf())
    useStore.setState({ connected: true, selectedIds: [], selectedId: null })
    openPage('fin1')
    useStore.setState({ selectedId: 'f1', selectedIds: ['f1'], selectedElement: null })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    act(() =>
      root.render(
        <TooltipProvider>
          <LayersPanel onAddFrame={() => {}} />
        </TooltipProvider>,
      ),
    )
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('does not delete on ⌫', () => {
    const tree = container.querySelector<HTMLElement>('[role="tree"]')!
    act(() => {
      tree.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true }))
    })
    expect(deleteFrame).not.toHaveBeenCalled()
  })

  it('does not move a frame by dragging its row', () => {
    dragRow('f1', 'f2')
    expect(restackFrames).not.toHaveBeenCalled()
    expect(updateFrame).not.toHaveBeenCalled()
  })

  it('offers no frame edit in the frame menu, only what reads the frame and the lock', async () => {
    await act(async () => {
      row('f1').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }))
    })
    const labels = menuItems()
    expect(labels.some((label) => label?.startsWith('Copy'))).toBe(true)
    expect(labels.some((label) => label?.startsWith('Lock'))).toBe(true)
    for (const edit of ['Delete', 'Duplicate', 'Paste', 'Rename', 'Hide', 'Mark ready']) {
      expect(labels.some((label) => label?.startsWith(edit))).toBe(false)
    }
  })

  it('keeps the lock toggle on the row and hides the eye and the new-frame button', () => {
    expect(row('f1').querySelector('button[aria-label="Lock"]')).not.toBeNull()
    expect(row('f1').querySelector('button[aria-label="Hide"]')).toBeNull()
    expect(container.querySelector('button[aria-label="New frame"]')).toBeNull()
  })

  it('still restores the page from its row in the Finished group', async () => {
    const group = [...container.querySelectorAll('button')].find((b) => b.textContent?.startsWith('Finished'))!
    await act(async () => {
      group.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    const restore = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Restore')!
    expect(isDisabled(restore)).toBe(false)
    await act(async () => {
      restore.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await settle()
    expect(setPageFinished).toHaveBeenCalledWith('c1', 'fin1', false, 'CHE-5162 · checkout')
  })

  it('lets an open page keep every edit', () => {
    act(() => {
      useStore.getState().setActivePage('flows')
      useStore.setState({ selectedId: 'o1', selectedIds: ['o1'], selectedElement: null })
    })
    expect(container.querySelector('button[aria-label="New frame"]')).not.toBeNull()
    dragRow('o1', 'o2')
    expect(restackFrames).toHaveBeenCalled()
    const tree = container.querySelector<HTMLElement>('[role="tree"]')!
    act(() => {
      tree.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true }))
    })
    expect(deleteFrame).toHaveBeenCalledTimes(1)
  })
})

describe('a page_finished refusal', () => {
  const refuse = (status: number, body: Record<string, unknown>) =>
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(body), { status })),
    )
  beforeEach(() => useStore.setState({ notice: null }))
  afterEach(() => vi.unstubAllGlobals())

  it('shows the read-only notice and still rejects', async () => {
    refuse(409, { error: 'page “CHE-5162 · checkout” is Finished. Restore the page first.', code: 'page_finished' })
    await expect(req('/api/frames/f1', { method: 'PATCH' })).rejects.toBeInstanceOf(ApiError)
    expect(useStore.getState().notice?.text).toBe('Finished pages are read only. Restore the page to edit it.')
  })

  it('stays quiet for any other refusal', async () => {
    refuse(409, { error: 'The frame changed while you were editing.' })
    await expect(req('/api/frames/f1', { method: 'PATCH' })).rejects.toBeInstanceOf(ApiError)
    expect(useStore.getState().notice).toBeNull()
  })
})
