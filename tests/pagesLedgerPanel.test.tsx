// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Canvas, CanvasPageInfo } from '../shared/types'

/* The A5 Pages list (CHE-9398 L7): the ledger tag, the folded Finished group, the page menu, drag limits,
   Move selection, and the PanelState rows of the approved lifecycle design
   (design/lifecycle-ui/approved/A5-project-ledger.html @ 572cc77). */

const setPageLedger = vi.fn()
const setPageFinished = vi.fn()
const setPages = vi.fn()
const getCanvas = vi.fn()
vi.mock('../src/lib/api', async (original) => {
  const actual = await original<typeof import('../src/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      setPageLedger: (...args: unknown[]) => setPageLedger(...args),
      setPageFinished: (...args: unknown[]) => setPageFinished(...args),
      setPages: (...args: unknown[]) => setPages(...args),
      getCanvas: (...args: unknown[]) => getCanvas(...args),
    },
  }
})
vi.mock('../src/lib/posthog', () => ({ posthog: { capture: vi.fn() } }))

const { ApiError } = await import('../src/lib/api')
const { useStore } = await import('../src/lib/store')
const { PagesPanel } = await import('../src/components/PagesPanel')

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
  { id: 'dir', name: 'Direction' },
  { id: 'fin1', name: 'CHE-5162 · checkout', finished: AT },
  { id: 'fin2', name: 'CHE-5101 · cart', finished: AT },
  { id: 'archive', name: 'Archive' },
]

let container: HTMLDivElement
let root: Root

const canvasWith = (pages: CanvasPageInfo[], frames: Canvas['frames'] = []) =>
  ({ id: 'c1', name: 'Canvas', frames, pages }) as unknown as Canvas
const text = () => container.textContent ?? ''
const rowIds = () => [...container.querySelectorAll<HTMLElement>('[data-page-id]')].map((el) => el.dataset.pageId)
const pageButton = (name: string) => {
  const el = [...container.querySelectorAll('button')].find((b) => b.textContent?.startsWith(name))
  if (!el) throw new Error(`button ${name} not rendered`)
  return el as HTMLButtonElement
}
const settle = () =>
  act(async () => {
    for (let i = 0; i < 12; i++) await Promise.resolve()
  })
const click = async (el: Element) => {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await settle()
}
const items = () => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
const item = (label: string) => {
  const el = items().find((candidate) => candidate.textContent?.startsWith(label))
  if (!el) throw new Error(`menu item ${label} not rendered: ${items().map((i) => i.textContent)}`)
  return el
}
const isDisabled = (el: HTMLElement) => el.hasAttribute('data-disabled') || el.getAttribute('aria-disabled') === 'true'
async function openMenu(pageId: string) {
  await act(async () => {
    container
      .querySelector(`[data-page-id="${pageId}"]`)!
      .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }))
  })
}
async function pick(pageId: string, label: string) {
  await openMenu(pageId)
  await click(item(label))
}
const unfold = () => click(pageButton('Finished'))

/* happy-dom has no layout: the row under the pointer is the one the test names */
function dragPage(from: string, onto: string, after: boolean) {
  const target = container.querySelector<HTMLElement>(`[data-page-id="${onto}"]`)!
  document.elementFromPoint = () => target
  target.getBoundingClientRect = () => ({ x: 0, y: 0, top: 0, height: 28 }) as DOMRect
  const y = after ? 26 : 2
  act(() => {
    pageButton(from).dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 0, clientY: 0 }),
    )
  })
  act(() => {
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: 10, clientY: y }))
    window.dispatchEvent(new PointerEvent('pointerup', { clientX: 10, clientY: y }))
  })
  return settle()
}

beforeEach(() => {
  setPageLedger.mockReset().mockResolvedValue({ pages: PAGES })
  setPageFinished.mockReset().mockResolvedValue({ pages: PAGES, skipped: [] })
  setPages.mockReset().mockImplementation((_id: string, pages: CanvasPageInfo[]) => Promise.resolve(pages))
  getCanvas.mockReset().mockResolvedValue(canvasWith(PAGES))
  useStore.setState({ connected: true, selectedIds: [], selectedId: null })
  useStore.getState().setCanvas(canvasWith(PAGES))
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root.render(<PagesPanel />))
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
})

describe('A5 Pages list: order, tag and the Finished group', () => {
  it('lists the ledger first with its tag, Finished folded with its count above Archive', () => {
    expect(rowIds()).toEqual(['base', 'flows', 'dir', 'archive'])
    expect(container.querySelector('[data-page-id="base"]')!.textContent).toContain('Ledger')
    expect(container.querySelector('[data-page-id="flows"]')!.textContent).not.toContain('Ledger')
    const group = pageButton('Finished')
    expect(group.textContent).toContain('2')
    expect(group.getAttribute('aria-expanded')).toBe('false')
    expect(text()).not.toContain('CHE-5162 · checkout')
    expect(text()).not.toContain('Read only. Restore to move one back.')
    /* above Archive */
    const buttons = [...container.querySelectorAll('button')]
    expect(buttons.indexOf(group)).toBeLessThan(buttons.indexOf(pageButton('Archive')))
    expect(buttons.indexOf(group)).toBeGreaterThan(buttons.indexOf(pageButton('Direction')))
  })

  it('folds and unfolds the group; rows read "Read only. Restore to move one back." with Restore', async () => {
    await unfold()
    expect(pageButton('Finished').getAttribute('aria-expanded')).toBe('true')
    expect(rowIds()).toEqual(['base', 'flows', 'dir', 'fin1', 'fin2', 'archive'])
    expect(text()).toContain('CHE-5162 · checkout')
    expect(text()).toContain('Read only. Restore to move one back.')
    expect([...container.querySelectorAll('button')].filter((b) => b.textContent === 'Restore')).toHaveLength(2)
    await unfold()
    expect(rowIds()).toEqual(['base', 'flows', 'dir', 'archive'])
  })

  it('shows no Finished group when no page is Finished', () => {
    act(() => useStore.getState().setPages(PAGES.filter((p) => !p.finished)))
    expect(text()).not.toContain('Finished')
  })

  it('updates the list from a flag-only canvas:pages broadcast', () => {
    act(() =>
      useStore.getState().setPages([
        { id: 'base', name: 'Baseline' },
        { id: 'flows', name: 'Flows', ledger: true },
        { id: 'dir', name: 'Direction' },
        { id: 'fin1', name: 'CHE-5162 · checkout', finished: AT },
        { id: 'archive', name: 'Archive' },
      ]),
    )
    expect(container.querySelector('[data-page-id="flows"]')!.textContent).toContain('Ledger')
    expect(container.querySelector('[data-page-id="base"]')!.textContent).not.toContain('Ledger')
    expect(pageButton('Finished').textContent).toContain('1')
  })
})

describe('A5 page menu', () => {
  it('sends the ledger flag from "Project ledger off" and "Project ledger on"', async () => {
    await pick('flows', 'Project ledger off')
    expect(setPageLedger).toHaveBeenCalledWith('c1', 'flows', true)
    await pick('base', 'Project ledger on')
    expect(setPageLedger).toHaveBeenLastCalledWith('c1', 'base', false)
  })

  it('sends "Move to Finished" with the name the person saw', async () => {
    await pick('flows', 'Move to Finished')
    expect(setPageFinished).toHaveBeenCalledWith('c1', 'flows', true, 'Flows')
  })

  it('sends Restore from the row and from the menu of a Finished page', async () => {
    await unfold()
    await click([...container.querySelectorAll('button')].find((b) => b.textContent === 'Restore')!)
    expect(setPageFinished).toHaveBeenLastCalledWith('c1', 'fin1', false, 'CHE-5162 · checkout')
    await pick('fin2', 'Restore')
    expect(setPageFinished).toHaveBeenLastCalledWith('c1', 'fin2', false, 'CHE-5101 · cart')
  })

  it('disables Move to Finished and Delete page on the ledger, each with its reason', async () => {
    await openMenu('base')
    const move = item('Move to Finished')
    const del = item('Delete page')
    expect(isDisabled(move)).toBe(true)
    expect(move.textContent).toContain('Not for the ledger')
    expect(isDisabled(del)).toBe(true)
    expect(del.textContent).toContain('Ledger is kept')
    await click(move)
    await click(del)
    expect(setPageFinished).not.toHaveBeenCalled()
    expect(setPages).not.toHaveBeenCalled()
  })

  it('keeps Delete page and Move to Finished live on an open page', async () => {
    await openMenu('flows')
    expect(isDisabled(item('Delete page'))).toBe(false)
    expect(item('Delete page').textContent).not.toContain('Ledger is kept')
    expect(isDisabled(item('Move to Finished'))).toBe(false)
  })
})

describe('A5 drag and Move selection', () => {
  it('refuses a drop above the ledger, accepts one below it', async () => {
    await dragPage('Direction', 'base', false)
    expect(setPages).not.toHaveBeenCalled()
    await dragPage('Direction', 'base', true)
    expect(setPages).toHaveBeenCalledTimes(1)
    expect((setPages.mock.calls[0]![1] as CanvasPageInfo[]).slice(0, 3).map((p) => p.id)).toEqual([
      'base',
      'dir',
      'flows',
    ])
  })

  it('refuses a drop into the Finished group', async () => {
    await unfold()
    await dragPage('Direction', 'fin1', false)
    await dragPage('Direction', 'fin2', true)
    expect(setPages).not.toHaveBeenCalled()
  })

  it('does not drag the ledger or a Finished page', async () => {
    await unfold()
    await dragPage('Baseline', 'dir', true)
    await dragPage('CHE-5162 · checkout', 'flows', false)
    expect(setPages).not.toHaveBeenCalled()
  })

  it('lists no Finished page in Move selection', async () => {
    const frame = {
      id: 'f1',
      canvasId: 'c1',
      name: 'F',
      pageId: 'flows',
      locked: false,
    } as unknown as Canvas['frames'][number]
    act(() => {
      useStore.getState().setCanvas(canvasWith(PAGES, [frame]))
      useStore.setState({ selectedIds: ['f1'], selectedId: 'f1' })
    })
    const trigger = container.querySelector<HTMLElement>('[role="combobox"]')!
    act(() => trigger.focus())
    act(() => {
      trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
    })
    const options = [...document.querySelectorAll('[role="option"]')].map((o) => o.textContent)
    expect(options).toContain('Baseline')
    expect(options).toContain('Direction')
    expect(options).not.toContain('CHE-5162 · checkout')
    expect(options).not.toContain('CHE-5101 · cart')
  })
})

describe('A5 states', () => {
  it('reads "Reading pages…" while the canvas is not there yet', () => {
    act(() => useStore.getState().setCanvas(null as unknown as Canvas))
    expect(text()).toContain('Reading pages…')
    expect(container.querySelector('[data-testid="panel-state-loading"]')).not.toBeNull()
  })

  it('offers "Mark Baseline as ledger" when no page is the ledger', async () => {
    const none = PAGES.map(({ ledger: _l, ...page }) => page)
    act(() => useStore.getState().setPages(none))
    expect(text()).toContain('No ledger page')
    expect(text()).toContain('Mark one page as the ledger. Approved designs land there.')
    await click(pageButton('Mark Baseline as ledger'))
    expect(setPageLedger).toHaveBeenCalledWith('c1', 'base', true)
  })

  it('names the first open page when none is called Baseline', () => {
    act(() =>
      useStore.getState().setPages([
        { id: 'a', name: 'Flows' },
        { id: 'b', name: 'Direction' },
        { id: 'archive', name: 'Archive' },
      ]),
    )
    expect(pageButton('Mark Flows as ledger')).toBeDefined()
  })

  it('shows no ledger action to a viewer', () => {
    act(() => {
      const viewer = canvasWith(
        PAGES.map(({ ledger: _l, ...page }) => page),
        [],
      )
      useStore.getState().setCanvas({ ...viewer, role: 'view' })
    })
    /* viewers never see a write button */
    expect([...container.querySelectorAll('button')].some((b) => b.textContent?.startsWith('Mark '))).toBe(false)
  })

  it('409 page_changed reads "The page changed." and Reload pages re-reads the canvas', async () => {
    setPageFinished.mockRejectedValueOnce(
      new ApiError(409, JSON.stringify({ code: 'page_changed', pages: [{ id: 'flows', name: 'Flows 2' }] })),
    )
    await pick('flows', 'Move to Finished')
    expect(text()).toContain('Could not move to Finished (409). The page changed.')
    expect(container.querySelector('[data-testid="panel-state-error"]')).not.toBeNull()
    getCanvas.mockResolvedValueOnce(
      canvasWith([...PAGES.slice(0, 1), { id: 'flows', name: 'Flows 2' }, ...PAGES.slice(2)]),
    )
    await click(pageButton('Reload pages'))
    expect(getCanvas).toHaveBeenCalledWith('c1')
    expect(text()).not.toContain('The page changed.')
    expect(useStore.getState().canvas!.pages!.find((p) => p.id === 'flows')!.name).toBe('Flows 2')
  })

  it('409 page_busy reads "A restore is running. Try again." and Try again sends it once more', async () => {
    setPageFinished.mockRejectedValueOnce(new ApiError(409, JSON.stringify({ code: 'page_busy' })))
    await pick('flows', 'Move to Finished')
    expect(text()).toContain('A restore is running. Try again.')
    await click(pageButton('Try again'))
    expect(setPageFinished).toHaveBeenCalledTimes(2)
    expect(text()).not.toContain('A restore is running.')
  })

  it('pauses page writes while disconnected', async () => {
    act(() => useStore.setState({ connected: false }))
    expect(text()).toContain('Offline. Pages are read only until it reconnects.')
    expect(text()).toContain('Reconnecting…')
    await openMenu('flows')
    expect(isDisabled(item('Move to Finished'))).toBe(true)
    expect(isDisabled(item('Project ledger off'))).toBe(true)
    await click(item('Move to Finished'))
    expect(setPageFinished).not.toHaveBeenCalled()
    await dragPage('Direction', 'base', true)
    expect(setPages).not.toHaveBeenCalled()
    /* reading keeps working */
    await click(pageButton('Direction'))
    expect(useStore.getState().activePageId).toBe('dir')
  })

  it('after a lost reply re-reads the canvas before it shows a result: the change landed', async () => {
    setPageFinished.mockRejectedValueOnce(new TypeError('fetch failed'))
    const landed = PAGES.map((p) => (p.id === 'flows' ? { ...p, finished: AT } : p))
    getCanvas.mockResolvedValueOnce(canvasWith(landed))
    await pick('flows', 'Move to Finished')
    expect(getCanvas).toHaveBeenCalledWith('c1')
    expect(text()).not.toContain('Could not')
    expect(useStore.getState().canvas!.pages!.find((p) => p.id === 'flows')!.finished).toEqual(AT)
  })

  it('after a lost reply that changed nothing, says so', async () => {
    setPageFinished.mockRejectedValueOnce(new TypeError('fetch failed'))
    await pick('flows', 'Move to Finished')
    expect(getCanvas).toHaveBeenCalledWith('c1')
    expect(text()).toContain('Could not move to Finished. No reply came back, and the page was not changed.')
  })

  it('after a lost reply it cannot re-read, says the page may have changed', async () => {
    setPageFinished.mockRejectedValueOnce(new TypeError('fetch failed'))
    getCanvas.mockRejectedValueOnce(new TypeError('fetch failed'))
    await pick('flows', 'Move to Finished')
    expect(text()).toContain('Could not move to Finished. No reply came back. Reload pages to see where it stands.')
    expect(pageButton('Reload pages')).toBeDefined()
  })
})
