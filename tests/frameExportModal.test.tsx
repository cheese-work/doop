// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Frame } from '../shared/types'
import { FrameContextMenu } from '../src/components/FrameContextMenu'
import { ContextMenu, ContextMenuTrigger } from '../src/components/ui/context-menu'

import { figmaApi } from '../src/integrations/figma/api'
import { useStore } from '../src/lib/store'

vi.mock('../src/integrations/figma/api', () => ({ figmaApi: { exportFrames: vi.fn() } }))
vi.mock('../src/lib/posthog', () => ({ posthog: { capture: vi.fn() } }))
const integrations = vi.hoisted(() => vi.fn())
vi.mock('../src/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/api')>()
  return { ...actual, api: { ...actual.api, integrations } }
})

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const frame: Frame = {
  id: 'export-frame',
  canvasId: 'canvas',
  name: 'Poster',
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  html: '',
  createdAt: 0,
  updatedAt: 0,
  updatedBy: 'me',
}
let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.clearAllMocks()
  useStore.setState({
    canvas: {
      id: 'canvas',
      name: 'Test',
      createdAt: 0,
      updatedAt: 0,
      frames: [frame, { ...frame, id: 'other', name: 'Other' }],
    },
    selectedIds: [],
  })
  vi.mocked(figmaApi.exportFrames).mockImplementation(async (_canvasId, ids) => ({
    format: 'doop-figma',
    version: 1,
    name: 'Test',
    warnings: [],
    assets: {},
    frames: ids.map((id) => ({ id, name: id, width: 100, height: 100, nodes: [] })),
  }))
  integrations.mockResolvedValue({ canva: { enabled: true, connected: false } })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

async function openFrameMenu(): Promise<Element> {
  await act(async () => {
    root.render(
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <button>Frame</button>
        </ContextMenuTrigger>
        <FrameContextMenu frame={frame} at={{ current: { x: 0, y: 0 } }} />
      </ContextMenu>,
    )
  })
  await act(async () => {
    container
      .querySelector('button')!
      .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }))
  })
  return document.querySelector('[role="menu"]')!
}

async function openExportDialog(): Promise<Element> {
  const menu = await openFrameMenu()
  const exportItem = Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(
    (item) => item.textContent === 'Export…',
  )!
  await act(async () => {
    exportItem.click()
  })
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30))
  })
  return document.querySelector('[role="dialog"]')!
}

function buttonNamed(root: Element, name: string): HTMLButtonElement | undefined {
  return Array.from(root.querySelectorAll('button')).find((b) => b.textContent === name)!
}

it('keeps Copy image URL in the frame menu, not the export dialog', async () => {
  const menu = await openFrameMenu()
  expect(menu.textContent).toContain('Copy image URL')
  expect(menu.textContent).toContain('Export…')
  expect(menu.textContent).not.toContain('Download PNG')
})

it('hands focus from the frame menu to a persistent export dialog and dismisses with Escape', async () => {
  const dialog = await openExportDialog()

  expect(document.querySelector('[role="menu"]')).toBeNull()
  expect(dialog.textContent).toContain('Export “Poster”')
  expect(dialog.contains(document.activeElement)).toBe(true)
  expect(dialog.textContent).toContain('Download PNG')
  expect(dialog.textContent).toContain('Download JPG')
  expect(dialog.textContent).toContain('Download PSD')
  expect(dialog.textContent).toContain('Download PDF')
  expect(dialog.textContent).not.toContain('Copy image URL')
  await act(async () => {
    document.activeElement!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    )
  })
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  expect(document.body.style.pointerEvents).not.toBe('none')
})

it('grays out Export to Canva and points to Integrations until Canva is connected', async () => {
  const dialog = await openExportDialog()
  expect(buttonNamed(dialog, 'Export to Canva')).toBeUndefined()
  const canvaRow = dialog.querySelector('[aria-disabled]')!
  expect(canvaRow.textContent).toContain('Export to Canva')
  expect(canvaRow.textContent).toContain('Connect Canva in the Integrations tab first.')
  expect(buttonNamed(canvaRow, 'Integrations')).toBeDefined()
})

it('enables Export to Canva once Canva is connected', async () => {
  integrations.mockResolvedValue({ canva: { enabled: true, connected: true } })
  const dialog = await openExportDialog()
  expect(buttonNamed(dialog, 'Export to Canva')?.disabled).toBe(false)
  expect(dialog.textContent).not.toContain('Connect Canva')
})

it.each([
  { selected: [frame.id], expected: [frame.id] },
  { selected: [frame.id, 'other'], expected: [frame.id, 'other'] },
  { selected: ['other'], expected: [frame.id] },
])(
  'hands the selection $selected to Figma without leaving a second dialog or focus trap',
  async ({ selected, expected }) => {
    useStore.setState({ selectedIds: selected })
    const dialog = await openExportDialog()
    const send = Array.from(dialog.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('to Figma'),
    )!
    expect(send.textContent).toBe(expected.length > 1 ? `Send ${expected.length} frames to Figma…` : 'Send to Figma…')
    // The chooser keeps the selection from when Export was opened.
    act(() => useStore.setState({ selectedIds: [] }))
    await act(async () => {
      send.click()
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30))
    })
    expect(figmaApi.exportFrames).toHaveBeenCalledExactlyOnceWith('canvas', expected, expect.any(AbortSignal))
    const dialogs = document.querySelectorAll('[role="dialog"]')
    expect(dialogs).toHaveLength(1)
    expect(dialogs[0]!.textContent).toContain('Copy for Figma')
    expect(dialogs[0]!.contains(document.activeElement)).toBe(true)
    await act(async () => {
      document.activeElement!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      )
    })
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(document.body.style.pointerEvents).not.toBe('none')
  },
)

it('offers the whole selection as one PDF', async () => {
  useStore.setState({ selectedIds: [frame.id, 'other'] })
  const dialog = await openExportDialog()
  expect(dialog.textContent).toContain('Download PDF of 2 frames')
  expect(dialog.textContent).toContain('One vector page per frame')
})
