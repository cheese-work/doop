// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Canvas, Frame } from '../shared/types'

const mocks = vi.hoisted(() => {
  class MockApiError extends Error {
    status: number
    body: Record<string, unknown>
    constructor(status: number, text: string) {
      super(`${status} ${text}`)
      this.status = status
      this.body = JSON.parse(text)
    }
  }
  return {
    MockApiError,
    archiveFrames: vi.fn(),
    unarchiveFrame: vi.fn(),
    canvasTrash: vi.fn(),
    getCanvas: vi.fn(),
    restoreFrame: vi.fn(),
    deleteFrame: vi.fn(),
  }
})
vi.mock('../src/lib/api', () => ({
  ApiError: mocks.MockApiError,
  api: {
    canvasLibrary: () => new Promise(() => {}),
    archiveFrames: mocks.archiveFrames,
    unarchiveFrame: mocks.unarchiveFrame,
    canvasTrash: mocks.canvasTrash,
    getCanvas: mocks.getCanvas,
    restoreFrame: mocks.restoreFrame,
    deleteFrame: mocks.deleteFrame,
  },
  errorMessage: (_err: unknown, fallback: string) => fallback,
}))
vi.mock('../src/lib/posthog', () => ({ posthog: { capture: vi.fn() } }))
vi.mock('../src/lib/frameBridge', () => ({ requestFrame: vi.fn(async () => null) }))

const { useStore } = await import('../src/lib/store')
const { PagesPanel } = await import('../src/components/PagesPanel')
const { ArchiveTrashPanel } = await import('../src/components/ArchiveTrashPanel')
const { TooltipProvider } = await import('../src/components/ui/tooltip')

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const pages = [
  { id: 'archive', name: 'Archive' },
  { id: 'p1', name: 'Home' },
  { id: 'p2', name: 'Pricing' },
]
const base: Frame = {
  id: 'f1',
  canvasId: 'c1',
  name: 'Hero',
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  html: '<p>A</p>',
  createdAt: 0,
  updatedAt: 1,
  updatedBy: 'Ana',
}
const archived: Frame = {
  ...base,
  pageId: 'archive',
  archiveOrigin: { pageId: 'p1', hidden: false, archivedAt: 5, by: 'Ana' },
}
const live: Frame = { ...base, pageId: 'p1' }
const canvasWith = (frames: Frame[]) => ({ id: 'c1', name: 'C', pages, frames, role: 'edit' }) as unknown as Canvas
const trashed: Frame = {
  ...base,
  id: 't1',
  name: 'Old card',
  pageId: 'p1',
  deletedAt: Date.UTC(2026, 10, 27, 3, 0),
  updatedBy: 'Ben',
}

let container: HTMLDivElement
let root: Root

async function flush() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}
async function mount(node: React.ReactNode) {
  await act(async () => {
    root.render(<TooltipProvider>{node}</TooltipProvider>)
  })
  await flush()
}
function button(label: string | RegExp): HTMLElement {
  const el = [...document.body.querySelectorAll<HTMLElement>('button, [role="option"]')].find((b) => {
    const name = b.getAttribute('aria-label') ?? b.textContent ?? ''
    return typeof label === 'string' ? name.trim() === label : label.test(name)
  })
  if (!el) throw new Error(`no control "${String(label)}" in: ${container.textContent}`)
  return el
}
async function click(el: HTMLElement) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await flush()
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.canvasTrash.mockResolvedValue({ frames: [], pages: [] })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  useStore.setState({ connected: true, selectedIds: [], activePageId: 'p1' })
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('Archive and Trash (U2)', () => {
  it('lists the Archive page last, with its count', async () => {
    useStore.getState().setCanvas(canvasWith([archived, { ...archived, id: 'f2' }]))
    await mount(<PagesPanel />)
    const ids = [...container.querySelectorAll<HTMLElement>('[data-page-id]')].map((el) => el.dataset.pageId)
    expect(ids).toEqual(['p1', 'p2', 'archive'])
    expect(container.querySelector('[data-page-id="archive"] [data-testid="archive-count"]')?.textContent).toBe('2')
  })

  it('Undo on the archive toast calls unarchive to the origin', async () => {
    useStore.getState().setCanvas(canvasWith([live]))
    useStore.setState({ selectedIds: ['f1'] })
    mocks.archiveFrames.mockResolvedValue({ pages, frames: [archived] })
    mocks.unarchiveFrame.mockResolvedValue({ frame: live, changed: true })
    await mount(<ArchiveTrashPanel />)
    await click(button('Archive selected'))
    expect(mocks.archiveFrames).toHaveBeenCalledWith('c1', ['f1'])
    await click(button('Undo'))
    expect(mocks.unarchiveFrame).toHaveBeenCalledWith('f1', undefined)
  })

  it('the archive toast renders on the page, outside the Layers panel, so no panel can cover it', async () => {
    useStore.getState().setCanvas(canvasWith([live]))
    useStore.setState({ selectedIds: ['f1'] })
    mocks.archiveFrames.mockResolvedValue({ pages, frames: [archived] })
    await mount(<ArchiveTrashPanel />)
    await click(button('Archive selected'))
    const toast = document.body.querySelector('[data-slot="toast"]')
    expect(toast).not.toBeNull()
    expect(container.contains(toast)).toBe(false)
    // an open phone sheet makes the body inert; the toast must still take taps
    expect(toast?.className).toMatch(/pointer-events-auto/)
  })

  it('Undo on the archive toast is disabled while offline and sends no write', async () => {
    useStore.getState().setCanvas(canvasWith([live]))
    useStore.setState({ selectedIds: ['f1'] })
    mocks.archiveFrames.mockResolvedValue({ pages, frames: [archived] })
    await mount(<ArchiveTrashPanel />)
    await click(button('Archive selected'))
    act(() => useStore.setState({ connected: false }))
    const undo = button('Undo') as HTMLButtonElement
    expect(undo.disabled).toBe(true)
    await click(undo)
    expect(mocks.unarchiveFrame).not.toHaveBeenCalled()
  })

  it('Restore to a chosen page sends that pageId', async () => {
    useStore.getState().setCanvas(canvasWith([archived]))
    mocks.unarchiveFrame.mockResolvedValue({ frame: { ...live, pageId: 'p2' }, changed: true })
    await mount(<ArchiveTrashPanel />)
    await click(button('Restore to page…'))
    await click(button('Pricing'))
    expect(mocks.unarchiveFrame).toHaveBeenCalledWith('f1', 'p2')
  })

  it('opens the page picker when the origin page is gone (409 origin_missing)', async () => {
    useStore.getState().setCanvas(canvasWith([archived]))
    mocks.unarchiveFrame.mockRejectedValue(new mocks.MockApiError(409, JSON.stringify({ code: 'origin_missing' })))
    await mount(<ArchiveTrashPanel />)
    await click(button('Restore to Home'))
    expect(container.querySelector('[role="listbox"]')).not.toBeNull()
    expect(button('Pricing')).toBeTruthy()
  })

  it('a reply lost before commit: re-fetches, and the row stays', async () => {
    useStore.getState().setCanvas(canvasWith([archived]))
    mocks.unarchiveFrame.mockRejectedValue(new TypeError('Failed to fetch'))
    mocks.getCanvas.mockResolvedValue(canvasWith([archived]))
    await mount(<ArchiveTrashPanel />)
    const trashCalls = mocks.canvasTrash.mock.calls.length
    await click(button('Restore to Home'))
    expect(mocks.canvasTrash.mock.calls.length).toBe(trashCalls + 1)
    expect(mocks.getCanvas).toHaveBeenCalledWith('c1')
    expect(container.querySelector('[data-archive-row="f1"]')).not.toBeNull()
    expect(container.textContent).not.toMatch(/Restored to/)
  })

  it('a reply lost after commit: re-fetches and shows the restored state', async () => {
    useStore.getState().setCanvas(canvasWith([archived]))
    mocks.unarchiveFrame.mockRejectedValue(new TypeError('Failed to fetch'))
    mocks.getCanvas.mockResolvedValue(canvasWith([live]))
    await mount(<ArchiveTrashPanel />)
    await click(button('Restore to Home'))
    expect(mocks.getCanvas).toHaveBeenCalledWith('c1')
    expect(container.querySelector('[data-archive-row="f1"]')).toBeNull()
    expect(container.textContent).toMatch(/Restored “Hero” to Home/)
  })

  it('Trash shows when, never claims a deleter it does not have, restores, and never offers Delete forever', async () => {
    useStore.getState().setCanvas(canvasWith([archived]))
    mocks.canvasTrash.mockResolvedValue({ frames: [trashed], pages: [] })
    mocks.restoreFrame.mockResolvedValue({ ...trashed, deletedAt: undefined })
    await mount(<ArchiveTrashPanel />)
    const row = container.querySelector('[data-trash-row="t1"]')
    expect(row?.textContent).toMatch(/Deleted · Nov 27, 2026/)
    expect(container.textContent).not.toMatch(/Deleted by/)
    expect(container.textContent).not.toMatch(/delete forever/i)
    await click(button('Restore Old card'))
    expect(mocks.restoreFrame).toHaveBeenCalledWith('t1')
    act(() => useStore.setState({ connected: false }))
    expect(container.textContent).not.toMatch(/delete forever/i)
    const offlineRestore = container.querySelector<HTMLButtonElement>('[aria-label="Restore Old card"]')
    expect(offlineRestore === null || offlineRestore.disabled).toBe(true)
  })

  it('Trash names the deleter only when the server sends deletedBy', async () => {
    useStore.getState().setCanvas(canvasWith([archived]))
    mocks.canvasTrash.mockResolvedValue({ frames: [{ ...trashed, deletedBy: 'Cara' }], pages: [] })
    await mount(<ArchiveTrashPanel />)
    expect(container.textContent).toMatch(/Deleted by Cara · Nov 27, 2026/)
    expect(container.textContent).not.toMatch(/Ben/)
  })

  it('Archive row actions are compact icon buttons with names and phone-size targets', async () => {
    useStore.getState().setCanvas(canvasWith([archived]))
    await mount(<ArchiveTrashPanel />)
    const row = container.querySelector('[data-archive-row="f1"]') as HTMLElement
    const actions = [...row.querySelectorAll<HTMLButtonElement>('button')]
    expect(actions.map((b) => b.getAttribute('aria-label'))).toEqual([
      'Restore to Home',
      'Restore to page…',
      'Move to Trash',
    ])
    for (const b of actions) {
      expect(b.textContent?.trim()).toBe('')
      expect(b.className).toMatch(/max-md:size-11/)
    }
  })
})
