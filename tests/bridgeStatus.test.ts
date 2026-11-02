import { describe, expect, it } from 'vitest'
import { bridgeStatus, WATCHER_STALE_MS, type BridgeState } from '../shared/bridge.ts'

const NOW = 1_000_000_000_000
const agents = [
  { ref: 'a1', name: 'Sol' },
  { ref: 'a2', name: 'Luna' },
]
const state = (patch: Partial<BridgeState> = {}): BridgeState => ({
  agentRef: 'a1',
  agents,
  watcherSeenAt: NOW - 1000,
  ...patch,
})

describe('bridgeStatus', () => {
  it('is ok when the selected agent is listed and the watcher is fresh', () => {
    expect(bridgeStatus(state(), NOW)).toBe('ok')
  })

  it('is no_agent_selected without a selection, even when the watcher is silent', () => {
    expect(bridgeStatus(state({ agentRef: null }), NOW)).toBe('no_agent_selected')
    expect(bridgeStatus(state({ agentRef: null, watcherSeenAt: null }), NOW)).toBe('no_agent_selected')
  })

  it('is agent_not_found when the selected ref is absent from the published list', () => {
    expect(bridgeStatus(state({ agentRef: 'gone' }), NOW)).toBe('agent_not_found')
    expect(bridgeStatus(state({ agents: [] }), NOW)).toBe('agent_not_found')
  })

  it('is watcher_unreachable when the stamp is older than 2 minutes or missing', () => {
    expect(WATCHER_STALE_MS).toBe(120_000)
    expect(bridgeStatus(state({ watcherSeenAt: NOW - WATCHER_STALE_MS - 1 }), NOW)).toBe('watcher_unreachable')
    expect(bridgeStatus(state({ watcherSeenAt: null }), NOW)).toBe('watcher_unreachable')
  })

  it('treats a stamp exactly 2 minutes old as still fresh', () => {
    expect(bridgeStatus(state({ watcherSeenAt: NOW - WATCHER_STALE_MS }), NOW)).toBe('ok')
  })

  it('reports a silent watcher before a missing agent, because the list may be stale', () => {
    expect(bridgeStatus(state({ agentRef: 'gone', watcherSeenAt: null }), NOW)).toBe('watcher_unreachable')
  })
})
