// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'

vi.mock('../src/App', () => ({ navigate: vi.fn() }))
vi.mock('../src/lib/posthog', () => ({ posthog: { capture: vi.fn() } }))

const { MobilePanelTabs } = await import('../src/components/SideRail')
const { TooltipProvider } = await import('../src/components/ui/tooltip')

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function labels(commentsOnly?: boolean): string[] {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  act(() =>
    root.render(
      <TooltipProvider>
        <MobilePanelTabs onOpen={vi.fn()} commentsOnly={commentsOnly} />
      </TooltipProvider>,
    ),
  )
  const found = [...host.querySelectorAll('button')].map((b) => b.getAttribute('aria-label') ?? '')
  act(() => root.unmount())
  host.remove()
  return found
}

it('offers every panel tab to an editor', () => {
  expect(labels()).toHaveLength(4)
})

it('offers only Comments in the phone review layout', () => {
  const found = labels(true)
  expect(found).toHaveLength(1)
  expect(found[0]).toMatch(/^Comments/)
})
