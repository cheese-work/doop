import { env } from '../env.ts'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import * as schema from './schema.ts'

/**
 * DATABASE_URL set   -> real Postgres (production: Railway/Fly managed PG)
 * DATABASE_URL unset -> PGlite, an embedded Postgres persisted to ./data/pg
 * Same dialect, same schema, same queries either way.
 *
 * Schema changes: edit schema.ts / auth-schema.ts, then `npx drizzle-kit
 * generate` — the SQL lands in ./migrations and is applied here at boot.
 * Migration 0000 doubles as a baseline: fully idempotent, so databases
 * created by the pre-migration boot DDL adopt the journal cleanly.
 */

export type Db = NodePgDatabase<typeof schema>

export let db: Db

/* resolved from this file, not process.cwd() — the server may be launched
   from anywhere (tests spawn it from a temp working directory) */
const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations')

export async function initDb(): Promise<void> {
  const url = env.DATABASE_URL
  if (url) {
    const { drizzle } = await import('drizzle-orm/node-postgres')
    const { default: pg } = await import('pg')
    const pool = new pg.Pool({ connectionString: url })
    /* A connection that drops (a killed backend, a network loss, a Postgres restart) emits 'error'. The pool
       listens only while a client is idle; a checked-out client has none, and an 'error' with no listener
       throws and ends the process. Listen on every client for its whole life: the query in flight rejects with
       the real error, which callers such as purgeTrashedFrame turn into an outcome they can settle (CHE-9643). */
    const lost = (error: Error) => console.error('[db] postgres connection error:', error.message)
    pool.on('error', lost)
    pool.on('connect', (client) => client.on('error', lost))
    db = drizzle({ client: pool, schema })
    /* C00 migrates in a supervised one-shot container first (server/db/migrate.ts, CHE-5474 C-8.8) */
    if (env.DOOP_SKIP_MIGRATIONS) return
    const { migrate } = await import('drizzle-orm/node-postgres/migrator')
    await migrate(db, { migrationsFolder: MIGRATIONS })
  } else {
    const { PGlite } = await import('@electric-sql/pglite')
    const { drizzle } = await import('drizzle-orm/pglite')
    const dir = path.join(process.cwd(), 'data', 'pg')
    fs.mkdirSync(dir, { recursive: true }) // PGlite's own mkdir isn't recursive
    const client = new PGlite(dir)
    const pgliteDb = drizzle(client, { schema })
    const { migrate } = await import('drizzle-orm/pglite/migrator')
    await migrate(pgliteDb, { migrationsFolder: MIGRATIONS })
    db = pgliteDb as unknown as Db
  }
}
