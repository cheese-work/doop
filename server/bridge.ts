import { eq } from 'drizzle-orm'
import { db } from './db/index.ts'
import { canvasBridge } from './db/schema.ts'
import { bridgeStatus, type BridgeAgent, type BridgeStatus } from '../shared/bridge.ts'

/** Chat bridge storage: one canvas_bridge row per canvas. The browser writes
 *  the selection, the watcher (agent key) writes the agent list and the
 *  liveness stamp; each write touches only its own columns. */

export interface Bridge {
  agentRef: string | null
  agentName: string | null
  agents: BridgeAgent[]
  watcherSeenAt: number | null
  status: BridgeStatus
}

export async function getBridge(canvasId: string, now = Date.now()): Promise<Bridge> {
  const [row] = await db.select().from(canvasBridge).where(eq(canvasBridge.canvasId, canvasId))
  const state = {
    agentRef: row?.agentRef ?? null,
    agents: row?.agents ?? [],
    watcherSeenAt: row?.watcherSeenAt ?? null,
  }
  /* the published name wins, so a rename or a late list shows up at once */
  const agentName = state.agents.find((a) => a.ref === state.agentRef)?.name ?? row?.agentName ?? null
  return { ...state, agentName, status: bridgeStatus(state, now) }
}

/** Insert the canvas's row, or update only `patch` on the existing one. */
async function upsert(
  canvasId: string,
  userId: string,
  now: number,
  patch: Partial<typeof canvasBridge.$inferInsert>,
): Promise<void> {
  const write = { ...patch, updatedBy: userId, updatedAt: now }
  await db
    .insert(canvasBridge)
    .values({ canvasId, ...write })
    .onConflictDoUpdate({ target: canvasBridge.canvasId, set: write })
}

/** Replace the published list. Duplicate refs keep the first name. Stamps the watcher. */
export async function setBridgeAgents(
  canvasId: string,
  agents: BridgeAgent[],
  userId: string,
  now = Date.now(),
): Promise<void> {
  const unique = [
    ...new Map(
      agents
        .slice()
        .reverse()
        .map((a) => [a.ref, a]),
    ).values(),
  ].reverse()
  await upsert(canvasId, userId, now, { agents: unique, watcherSeenAt: now })
}

export async function bridgeHeartbeat(canvasId: string, userId: string, now = Date.now()): Promise<void> {
  await upsert(canvasId, userId, now, { watcherSeenAt: now })
}

/** Select the agent a canvas chats with (null clears). The name comes from the
 *  published list; a ref the watcher has not listed keeps the ref as its name. */
export async function selectBridgeAgent(
  canvasId: string,
  agentRef: string | null,
  userId: string,
  now = Date.now(),
): Promise<void> {
  const { agents } = await getBridge(canvasId, now)
  const agentName = agentRef === null ? null : (agents.find((a) => a.ref === agentRef)?.name ?? agentRef)
  await upsert(canvasId, userId, now, { agentRef, agentName })
}
