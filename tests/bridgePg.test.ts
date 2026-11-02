import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { stubEnv, unstubAllEnvs } from './envStub.ts'

/* Real PostgreSQL: the migration and the one-row-per-canvas upsert are
 * properties of the database. Set DOOP_TEST_PG_URL to an empty database to
 * run; skipped otherwise. */
const PG_URL = process.env.DOOP_TEST_PG_URL

describe.skipIf(!PG_URL)('canvas_bridge on PostgreSQL', () => {
  let bridge: typeof import('../server/bridge.ts')
  let pool: pg.Pool

  beforeAll(async () => {
    stubEnv('DATABASE_URL', PG_URL)
    pool = new pg.Pool({ connectionString: PG_URL })
    await (await import('../server/db/index.ts')).initDb()
    bridge = await import('../server/bridge.ts')
  })

  afterAll(async () => {
    await pool?.end()
    unstubAllEnvs()
  })

  beforeEach(async () => {
    await pool.query('delete from canvas_bridge')
  })

  it('the migration creates the table with the agreed columns', async () => {
    const { rows } = await pool.query(
      `select column_name from information_schema.columns where table_name = 'canvas_bridge' order by column_name`,
    )
    expect(rows.map((r) => r.column_name)).toEqual(
      expect.arrayContaining(['canvas_id', 'agent_ref', 'agent_name', 'updated_by', 'updated_at']),
    )
  })

  it('keeps one row per canvas across selection, list and heartbeat writes', async () => {
    await bridge.setBridgeAgents('c1', [{ ref: 'a1', name: 'Sol' }], 'u1', 1000)
    await bridge.selectBridgeAgent('c1', 'a1', 'u2', 2000)
    await bridge.bridgeHeartbeat('c1', 'u1', 3000)
    await bridge.selectBridgeAgent('c2', null, 'u2', 4000)
    const { rows } = await pool.query('select canvas_id from canvas_bridge order by canvas_id')
    expect(rows.map((r) => r.canvas_id)).toEqual(['c1', 'c2'])
    expect(await bridge.getBridge('c1', 3500)).toMatchObject({
      agentRef: 'a1',
      agentName: 'Sol',
      watcherSeenAt: 3000,
      status: 'ok',
    })
  })

  it('goes watcher_unreachable once the stamp is more than 2 minutes old', async () => {
    await bridge.setBridgeAgents('c1', [{ ref: 'a1', name: 'Sol' }], 'u1', 1000)
    await bridge.selectBridgeAgent('c1', 'a1', 'u2', 1000)
    expect((await bridge.getBridge('c1', 1000 + 120_000)).status).toBe('ok')
    expect((await bridge.getBridge('c1', 1000 + 120_001)).status).toBe('watcher_unreachable')
  })

  it('answers an empty bridge for a canvas with no row', async () => {
    expect(await bridge.getBridge('none', 5000)).toEqual({
      agentRef: null,
      agentName: null,
      agents: [],
      watcherSeenAt: null,
      status: 'no_agent_selected',
    })
  })
})
