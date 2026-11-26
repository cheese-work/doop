// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Canvas, ElementComment } from '../shared/types'

vi.mock('../src/lib/posthog', () => ({ posthog: { capture: vi.fn() } }))
vi.mock('../src/components/TeamAllowance', () => ({ isResidentLimit: () => false }))
vi.mock('../src/lib/auth', () => ({ authClient: { useSession: () => ({ data: { user: { id: 'u1' } } }) } }))

const { CommentsPanel } = await import('../src/components/CommentsPanel')
const { useStore } = await import('../src/lib/store')
const { api, ApiError } = await import('../src/lib/api')

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/* U4 comment resolution (CHE-9308 step 8): the Comments tab of the approved
   design A4 (design/lifecycle-ui/approved/A4-comment-resolution.html @ 572cc77). */

const ANCHOR_KEY = 'doop:reviewed:u1:c'

let container: HTMLDivElement
let root: Root
let resolve: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  localStorage.clear()
  resolve = vi.spyOn(api, 'resolveComment').mockResolvedValue({})
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

const base = (over: Partial<ElementComment> & { id: string }): ElementComment => ({
  canvasId: 'c',
  from: 'Cheese',
  text: `Thread ${over.id}`,
  at: 10,
  snippet: '',
  frameId: 'f',
  x: 1,
  y: 2,
  ...over,
})

function show(comments: ElementComment[], connected = true) {
  useStore.setState({
    connected,
    canvas: { id: 'c', pages: [{ id: 'p', name: 'Page' }], frames: [{ id: 'f', pageId: 'p', name: 'Cart' }] } as Canvas,
    activePageId: 'p',
    comments,
  })
  act(() => root.render(<CommentsPanel />))
}

const text = () => document.body.textContent ?? ''
const button = (label: string | RegExp, scope: ParentNode = document.body) =>
  [...scope.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
    typeof label === 'string' ? b.textContent?.trim() === label : label.test(b.textContent ?? ''),
  )
const click = (el: Element | undefined) => {
  expect(el).toBeDefined()
  act(() => (el as HTMLElement).click())
}
function type(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype
  act(() => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const field = () => document.body.querySelector<HTMLInputElement>('[data-slot="modal"] input')!

function pick(reason: string) {
  act(() =>
    button('Resolve')!.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }),
    ),
  )
  click(document.body.querySelector(`[role="menuitem"][data-reason="${reason}"]`) ?? undefined)
}

it.each([
  ['addressed', 'CHE-5162 v8', { reason: 'addressed', ref: 'CHE-5162 v8' }],
  ['moved', 'CHE-5319', { reason: 'moved', ref: 'CHE-5319' }],
  ['wont_fix', 'Works as designed', { reason: 'wont_fix', note: 'Works as designed' }],
])('posts the %s reason with its body', async (reason, value, body) => {
  show([base({ id: 'root' })])
  pick(reason)
  type(field(), value)
  await act(async () => button('Resolve', document.body.querySelector('[data-slot="modal"]')!)!.click())
  expect(resolve).toHaveBeenCalledExactlyOnceWith('root', body)
})

it("won't fix needs a note: the dialog's Resolve stays off until a one-line reason is typed", () => {
  show([base({ id: 'root' })])
  pick('wont_fix')
  const modal = document.body.querySelector('[data-slot="modal"]')!
  expect(modal.textContent).toContain("Resolve as Won't fix")
  expect(modal.textContent).toContain('Why? One line, shown on the thread.')
  expect(button('Resolve', modal)!.disabled).toBe(true)
  type(field(), '   ')
  expect(button('Resolve', modal)!.disabled).toBe(true)
  click(button('Resolve', modal))
  expect(resolve).not.toHaveBeenCalled()
  type(field(), 'Works as designed')
  expect(button('Resolve', modal)!.disabled).toBe(false)
})

it('keeps a q: thread open with the Multica link and offers no Resolve', () => {
  show([
    base({ id: 'root', text: 'Which payment methods can we ship by launch?' }),
    base({ id: 'ask', parentId: 'root', clientRequestId: 'q:CHE-5301', at: 11 }),
  ])
  expect(text()).toContain('Open · waits on Multica')
  expect(text()).toContain('Question on CHE-5301')
  expect(text()).toContain('Thread stays open until it is answered there.')
  expect([...container.querySelectorAll('a, [data-slot="issue-link"]')].map((a) => a.textContent)).toContain('CHE-5301')
  expect(button('Resolve')).toBeUndefined()
  expect(button(/^Open\s*1/)).toBeDefined()
})

it('draws the reason chip and its detail on a resolved thread', () => {
  show([
    base({ id: 'a', resolvedAt: 100, resolvedBy: 'Bob', resolution: 'addressed', resolutionRef: 'CHE-5162 v7' }),
    base({ id: 'm', resolvedAt: 100, resolvedBy: 'Bob', resolution: 'moved', resolutionRef: 'CHE-5319' }),
    base({ id: 'w', resolvedAt: 100, resolvedBy: 'Bob', resolution: 'wont_fix', resolutionNote: 'Works as designed' }),
  ])
  click(button(/^Resolved/))
  expect(text()).toContain('Addressed')
  expect(text()).toContain('in CHE-5162 v7')
  expect(text()).toContain('Moved to Multica')
  expect(text()).toContain('CHE-5319')
  expect(text()).toContain("Won't fix")
  expect(text()).toContain('Works as designed')
})

it('counts the summary from the fixture since the stored anchor, and Mark reviewed moves the anchor', () => {
  localStorage.setItem(ANCHOR_KEY, '1000')
  show([
    base({ id: 'a', resolvedAt: 2000, resolution: 'addressed', resolutionRef: 'v3' }),
    base({ id: 'm', resolvedAt: 3000, resolution: 'moved', resolutionRef: 'CHE-9' }),
    base({ id: 'old', resolvedAt: 500, resolution: 'wont_fix', resolutionNote: 'n' }),
    base({ id: 'open' }),
    base({ id: 'wait' }),
    base({ id: 'ask', parentId: 'wait', clientRequestId: 'q:CHE-5301', at: 11 }),
  ])
  expect(text()).toContain('Since last review')
  expect(text()).toContain('2 resolved · 1 addressed, 1 moved to Multica')
  expect(text()).toContain('2 still open · 1 waits on a Multica question')

  const before = Date.now()
  click(button('Mark reviewed'))
  expect(Number(localStorage.getItem(ANCHOR_KEY))).toBeGreaterThanOrEqual(before)
  expect(text()).toContain('0 resolved')
  expect(text()).toContain('2 still open · 1 waits on a Multica question')
})

it('keeps the anchor per user and canvas', () => {
  localStorage.setItem('doop:reviewed:u2:c', '1000')
  localStorage.setItem('doop:reviewed:u1:other', '1000')
  show([base({ id: 'a', resolvedAt: 2000, resolution: 'addressed', resolutionRef: 'v3' })])
  /* no anchor of this user on this canvas: every resolution counts */
  expect(text()).toContain('1 resolved · 1 addressed')
})

it('renders no "Suggested" hint, even for an e: reply that names a version', () => {
  show([
    base({ id: 'root', text: 'Total is hidden under the keyboard.' }),
    base({ id: 'fix', parentId: 'root', clientRequestId: 'e:CHE-5162', text: 'Fixed in CHE-5162 v8', at: 11 }),
  ])
  expect(button('Resolve')).toBeDefined()
  expect(text()).not.toContain('Suggested')
})

it('says so when nothing is commented yet, and while the canvas is loading', () => {
  show([])
  expect(text()).toContain('No comments yet')
  expect(text()).toContain('Press C, click a frame and write one. Resolved threads show here too.')
  useStore.setState({ canvas: null })
  act(() => root.render(<CommentsPanel />))
  expect(text()).toContain('Reading threads…')
})

it('pauses Resolve and says so while offline, with threads still readable', () => {
  show([base({ id: 'root', text: 'Make the promo field optional.' })], false)
  expect(text()).toContain('Offline. Reading works. Resolve is paused.')
  expect(text()).toContain('Reconnecting…')
  expect(text()).toContain('Make the promo field optional.')
  expect(button('Resolve')!.disabled).toBe(true)
})

it('shows the error with Try again when a resolve fails, and the thread stays open', async () => {
  resolve.mockRejectedValueOnce(new ApiError(500, 'boom')).mockResolvedValueOnce({})
  show([base({ id: 'root' })])
  pick('addressed')
  type(field(), 'v3')
  await act(async () => button('Resolve', document.body.querySelector('[data-slot="modal"]')!)!.click())
  expect(text()).toContain('Could not resolve (500). The thread is still open.')
  expect(text()).toContain('Thread root')
  await act(async () => button('Try again')!.click())
  expect(resolve).toHaveBeenCalledTimes(2)
  expect(resolve).toHaveBeenLastCalledWith('root', { reason: 'addressed', ref: 'v3' })
  expect(text()).not.toContain('Could not resolve')
})
