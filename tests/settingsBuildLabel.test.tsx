// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

/* Settings wears the whole dashboard shell; none of it matters here, so the
   panes and the shell are stubbed and only the build-label footer is real. */
vi.mock('../src/App', () => ({ navigate: vi.fn() }))
vi.mock('../src/components/ModelAccount', () => ({ ModelAccountPanel: () => null }))
vi.mock('../src/components/ImageModelCard', () => ({ ImageModelCard: () => null }))
vi.mock('../src/components/ImageDescriptionsCard', () => ({ ImageDescriptionsCard: () => null }))
vi.mock('../src/components/TeamAllowance', () => ({ useAllowance: () => ({ allowance: null, refresh: vi.fn() }) }))
vi.mock('../src/components/AccountSettings', () => ({ AccountSettings: () => null }))
vi.mock('../src/components/PlanSettings', () => ({ PlanSettings: () => null }))
vi.mock('../src/components/AppearanceSettings', () => ({ AppearanceSettings: () => null }))
vi.mock('../src/components/GeneralSettings', () => ({ GeneralSettings: () => null }))
vi.mock('../src/components/AgentKeys', () => ({ AgentKeys: () => null }))
vi.mock('../src/components/Webhooks', () => ({ Webhooks: () => null }))
vi.mock('../src/components/FontLibrary', () => ({ FontLibrary: () => null }))
vi.mock('../src/components/CustomAgents', () => ({ CustomAgents: () => null }))
vi.mock('../src/components/DashShell', () => ({ AccountMenu: () => null }))
import { Settings } from '../src/pages/Settings'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let container: HTMLDivElement
beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

/* render Settings and let the /api/version fetch settle */
async function renderSettings(fetchImpl: (url: string, init?: RequestInit) => Promise<unknown>) {
  const fetchMock = vi.fn(fetchImpl)
  vi.stubGlobal('fetch', fetchMock)
  await act(async () => root.render(<Settings />))
  return fetchMock
}

const json =
  (body: unknown, ok = true) =>
  () =>
    Promise.resolve({ ok, json: () => Promise.resolve(body) })

it('shows the label /api/version returns, in the Settings footer', async () => {
  const label = '0.15.0-20261123-1411 · cd9bfa12'
  const fetchMock = await renderSettings(json({ version: '0.15.0', build: '20261123-1411', commit: 'cd9bfa12', label }))
  expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/version')
  const footer = [...container.querySelectorAll('p')].find((p) => p.textContent === label)
  expect(footer).toBeDefined()
  expect(footer!.className).toContain('font-mono')
})

it('keeps the footer empty and shows no error when the fetch rejects', async () => {
  await renderSettings(() => Promise.reject(new Error('offline')))
  expect(container.querySelector('p.font-mono')).toBeNull()
  expect(container.textContent).not.toMatch(/error|fail|offline/i)
})

it('keeps the footer empty and shows no error on a non-OK response', async () => {
  await renderSettings(json({ error: 'boom' }, false))
  expect(container.querySelector('p.font-mono')).toBeNull()
  expect(container.textContent).not.toMatch(/error|fail|boom/i)
})
