// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

vi.mock('../src/lib/posthog', () => ({ posthog: { capture: vi.fn() } }))

const { PanelState } = await import('../src/components/PanelState')
const { useStore } = await import('../src/lib/store')

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/* The state rows of the approved lifecycle design (design/lifecycle-ui/approved @ 572cc77):
   A1 frame lock, A2 Archive and Trash, A4 comment resolution. */
const LOCK = {
  loading: 'Reading lock state…',
  empty: {
    title: 'No locked frames',
    hint: 'Lock a frame to keep it from edits. Right-click a frame, or press Cmd+Shift+L.',
  },
  error: 'Could not unlock Cart · phone (403). It is still locked.',
  offline: 'Offline. Lock and unlock are paused. Locked frames stay locked.',
}
const TRASH = {
  loading: 'Reading Archive and Trash…',
  empty: { title: 'Nothing archived', hint: 'Archive a frame to hide it from every page without deleting it.' },
  error: 'Could not restore Cart · v0 (500). It is still in Trash.',
  offline: 'Offline. Restore and delete forever are paused.',
}
const THREADS = {
  loading: 'Reading threads…',
  empty: { title: 'No comments yet', hint: 'Press C, click a frame and write one. Resolved threads show here too.' },
  error: 'Could not resolve (500). The thread is still open.',
  offline: 'Offline. Reading works. Resolve is paused.',
}
const SCREENS = { A1: LOCK, A2: TRASH, A4: THREADS }

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  useStore.setState({ connected: true })
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const text = () => container.textContent ?? ''
const button = (label: string) =>
  Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes(label)) as HTMLButtonElement

it.each(Object.entries(SCREENS))('%s: loading renders the lock text', (_screen, copy) => {
  act(() => root.render(<PanelState status="loading" loadingLabel={copy.loading} />))
  expect(text()).toContain(copy.loading)
  expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0)
})

it.each(Object.entries(SCREENS))('%s: empty renders the lock title and hint', (_screen, copy) => {
  act(() => root.render(<PanelState status="empty" empty={copy.empty} />))
  expect(text()).toContain(copy.empty.title)
  expect(text()).toContain(copy.empty.hint)
})

it.each(Object.entries(SCREENS))('%s: error renders the lock text as an alert with Try again', (_screen, copy) => {
  const retry = vi.fn()
  act(() => root.render(<PanelState status="error" error={copy.error} onRetry={retry} />))
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(copy.error)
  act(() => button('Try again').click())
  expect(retry).toHaveBeenCalledOnce()
})

it.each(Object.entries(SCREENS))('%s: disconnected renders the lock text and the reconnect line', (_screen, copy) => {
  useStore.setState({ connected: false })
  act(() => root.render(<PanelState status="ready" offline={copy.offline} />))
  expect(container.querySelector('[role="status"]')?.textContent).toContain(copy.offline)
  expect(text()).toContain('Reconnecting…')
})

it('shows no offline banner while connected', () => {
  act(() => root.render(<PanelState status="ready" offline={LOCK.offline} />))
  expect(text()).not.toContain(LOCK.offline)
  expect(text()).not.toContain('Reconnecting')
})

it('renders its children when ready', () => {
  act(() => root.render(<PanelState status="ready">thread list</PanelState>))
  expect(text()).toContain('thread list')
})

it('keeps children readable while disconnected', () => {
  useStore.setState({ connected: false })
  act(() =>
    root.render(
      <PanelState status="ready" offline={THREADS.offline}>
        thread list
      </PanelState>,
    ),
  )
  expect(text()).toContain('thread list')
})

it('disables the empty action and Try again when connected=false, enables them when connected', () => {
  const lock = vi.fn()
  const retry = vi.fn()
  const view = (status: 'empty' | 'error') => (
    <PanelState
      status={status}
      empty={{ ...LOCK.empty, action: { label: 'Lock frame', onClick: lock } }}
      error={LOCK.error}
      onRetry={retry}
      offline={LOCK.offline}
    />
  )
  act(() => root.render(view('empty')))
  expect(button('Lock frame').disabled).toBe(false)
  act(() => button('Lock frame').click())
  expect(lock).toHaveBeenCalledOnce()

  act(() => useStore.setState({ connected: false }))
  expect(button('Lock frame').disabled).toBe(true)
  act(() => button('Lock frame').click())
  expect(lock).toHaveBeenCalledOnce()

  act(() => root.render(view('error')))
  expect(button('Try again').disabled).toBe(true)
  act(() => button('Try again').click())
  expect(retry).not.toHaveBeenCalled()

  act(() => useStore.setState({ connected: true }))
  expect(button('Try again').disabled).toBe(false)
})
