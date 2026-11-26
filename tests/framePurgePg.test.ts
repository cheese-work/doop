import fs from 'node:fs'
import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import pg from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { stubEnv, unstubAllEnvs } from './envStub.ts'

/* CHE-9399 step 3 (P1c): server/db/purge.ts, the one transaction that removes a trashed frame, and the probe that
 * says what happened to it. No route calls it yet. Real PostgreSQL for the transaction, the SHARE lock and the lost
 * acknowledgements: set DOOP_TEST_PG_URL to an empty database to run; skipped otherwise. T16 runs on PGlite. */
const PG_URL = process.env.DOOP_TEST_PG_URL

const F = 'purge-f'
const G = 'purge-g'
const CANVAS = 'purge-canvas'
const DELETED_AT = 1_700_000_000_123

type PurgeModule = typeof import('../server/db/purge.ts')
type Args = Parameters<PurgeModule['purgeTrashedFrame']>[0]

/* tables whose rows a purge must leave alone (plan step 3, item 5) */
const KEPT = [
  'comments',
  'comment_events',
  'page_snapshots',
  'snapshot_blobs',
  'activity',
  'design_attestations',
  'decisions',
  'memory_references',
  'automation_approvals',
  'tasks',
  'components',
] as const

const TEXT_COLUMNS = '(id, canvas_id, name, x, y, width, height, html, created_at, updated_at, updated_by, deleted_at)'

/** Seeds frame `id` in the Trash with two versions, two write keys and two asset refs, and returns their ids. */
async function seedFrame(pool: pg.Pool, id: string, deletedAt: number | null = DELETED_AT) {
  await pool.query(
    `insert into frames ${TEXT_COLUMNS} values ($1, $2, $1, 0, 0, 640, 480, '<p>x</p>', 0, 0, 'alice', $3)`,
    [id, CANVAS, deletedAt],
  )
  const versionIds = [`${id}-v1`, `${id}-v2`]
  for (const v of versionIds) {
    await pool.query(
      `insert into frame_versions (id, frame_id, canvas_id, html, width, height, saved_at, saved_by) values ($1, $2, $3, '<p>old</p>', 640, 480, 1, 'alice')`,
      [v, id, CANVAS],
    )
  }
  const writeKeyIds = [`${id}-k1`, `${id}-k2`]
  for (const [i, k] of writeKeyIds.entries()) {
    await pool.query(
      `insert into frame_write_keys (frame_id, key, payload_hash, version_id, result, created_at) values ($1, $2, 'h', $3, '{"updatedAt":1,"htmlBytes":1}', 1)`,
      [id, k, versionIds[i]],
    )
  }
  const assetRefIds = [`${id}-a1`, `${id}-a2`]
  for (const a of assetRefIds) await pool.query('insert into asset_refs (asset_id, frame_id) values ($1, $2)', [a, id])
  return { versionIds, writeKeyIds, assetRefIds }
}

/** Seeds one row in each kept table that a frame can touch; the other kept tables stay empty and are only counted. */
async function seedKept(pool: pg.Pool) {
  await pool.query(
    `insert into comments (id, canvas_id, frame_id, snippet, from_name, text, at) values ('c-g', $1, $2, '', 'bob', 'on G', 1)`,
    [CANVAS, G],
  )
  await pool.query(`insert into comment_events (canvas_id, comment_id, at) values ($1, 'c-g', 1)`, [CANVAS])
  await pool.query(
    `insert into page_snapshots (id, canvas_id, page_id, page_name, name, author, created_at, frames) values ('s1', $1, 'p1', 'Page 1', 'snap', 'bob', 1, '[]')`,
    [CANVAS],
  )
  await pool.query(`insert into snapshot_blobs (canvas_id, hash, html) values ($1, 'h1', '<p>x</p>')`, [CANVAS])
  await pool.query(
    `insert into activity (id, canvas_id, actor_name, actor_kind, actor_color, message, frame_id, at) values ('act1', $1, 'bob', 'user', '#000', 'deleted frame', $2, 1)`,
    [CANVAS, F],
  )
  await pool.query(
    `insert into decisions (id, canvas_id, text, source, frame_id, from_name, at) values ('d1', $1, 't', 'comment', $2, 'bob', 1)`,
    [CANVAS, F],
  )
  await pool.query(
    `insert into memory_references (id, canvas_id, frame_id, title, html, width, height, pinned_by, pinned_at) values ('m1', $1, $2, 't', '<p/>', 1, 1, 'bob', 1)`,
    [CANVAS, F],
  )
  await pool.query(`insert into automation_approvals (automation_id, frame_id, approved_at) values ('au1', $1, 1)`, [F])
}

async function counts(pool: pg.Pool, tables: readonly string[]) {
  const out: Record<string, number> = {}
  for (const table of tables) {
    out[table] = (await pool.query(`select count(*)::int as n from ${table}`)).rows[0].n as number
  }
  return out
}

const FROZEN = ['frames', 'frame_versions', 'frame_write_keys', 'asset_refs'] as const
const ALL = [...FROZEN, ...KEPT]

const sorted = (xs: string[]) => [...xs].sort()

/** Resolves after `ms`, so a test can say "still pending after this long". */
const pendingAfter = async (p: Promise<unknown>, ms: number) => {
  const settled = Symbol('settled')
  const winner = await Promise.race([p.then(() => settled), new Promise((r) => setTimeout(() => r('pending'), ms))])
  return winner === 'pending'
}

describe.skipIf(!PG_URL)('frame purge transaction on PostgreSQL', () => {
  let purge: PurgeModule
  let pool: pg.Pool
  let args: (over?: Partial<Args>) => Args
  let requested: unknown[]

  beforeAll(async () => {
    stubEnv('DATABASE_URL', PG_URL)
    pool = new pg.Pool({ connectionString: PG_URL })
    await (await import('../server/db/index.ts')).initDb()
    purge = await import('../server/db/purge.ts')
  })

  afterAll(async () => {
    await pool?.end()
    unstubAllEnvs()
  })

  beforeEach(async () => {
    for (const table of [...ALL].reverse()) await pool.query(`delete from ${table}`)
    requested = []
    args = (over = {}) => ({
      frameId: F,
      canvasId: CANVAS,
      deletedAt: DELETED_AT,
      stillMayPurge: () => true,
      onCommitRequested: (receipt) => void requested.push(receipt),
      ...over,
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('T1u deletes the frame row, its versions, write keys and asset refs; the receipt lists exactly those ids; kept tables keep their rows', async () => {
    const seeded = await seedFrame(pool, F)
    await seedFrame(pool, G, null)
    await seedKept(pool)
    const before = await counts(pool, KEPT)
    const result = await purge.purgeTrashedFrame(args())
    expect(result.outcome).toBe('committed')
    if (result.outcome !== 'committed') return
    expect(result.receipt).toMatchObject({ frameId: F, canvasId: CANVAS, deletedAt: DELETED_AT })
    expect(sorted(result.receipt.versionIds)).toEqual(sorted(seeded.versionIds))
    expect(sorted(result.receipt.writeKeyIds)).toEqual(sorted(seeded.writeKeyIds))
    expect(sorted(result.receipt.assetRefIds)).toEqual(sorted(seeded.assetRefIds))
    expect(requested).toEqual([result.receipt])
    // F is gone from all four tables; G is untouched
    for (const table of ['frames', 'frame_versions', 'frame_write_keys', 'asset_refs']) {
      const col = table === 'frames' ? 'id' : 'frame_id'
      expect((await pool.query(`select count(*)::int as n from ${table} where ${col} = $1`, [F])).rows[0].n).toBe(0)
      expect((await pool.query(`select count(*)::int as n from ${table} where ${col} = $1`, [G])).rows[0].n).toBe(
        table === 'frames' ? 1 : 2,
      )
    }
    expect(await counts(pool, KEPT)).toEqual(before)
  })

  it('T3u a deleted_at mismatch is refused as a conflict and every row is kept', async () => {
    await seedFrame(pool, F)
    await seedKept(pool)
    const before = await counts(pool, ALL)
    const result = await purge.purgeTrashedFrame(args({ deletedAt: DELETED_AT + 1 }))
    expect(result).toEqual({ outcome: 'refused', reason: 'conflict' })
    expect(requested).toEqual([])
    expect(await counts(pool, ALL)).toEqual(before)
  })

  it('T3u a frame that is no longer in the Trash (deleted_at null) is refused as a conflict', async () => {
    await seedFrame(pool, F, null)
    const before = await counts(pool, ALL)
    expect(await purge.purgeTrashedFrame(args())).toEqual({ outcome: 'refused', reason: 'conflict' })
    expect(await counts(pool, ALL)).toEqual(before)
  })

  it('T5u stillMayPurge false is refused as access_lost, after the deletes, and every row is kept', async () => {
    await seedFrame(pool, F)
    await seedKept(pool)
    const before = await counts(pool, ALL)
    const check = vi.fn(() => false)
    const result = await purge.purgeTrashedFrame(args({ stillMayPurge: check }))
    expect(result).toEqual({ outcome: 'refused', reason: 'access_lost' })
    expect(check).toHaveBeenCalledTimes(1)
    expect(requested).toEqual([])
    expect(await counts(pool, ALL)).toEqual(before)
  })

  it("T5u stillMayPurge 'has_comments' (a comment in memory) is refused as has_comments and every row is kept", async () => {
    await seedFrame(pool, F)
    const before = await counts(pool, ALL)
    const result = await purge.purgeTrashedFrame(args({ stillMayPurge: () => 'has_comments' }))
    expect(result).toEqual({ outcome: 'refused', reason: 'has_comments' })
    expect(await counts(pool, ALL)).toEqual(before)
  })

  it('T14b a comment row with frame_id = F is refused as has_comments and every row is kept', async () => {
    await seedFrame(pool, F)
    await pool.query(
      `insert into comments (id, canvas_id, frame_id, snippet, from_name, text, at) values ('c-f', $1, $2, '', 'bob', 'on F', 1)`,
      [CANVAS, F],
    )
    const before = await counts(pool, ALL)
    const check = vi.fn(() => true)
    expect(await purge.purgeTrashedFrame(args({ stillMayPurge: check }))).toEqual({
      outcome: 'refused',
      reason: 'has_comments',
    })
    expect(check).not.toHaveBeenCalled()
    expect(requested).toEqual([])
    expect(await counts(pool, ALL)).toEqual(before)
  })

  describe('T14c a comment insert for F open in another transaction', () => {
    const insertOpen = async () => {
      const client = await pool.connect()
      await client.query('begin')
      await client.query(
        `insert into comments (id, canvas_id, frame_id, snippet, from_name, text, at) values ('c-open', $1, $2, '', 'bob', 'racing', 1)`,
        [CANVAS, F],
      )
      return client
    }

    it('commits: the purge waits on the SHARE lock, then answers refused/has_comments', async () => {
      await seedFrame(pool, F)
      const writer = await insertOpen()
      const purging = purge.purgeTrashedFrame(args())
      expect(await pendingAfter(purging, 400)).toBe(true)
      await writer.query('commit')
      writer.release()
      expect(await purging).toEqual({ outcome: 'refused', reason: 'has_comments' })
      expect((await counts(pool, FROZEN)).frames).toBe(1)
    })

    it('rolls back: the purge commits', async () => {
      await seedFrame(pool, F)
      const writer = await insertOpen()
      const purging = purge.purgeTrashedFrame(args())
      expect(await pendingAfter(purging, 400)).toBe(true)
      await writer.query('rollback')
      writer.release()
      expect((await purging).outcome).toBe('committed')
      expect((await counts(pool, FROZEN)).frames).toBe(0)
    })
  })

  /* the hook stands in for a network that drops the COMMIT exchange */
  type Query = (this: pg.Client, ...a: unknown[]) => Promise<unknown>
  const realQuery = pg.Client.prototype.query as unknown as Query
  const isCommit = (a: unknown[]) => {
    const first = a[0]
    const text = typeof first === 'string' ? first : (first as { text?: string } | undefined)?.text
    return text === 'commit'
  }
  const failCommit = (when: 'after postgres committed' | 'before the commit reaches postgres') =>
    vi.spyOn(pg.Client.prototype as unknown as { query: Query }, 'query').mockImplementation(async function (
      this: pg.Client,
      ...a: unknown[]
    ) {
      if (!isCommit(a)) return realQuery.apply(this, a)
      if (when === 'after postgres committed') {
        await realQuery.apply(this, a)
        throw new Error('connection lost: COMMIT reply never arrived')
      }
      /* a killed backend makes the checked-out client emit 'error'; with no listener the run would die on it */
      this.on('error', () => {})
      await pool.query('select pg_terminate_backend($1)', [(this as unknown as { processID: number }).processID])
      return realQuery.apply(this, a)
    })

  it('T12a lost acknowledgement, committed: unknown with the seeded ids; the probe answers committed', async () => {
    const seeded = await seedFrame(pool, F)
    failCommit('after postgres committed')
    const result = await purge.purgeTrashedFrame(args())
    vi.restoreAllMocks()
    expect(result.outcome).toBe('unknown')
    if (result.outcome !== 'unknown') return
    expect(result.error).toBeInstanceOf(Error)
    expect(result.receipt).toMatchObject({ frameId: F, canvasId: CANVAS, deletedAt: DELETED_AT })
    expect(sorted(result.receipt!.versionIds)).toEqual(sorted(seeded.versionIds))
    expect(sorted(result.receipt!.writeKeyIds)).toEqual(sorted(seeded.writeKeyIds))
    expect(sorted(result.receipt!.assetRefIds)).toEqual(sorted(seeded.assetRefIds))
    expect(requested).toEqual([result.receipt])
    expect(await purge.resolvePurgeOutcome(F)).toBe('committed')
  })

  it('T12b lost acknowledgement, rolled back: unknown; the probe answers rolled_back; every row is kept', async () => {
    await seedFrame(pool, F)
    await seedKept(pool)
    const before = await counts(pool, ALL)
    failCommit('before the commit reaches postgres')
    const result = await purge.purgeTrashedFrame(args())
    vi.restoreAllMocks()
    expect(result.outcome).toBe('unknown')
    if (result.outcome !== 'unknown') return
    expect(result.receipt).toMatchObject({ frameId: F })
    expect(await purge.resolvePurgeOutcome(F)).toBe('rolled_back')
    expect(await counts(pool, ALL)).toEqual(before)
  })

  describe('T12c the probe waits for a purge transaction that holds the row lock', () => {
    const holdRow = async () => {
      const holder = await pool.connect()
      await holder.query('begin')
      await holder.query('select id from frames where id = $1 for update', [F])
      return holder
    }

    it('answers committed once that transaction deletes the row and commits', async () => {
      await seedFrame(pool, F)
      const holder = await holdRow()
      const probing = purge.resolvePurgeOutcome(F)
      expect(await pendingAfter(probing, 500)).toBe(true)
      await holder.query('delete from frames where id = $1', [F])
      await holder.query('commit')
      holder.release()
      expect(await probing).toBe('committed')
    })

    it('answers rolled_back once that transaction rolls back', async () => {
      await seedFrame(pool, F)
      const holder = await holdRow()
      const probing = purge.resolvePurgeOutcome(F)
      expect(await pendingAfter(probing, 500)).toBe(true)
      await holder.query('rollback')
      holder.release()
      expect(await probing).toBe('rolled_back')
    })

    it('tries again after a lock timeout and never answers unknown', async () => {
      await seedFrame(pool, F)
      const holder = await holdRow()
      const probing = purge.resolvePurgeOutcome(F, { lockTimeoutMs: 150, delaysMs: [20], repeatMs: 20 })
      // several lock timeouts pass; the probe has not answered
      expect(await pendingAfter(probing, 900)).toBe(true)
      await holder.query('delete from frames where id = $1', [F])
      await holder.query('commit')
      holder.release()
      expect(await probing).toBe('committed')
    })
  })

  it('T12e the probe waits 1, 2, 4, 8, 16 s after failed tries, then 30 s each time', async () => {
    await seedFrame(pool, F)
    const holder = await pool.connect()
    await holder.query('begin')
    await holder.query('select id from frames where id = $1 for update', [F])
    // take the probe's own pauses (timers set from purge.ts) off the clock and write them down; every other timer,
    // such as the pool's idle timer, stays real
    const pauses: number[] = []
    const realSetTimeout = globalThis.setTimeout
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number, ...rest: unknown[]) => {
      if (
        typeof ms === 'number' &&
        new Error().stack
          ?.split('\n')
          .slice(1, 5)
          .some((l) => l.includes('server/db/purge.ts') && !l.includes('node_modules'))
      ) {
        pauses.push(ms)
        return realSetTimeout(fn, 0, ...rest)
      }
      return realSetTimeout(fn, ms, ...rest)
    }) as typeof setTimeout)
    const probing = purge.resolvePurgeOutcome(F, { lockTimeoutMs: 50 })
    for (let i = 0; i < 200 && pauses.length < 8; i++) await new Promise((r) => realSetTimeout(r, 25))
    vi.restoreAllMocks()
    await holder.query('rollback')
    holder.release()
    expect(await probing).toBe('rolled_back')
    expect(pauses.slice(0, 8)).toEqual([1000, 2000, 4000, 8000, 16000, 30_000, 30_000, 30_000])
  })

  describe('T12d a backend killed before COMMIT does not take the server down (production pool, no test listener)', () => {
    it('the process survives, answers unknown, and the probe says rolled_back with every row kept', async () => {
      await seedFrame(pool, F)
      await seedKept(pool)
      const before = await counts(pool, ALL)
      // hold the comments table so the purge stops at its SHARE lock, mid-transaction and before COMMIT
      const blocker = await pool.connect()
      await blocker.query('begin')
      await blocker.query('lock table comments in access exclusive mode')
      const child = spawn(
        process.execPath,
        ['--import', 'tsx', 'tests/fixtures/purgeDisconnectChild.ts', F, CANVAS, String(DELETED_AT)],
        {
          env: { ...process.env, DATABASE_URL: PG_URL, DOOP_SKIP_MIGRATIONS: 'true' },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      )
      let out = ''
      let err = ''
      child.stdout.on('data', (d) => (out += d))
      child.stderr.on('data', (d) => (err += d))
      const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)))
      try {
        // wait until the purge sits on the lock, then kill its backend
        let pid: number | undefined
        for (let i = 0; i < 100 && !pid; i++) {
          await new Promise((r) => setTimeout(r, 100))
          const r = await pool.query(
            `select pid from pg_stat_activity where wait_event_type = 'Lock' and query ilike 'lock table comments in share mode%'`,
          )
          pid = r.rows[0]?.pid
        }
        expect(pid).toBeTruthy()
        await pool.query('select pg_terminate_backend($1)', [pid])
        const code = await exited
        expect(code, err).toBe(0)
        expect(out).toContain('RESULT {"outcome":"unknown","probe":"rolled_back"}')
      } finally {
        child.kill()
        await blocker.query('rollback')
        blocker.release()
      }
      expect(await counts(pool, ALL)).toEqual(before)
    }, 30_000)
  })
})

/* T16: PGlite has one in-process connection. With no DATABASE_URL the purge still runs inside its own transaction,
 * and a query issued from outside while it is open waits for it instead of joining it. */
describe('T16 purge on PGlite (no DATABASE_URL)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doop-purge-'))
  let purge: PurgeModule
  let dbm: typeof import('../server/db/index.ts')
  let t: typeof import('../server/db/schema.ts')
  let sql: typeof import('drizzle-orm').sql
  let eq: typeof import('drizzle-orm').eq

  const seed = async () => {
    await dbm.db.insert(t.frames).values({
      id: F,
      canvasId: CANVAS,
      name: F,
      x: 0,
      y: 0,
      width: 640,
      height: 480,
      html: '<p>x</p>',
      createdAt: 0,
      updatedAt: 0,
      updatedBy: 'alice',
      deletedAt: DELETED_AT,
    })
    await dbm.db.insert(t.frameVersions).values({
      id: 'v1',
      frameId: F,
      canvasId: CANVAS,
      html: '<p>old</p>',
      width: 640,
      height: 480,
      savedAt: 1,
      savedBy: 'alice',
    })
  }
  const rows = async () =>
    ({
      frames: (await dbm.db.select().from(t.frames)).length,
      versions: (await dbm.db.select().from(t.frameVersions)).length,
    }) as const

  beforeAll(async () => {
    vi.resetModules()
    stubEnv('DATABASE_URL', undefined)
    vi.spyOn(process, 'cwd').mockReturnValue(dir)
    dbm = await import('../server/db/index.ts')
    await dbm.initDb()
    vi.restoreAllMocks()
    t = await import('../server/db/schema.ts')
    purge = await import('../server/db/purge.ts')
    ;({ sql, eq } = await import('drizzle-orm'))
  })

  afterAll(() => {
    unstubAllEnvs()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  beforeEach(async () => {
    await dbm.db.delete(t.activity)
    await dbm.db.delete(t.frameVersions)
    await dbm.db.delete(t.frames)
  })

  it('a query issued from inside the open purge waits for it and runs outside it: a refused purge rolls back, the marker row stays', async () => {
    await seed()
    const order: string[] = []
    let outside: Promise<unknown> | undefined
    const result = await purge
      .purgeTrashedFrame({
        frameId: F,
        canvasId: CANVAS,
        deletedAt: DELETED_AT,
        // runs inside the transaction, after the deletes
        stillMayPurge: () => {
          outside = dbm.db
            .insert(t.activity)
            .values({
              id: 'marker',
              canvasId: CANVAS,
              actorName: 'x',
              actorKind: 'user',
              actorColor: '#000',
              message: 'outside',
              at: 1,
            })
            .then(() => order.push('outside ran'))
          return false
        },
        onCommitRequested: () => {},
      })
      .then((r) => {
        order.push('purge answered')
        return r
      })
    expect(result).toEqual({ outcome: 'refused', reason: 'access_lost' })
    await outside
    // it ran after the purge ended, and its row survived the purge's rollback
    expect(order).toEqual(['purge answered', 'outside ran'])
    expect((await dbm.db.select().from(t.activity).where(eq(t.activity.id, 'marker'))).length).toBe(1)
    expect(await rows()).toEqual({ frames: 1, versions: 1 })
  })

  it('commits and the probe answers committed; the three SET LOCAL settings are accepted', async () => {
    await seed()
    const result = await purge.purgeTrashedFrame({
      frameId: F,
      canvasId: CANVAS,
      deletedAt: DELETED_AT,
      stillMayPurge: () => true,
      onCommitRequested: () => {},
    })
    expect(result.outcome).toBe('committed')
    expect(await rows()).toEqual({ frames: 0, versions: 0 })
    expect(await purge.resolvePurgeOutcome(F)).toBe('committed')

    // report each setting on its own: this is the PR body's "PGlite accepts" line
    const accepted: Record<string, boolean> = {}
    for (const setting of [
      "statement_timeout = '10s'",
      "lock_timeout = '5s'",
      "idle_in_transaction_session_timeout = '30s'",
    ]) {
      accepted[setting] = await dbm.db
        .transaction(async (tx) => {
          await tx.execute(sql.raw(`set local ${setting}`))
        })
        .then(
          () => true,
          () => false,
        )
    }
    console.info('PGlite SET LOCAL accepted:', JSON.stringify(accepted))
    expect(accepted).toEqual({
      "statement_timeout = '10s'": true,
      "lock_timeout = '5s'": true,
      "idle_in_transaction_session_timeout = '30s'": true,
    })
  })

  it('the probe answers rolled_back for a frame that is still there', async () => {
    await seed()
    expect(await purge.resolvePurgeOutcome(F)).toBe('rolled_back')
  })
})
