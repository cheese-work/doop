// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BridgeInfo, BridgeStatus } from '../shared/bridge'
import type { Canvas, ElementComment } from '../shared/types'

vi.mock('../src/lib/posthog', () => ({ posthog: { capture: vi.fn() } }))
vi.mock('../src/components/TeamAllowance', () => ({ isResidentLimit: () => false }))
vi.mock('../src/lib/api', () => ({
  api: { getBridge: vi.fn(), putBridge: vi.fn(), addCanvasComment: vi.fn() },
}))

const { api } = await import('../src/lib/api')
const { BridgeChat } = await import('../src/components/BridgeChat')
const { chatThread } = await import('../src/lib/bridgeChat')
const { useStore } = await import('../src/lib/store')

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const AGENTS = [
  { ref: 'dev', name: 'Dev Agent' },
  { ref: 'review', name: 'Review Agent' },
]

function bridge(status: BridgeStatus, over: Partial<BridgeInfo> = {}): BridgeInfo {
  return { agentRef: 'dev', agentName: 'Dev Agent', agents: AGENTS, watcherSeenAt: 1, status, ...over }
}

function comment(over: Partial<ElementComment> & Pick<ElementComment, 'id' | 'text' | 'at'>): ElementComment {
  return { canvasId: 'c', selector: '', snippet: '', pageId: 'p', x: 0, y: 0, from: 'Ada', ...over }
}

let container: HTMLDivElement
let root: Root

async function mount(info: BridgeInfo | Error) {
  vi.mocked(api.getBridge).mockImplementation(() =>
    info instanceof Error ? Promise.reject(info) : Promise.resolve(info),
  )
  await act(async () => root.render(<BridgeChat canvasId="c" />))
}

const banner = () => container.querySelector('[role="alert"]')?.textContent ?? null
const sendButton = () => container.querySelector<HTMLButtonElement>('button[aria-label="Send to agent"]')!
const field = () => container.querySelector<HTMLTextAreaElement>('textarea')!

function type(el: HTMLTextAreaElement, value: string) {
  const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
  act(() => {
    set.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  Element.prototype.scrollIntoView ??= () => {}
  vi.mocked(api.getBridge).mockReset()
  vi.mocked(api.putBridge).mockReset()
  vi.mocked(api.addCanvasComment).mockReset().mockResolvedValue({})
  useStore.setState({
    canvas: { id: 'c', pages: [{ id: 'p', name: 'Page' }], frames: [] } as unknown as Canvas,
    activePageId: 'p',
    comments: [],
  })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('agent picker', () => {
  it('shows the saved choice after a reload', async () => {
    await mount(bridge('ok'))
    expect(container.querySelector('[role="combobox"]')!.textContent).toContain('Dev Agent')
  })

  it('lists the published agents and saves the picked one', async () => {
    await mount(bridge('ok'))
    vi.mocked(api.putBridge).mockResolvedValue(bridge('ok', { agentRef: 'review', agentName: 'Review Agent' }))
    const trigger = container.querySelector<HTMLButtonElement>('[role="combobox"]')!
    act(() => trigger.focus())
    act(() => {
      trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
    })
    const options = [...document.querySelectorAll('[role="option"]')]
    expect(options.map((o) => o.textContent)).toEqual(['Dev Agent', 'Review Agent'])
    await act(async () => {
      options[1]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    })
    expect(api.putBridge).toHaveBeenCalledWith('c', 'review')
    expect(container.querySelector('[role="combobox"]')!.textContent).toContain('Review Agent')
  })
})

describe('status banners', () => {
  it('shows none and allows sending when the bridge is ok', async () => {
    await mount(bridge('ok'))
    expect(banner()).toBeNull()
    type(field(), 'hello')
    expect(sendButton().disabled).toBe(false)
  })

  it('asks for an agent when none is selected, and blocks sending', async () => {
    await mount(bridge('no_agent_selected', { agentRef: null, agentName: null }))
    expect(banner()).toContain('Pick an agent')
    type(field(), 'hello')
    expect(sendButton().disabled).toBe(true)
  })

  it('names the missing agent for agent_not_found, and blocks sending', async () => {
    await mount(bridge('agent_not_found', { agentRef: 'gone', agentName: 'Gone Agent' }))
    expect(banner()).toContain('Gone Agent')
    expect(banner()).toContain('not in the live Multica agent list')
    type(field(), 'hello')
    expect(sendButton().disabled).toBe(true)
  })

  it('says Multica is unreachable for watcher_unreachable, and blocks sending', async () => {
    await mount(bridge('watcher_unreachable'))
    expect(banner()).toContain('Multica is unreachable')
    expect(banner()).toContain('2 minutes')
    type(field(), 'hello')
    expect(sendButton().disabled).toBe(true)
  })

  it('says the bridge could not be read when the request fails, and blocks sending', async () => {
    await mount(new Error('boom'))
    expect(banner()).toContain('Could not read the chat bridge')
    type(field(), 'hello')
    expect(sendButton().disabled).toBe(true)
  })

  it('shows issue_not_linked when the watcher answered with that failure', async () => {
    useStore.setState({
      comments: [
        comment({ id: 'r', text: '@dev ship it', at: 1 }),
        comment({ id: 'f', parentId: 'r', from: 'Watcher', text: '[dsg:issue_not_linked] No issue is linked.', at: 2 }),
      ],
    })
    await mount(bridge('ok'))
    expect(banner()).toContain('not linked to a Multica issue')
  })

  it('drops the issue_not_linked banner once a newer message is sent', async () => {
    useStore.setState({
      comments: [
        comment({ id: 'r', text: '@dev ship it', at: 1 }),
        comment({ id: 'f', parentId: 'r', from: 'Watcher', text: '[dsg:issue_not_linked] No issue is linked.', at: 2 }),
        comment({ id: 'r2', text: '@dev again', at: 3 }),
      ],
    })
    await mount(bridge('ok'))
    expect(banner()).toBeNull()
  })
})

describe('chat thread', () => {
  it('shows messages to the agent and its replies in order, without the markers', async () => {
    useStore.setState({
      comments: [
        comment({ id: 'a2', parentId: 'a', from: 'Dev Agent', text: '[dsg:7] Done.', at: 4 }),
        comment({ id: 'other', text: '@review look', at: 3 }),
        comment({ id: 'b', text: 'no mention', at: 2 }),
        comment({ id: 'a', text: '@dev please start', at: 1 }),
      ],
    })
    await mount(bridge('ok'))
    const rows = [...container.querySelectorAll('[data-slot="chat-line"]')].map((el) => el.textContent)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toContain('please start')
    expect(rows[0]).not.toContain('@dev')
    expect(rows[1]).toContain('Done.')
    expect(rows[1]).not.toContain('[dsg:')
  })

  it('does not match a longer handle that starts with the same letters', () => {
    const lines = chatThread(
      [comment({ id: 'x', text: '@dev-two hi', at: 1 }), comment({ id: 'y', text: '@Dev hi', at: 2 })],
      'dev',
    )
    expect(lines.map((l) => l.id)).toEqual(['y'])
  })
})

describe('sending', () => {
  it('posts a canvas comment that starts with the agent handle, then clears the draft', async () => {
    await mount(bridge('ok'))
    type(field(), 'build the header')
    await act(async () => sendButton().click())
    expect(api.addCanvasComment).toHaveBeenCalledWith('c', { pageId: 'p', x: 0, y: 0, text: '@dev build the header' })
    expect(field().value).toBe('')
  })

  it('keeps the draft and says so when the send fails', async () => {
    vi.mocked(api.addCanvasComment).mockRejectedValue(new Error('500'))
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await mount(bridge('ok'))
    type(field(), 'build the header')
    await act(async () => sendButton().click())
    expect(field().value).toBe('build the header')
    expect(container.textContent).toContain('did not go through')
    spy.mockRestore()
  })
})
