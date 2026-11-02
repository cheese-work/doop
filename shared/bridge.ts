/** Chat bridge: which Multica agent a canvas chats with, and whether the
 *  watcher that relays to it is alive. Shared by the server and the UI. */

export interface BridgeAgent {
  ref: string
  name: string
}

export type BridgeStatus = 'ok' | 'no_agent_selected' | 'agent_not_found' | 'watcher_unreachable'

export interface BridgeState {
  agentRef: string | null
  agents: BridgeAgent[]
  watcherSeenAt: number | null
}

/** Longest agent ref or name we store. */
export const MAX_BRIDGE_TEXT = 200

/** A watcher stamp older than this means nobody is relaying. */
export const WATCHER_STALE_MS = 120_000

/** Derived on every read, never stored. A silent watcher outranks a missing
 *  agent: the list it published is only as fresh as its last stamp. */
export function bridgeStatus(state: BridgeState, now: number): BridgeStatus {
  if (!state.agentRef) return 'no_agent_selected'
  if (state.watcherSeenAt === null || now - state.watcherSeenAt > WATCHER_STALE_MS) return 'watcher_unreachable'
  return state.agents.some((a) => a.ref === state.agentRef) ? 'ok' : 'agent_not_found'
}
