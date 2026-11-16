import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

/* CHE-5474 S4b (C-8.8): the supervised runner `server/db/migrate.ts`. Its session is named
   by application_name, it holds one fixed advisory key for the whole run, and it has a deadline.
   Real PostgreSQL (advisory locks and pg_stat_activity are the property under test): set
   DOOP_TEST_PG_URL to a scratch server; skipped otherwise. */
const PG_URL = process.env.DOOP_TEST_PG_URL
const LOCK = { classid: 1685025648, objid: 1 } // c00.sh `lock_class` / `lock_obj`
const d = PG_URL ? describe : describe.skip

d('runMigrations', () => {
  let admin: pg.Client
  const DB = `mig_${Date.now()}`
  let url = ''
  beforeAll(async () => {
    admin = new pg.Client({ connectionString: PG_URL })
    await admin.connect()
    await admin.query(`create database ${DB}`)
    const u = new URL(PG_URL!)
    u.pathname = `/${DB}`
    url = u.toString()
  })
  afterAll(async () => {
    await admin.query(`drop database ${DB} with (force)`)
    await admin.end()
  })

  const run = async (opts: Record<string, unknown> = {}) => {
    const { runMigrations } = await import('../server/db/migrate.ts')
    return runMigrations({ url, appName: 'doop-migrate-t1', deadlineMs: 20_000, ...opts })
  }
  const sessions = async (app: string) =>
    (await admin.query(`select 1 from pg_stat_activity where application_name = $1`, [app])).rowCount

  it('applies the journal and ends with no session and the key free', async () => {
    await run()
    const c = new pg.Client({ connectionString: url })
    await c.connect()
    const n = await c.query('select count(*)::int as n from drizzle.__drizzle_migrations')
    await c.end()
    expect(n.rows[0].n).toBeGreaterThan(40)
    expect(await sessions('doop-migrate-t1')).toBe(0)
  })

  it('names its session by application_name and holds the fixed advisory key while it runs', async () => {
    let seen: { sessions: number | null; locks: number | null } | undefined
    await run({
      appName: 'doop-migrate-t2',
      onLocked: async () => {
        const l = await admin.query(
          `select 1 from pg_locks where locktype='advisory' and classid=$1 and objid=$2 and objsubid=2 and granted`,
          [LOCK.classid, LOCK.objid],
        )
        seen = { sessions: await sessions('doop-migrate-t2'), locks: l.rowCount }
      },
    })
    expect(seen).toEqual({ sessions: 1, locks: 1 })
  })

  it('a second runner waits for the key and fails at its deadline instead of migrating', async () => {
    const holder = new pg.Client({ connectionString: url })
    await holder.connect()
    await holder.query('select pg_advisory_lock($1, $2)', [LOCK.classid, LOCK.objid])
    try {
      await expect(run({ appName: 'doop-migrate-t3', deadlineMs: 1500 })).rejects.toThrow(/deadline/)
      expect(await sessions('doop-migrate-t3')).toBe(0)
    } finally {
      await holder.end()
    }
  })

  it('a failing migration rejects and still leaves no session and no lock', async () => {
    await expect(run({ appName: 'doop-migrate-t4', folder: '/nonexistent' })).rejects.toThrow()
    expect(await sessions('doop-migrate-t4')).toBe(0)
  })
})

describe('boot-time migrations', () => {
  it('server/db/index.ts skips migrating when DOOP_SKIP_MIGRATIONS is set', () => {
    const src = readFileSync(new URL('../server/db/index.ts', import.meta.url), 'utf8')
    expect(src).toMatch(/env\.DOOP_SKIP_MIGRATIONS/)
  })
  it('env.ts declares it as a boolean, default false', () => {
    const src = readFileSync(new URL('../server/env.ts', import.meta.url), 'utf8')
    expect(src).toMatch(/DOOP_SKIP_MIGRATIONS:\s*bool\(\{\s*default:\s*false/)
  })
})
