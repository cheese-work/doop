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

/* refs are Multica agent UUIDs; the watcher routes a mention by the agent's name */
const DEV = '8b5fe946-257a-460d-b5ea-53d9b85ad96f'
const REVIEW = '2c1d7a40-91f3-4c55-9a0e-6f1b3e5d7c88'
const AGENTS = [
  { ref: DEV, name: 'dev-agent' },
  { ref: REVIEW, name: 'review-agent' },
]

function bridge(status: BridgeStatus, over: Partial<BridgeInfo> = {}): BridgeInfo {
  return { agentRef: DEV, agentName: 'dev-agent', agents: AGENTS, watcherSeenAt: 1, status, ...over }
}

function comment(over: Partial<ElementComment> & Pick<ElementComment, 'id' | 'text' | 'at'>): ElementComment {
  return { canvasId: 'c', snippet: '', pageId: 'p', x: 0, y: 0, from: 'Ada', ...over }
}

/* the watcher's own reply when the canvas has no linked issue (intake.py / bridge.py answer_unlinked) */
const NOLINK =
  '[dsg:nolink:r] No issue is linked to this canvas, so nothing was sent. Link a Multica issue with designctl link, then ask again.'
const NOITEM = '[dsg:noitem:r] No item: @ghost is not a Multica agent. Pick an agent from the list.'

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
    expect(container.querySelector('[role="combobox"]')!.textContent).toContain('dev-agent')
  })

  it('lists the published agents and saves the picked one', async () => {
    await mount(bridge('ok'))
    vi.mocked(api.putBridge).mockResolvedValue(bridge('ok', { agentRef: REVIEW, agentName: 'review-agent' }))
    const trigger = container.querySelector<HTMLButtonElement>('[role="combobox"]')!
    act(() => trigger.focus())
    act(() => {
      trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
    })
    const options = [...document.querySelectorAll('[role="option"]')]
    expect(options.map((o) => o.textContent)).toEqual(['dev-agent', 'review-agent'])
    await act(async () => {
      options[1]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    })
    expect(api.putBridge).toHaveBeenCalledWith('c', REVIEW)
    expect(container.querySelector('[role="combobox"]')!.textContent).toContain('review-agent')
  })

  it('takes one save at a time, so an older save cannot replace the latest choice', async () => {
    await mount(bridge('ok'))
    let finishSave!: (value: BridgeInfo) => void
    vi.mocked(api.putBridge).mockReturnValueOnce(new Promise<BridgeInfo>((resolve) => (finishSave = resolve)))
    const trigger = () => container.querySelector<HTMLButtonElement>('[role="combobox"]')!
    act(() => trigger().focus())
    act(() => {
      trigger().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
    })
    await act(async () => {
      document
        .querySelectorAll('[role="option"]')[1]!
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    })
    expect(trigger().disabled).toBe(true)
    await act(async () => finishSave(bridge('ok', { agentRef: REVIEW, agentName: 'review-agent' })))
    expect(trigger().disabled).toBe(false)
    expect(trigger().textContent).toContain('review-agent')
  })

  it('blocks sending while a picker save is pending, so a message cannot reach the previous agent', async () => {
    await mount(bridge('ok'))
    let finishSave!: (value: BridgeInfo) => void
    vi.mocked(api.putBridge).mockReturnValueOnce(new Promise<BridgeInfo>((resolve) => (finishSave = resolve)))
    const trigger = container.querySelector<HTMLButtonElement>('[role="combobox"]')!
    act(() => trigger.focus())
    act(() => {
      trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
    })
    await act(async () => {
      document
        .querySelectorAll('[role="option"]')[1]!
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    })
    type(field(), 'hello')
    expect(sendButton().disabled).toBe(true)
    await act(async () => finishSave(bridge('ok', { agentRef: REVIEW, agentName: 'review-agent' })))
    expect(sendButton().disabled).toBe(false)
  })

  it('keeps a saved choice when an older poll response arrives after the save', async () => {
    vi.useFakeTimers()
    try {
      await mount(bridge('ok'))
      let finishRead!: (value: BridgeInfo) => void
      vi.mocked(api.getBridge).mockReturnValueOnce(new Promise<BridgeInfo>((resolve) => (finishRead = resolve)))
      await act(async () => {
        vi.advanceTimersByTime(30_000)
      })
      vi.mocked(api.putBridge).mockResolvedValue(bridge('ok', { agentRef: REVIEW, agentName: 'review-agent' }))
      const trigger = container.querySelector<HTMLButtonElement>('[role="combobox"]')!
      act(() => trigger.focus())
      act(() => {
        trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
      })
      const options = [...document.querySelectorAll('[role="option"]')]
      await act(async () => {
        options[1]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
      })
      expect(container.querySelector('[role="combobox"]')!.textContent).toContain('review-agent')
      await act(async () => finishRead(bridge('ok')))
      expect(container.querySelector('[role="combobox"]')!.textContent).toContain('review-agent')
    } finally {
      vi.useRealTimers()
    }
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
    await mount(bridge('agent_not_found', { agentRef: 'gone-ref', agentName: 'gone-agent' }))
    expect(banner()).toContain('gone-agent')
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
        comment({ id: 'r', text: '@dev-agent ship it', at: 1 }),
        comment({ id: 'f', parentId: 'r', from: 'Watcher', text: NOLINK, at: 2 }),
      ],
    })
    await mount(bridge('ok'))
    expect(banner()).toContain('not linked to a Multica issue')
  })

  it('drops the issue_not_linked banner once a newer message is sent', async () => {
    useStore.setState({
      comments: [
        comment({ id: 'r', text: '@dev-agent ship it', at: 1 }),
        comment({ id: 'f', parentId: 'r', from: 'Watcher', text: NOLINK, at: 2 }),
        comment({ id: 'r2', text: '@dev-agent again', at: 3 }),
      ],
    })
    await mount(bridge('ok'))
    expect(banner()).toBeNull()
  })

  it('shows a reply from the watcher that names an unknown agent', async () => {
    useStore.setState({
      comments: [
        comment({ id: 'r', text: '@dev-agent hi @ghost', at: 1 }),
        comment({ id: 'f', parentId: 'r', from: 'Watcher', text: NOITEM, at: 2 }),
      ],
    })
    await mount(bridge('ok'))
    expect(banner()).toContain('not a Multica agent')
  })

  it('blocks sending to an agent whose name the watcher cannot route', async () => {
    const ref = '5d0a9c1e-0000-4000-8000-000000000001'
    await mount(bridge('ok', { agentRef: ref, agentName: 'Review Agent', agents: [{ ref, name: 'Review Agent' }] }))
    expect(banner()).toContain('cannot be addressed')
    type(field(), 'hello')
    expect(sendButton().disabled).toBe(true)
  })
})

describe('chat thread', () => {
  it('shows messages to the agent and its replies in order, without the markers', async () => {
    useStore.setState({
      comments: [
        comment({ id: 'a2', parentId: 'a', from: 'dev-agent', text: '[dsg:7] Done.', at: 4 }),
        comment({ id: 'other', text: '@review-agent look', at: 3 }),
        comment({ id: 'b', text: 'no mention', at: 2 }),
        comment({ id: 'a', text: '@dev-agent please start', at: 1 }),
      ],
    })
    await mount(bridge('ok'))
    const rows = [...container.querySelectorAll('[data-slot="chat-line"]')].map((el) => el.textContent)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toContain('please start')
    expect(rows[0]).not.toContain('@dev-agent')
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
    expect(api.addCanvasComment).toHaveBeenCalledWith('c', {
      pageId: 'p',
      x: 0,
      y: 0,
      text: '@dev-agent build the header',
    })
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
