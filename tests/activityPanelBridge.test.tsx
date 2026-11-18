// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentTask, Canvas } from '../shared/types'

/**
 * The fork's Multica chat (BridgeChat) lives in the Agents tab. An upstream
 * composer chat card switches the tab to the split layout; the bridge must stay
 * mounted through that switch, so an unsent draft survives (CHE-7205 review).
 */

vi.mock('../src/lib/api', () => ({
  api: {
    getBridge: () =>
      Promise.resolve({
        agentRef: 'a',
        agentName: 'dev-agent',
        agents: [{ ref: 'a', name: 'dev-agent' }],
        watcherSeenAt: 1,
        status: 'ok',
      }),
    putBridge: vi.fn(),
    addCanvasComment: vi.fn(),
    addCard: vi.fn(),
    agentAllowance: () => Promise.resolve({ used: 0, limit: 5, byoModel: false }),
    agentRunners: () => Promise.resolve({ runners: [] }),
  },
  ApiError: class ApiError extends Error {},
}))
vi.mock('../src/lib/posthog', () => ({ posthog: { capture: vi.fn() } }))
vi.mock('../src/lib/auth', () => ({ authClient: { useSession: () => ({ data: { user: { id: 'alice' } } }) } }))
vi.mock('../src/lib/frameClipboard', () => ({ uploadImageFrames: () => Promise.resolve([]) }))
vi.mock('../src/components/ChatPanel', () => ({ ChatPanel: () => null }))
vi.mock('../src/components/MemoryPanel', () => ({ MemoryPanel: () => null }))

const { useStore } = await import('../src/lib/store')
const { ActivityPanel } = await import('../src/components/ActivityPanel')
const { TooltipProvider } = await import('../src/components/ui/tooltip')

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const canvas = { id: 'c1', name: 'Canvas', frames: [], pages: [{ id: 'p', name: 'Page' }] } as unknown as Canvas
const chatCard = {
  id: 't1',
  agentName: '',
  color: '#000',
  status: 'make it blue',
  startedAt: 1,
  queuedBy: 'Ada',
} as AgentTask

let container: HTMLDivElement
let root: Root

const field = () => container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message to the agent"]')

beforeEach(async () => {
  Element.prototype.scrollIntoView ??= () => {}
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
  useStore.setState({ canvas, activePageId: 'p', comments: [], tasks: [], panelTab: 'tasks' })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () =>
    root.render(
      <TooltipProvider>
        <ActivityPanel canvasId="c1" onClose={() => {}} />
      </TooltipProvider>,
    ),
  )
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('Agents tab Multica chat', () => {
  it('stays mounted, with its unsent draft, when a composer chat card arrives', async () => {
    const before = field()!
    expect(before).toBeTruthy()
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(before, 'half-written note')
      before.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(field()!.value).toBe('half-written note')

    await act(async () => useStore.setState({ tasks: [chatCard] }))

    expect(field()).toBe(before) // same node: not unmounted and remounted
    expect(field()!.value).toBe('half-written note')
  })

  it('shows the Multica chat in the split layout too', async () => {
    await act(async () => useStore.setState({ tasks: [chatCard] }))
    expect(container.querySelector('section[aria-label="Chat with a Multica agent"]')).toBeTruthy()
  })
})
