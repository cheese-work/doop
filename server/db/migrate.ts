import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

/**
 * The supervised migration runner (CHE-5474 C-8.8). `deploy/cd/c00.sh apply` runs it once, in a
 * one-shot container of the candidate image, before the app is recreated:
 *
 *   node server/db/migrate.ts
 *
 * - The session is named by `application_name` (`doop-migrate-<run id>`), so a stuck run can be
 *   found, ended and shown gone in `pg_stat_activity`.
 * - It holds `pg_advisory_lock(DOOP_MIGRATE_LOCK)` for the whole run. `c00.sh` reads the same
 *   key from `pg_locks`; keep the two in step.
 * - It has a deadline. Waiting for the key counts. A run that passes it fails.
 *
 * Own process, own three variables, like geminiCloudWorkerMain: it must not load the server schema.
 */

/** 'doop' as an int4, and 1: the (classid, objid) pair `c00.sh` checks. */
export const DOOP_MIGRATE_LOCK = [1685025648, 1] as const

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations')

export interface MigrateOptions {
  url: string
  appName: string
  deadlineMs: number
  folder?: string
  /** test hook: runs while the key is held, before the migrations */
  onLocked?: () => Promise<void>
}

export async function runMigrations({ url, appName, deadlineMs, folder = MIGRATIONS, onLocked }: MigrateOptions) {
  const client = new pg.Client({ connectionString: url, application_name: appName })
  client.on('error', () => {}) // a terminated backend emits one; the failure surfaces through the pending query
  // the client must be fully closed before this resolves or rejects: a session left behind is what c00.sh must not see
  const closed = new Promise<void>((resolve) => client.once('end', () => resolve()))
  let timer: NodeJS.Timeout | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`migration passed its deadline of ${deadlineMs} ms`)), deadlineMs)
  })
  let finished = false
  const work = (async () => {
    await client.connect()
    await client.query('select pg_advisory_lock($1, $2)', [...DOOP_MIGRATE_LOCK])
    await onLocked?.()
    const { drizzle } = await import('drizzle-orm/node-postgres')
    const { migrate } = await import('drizzle-orm/node-postgres/migrator')
    await migrate(drizzle(client), { migrationsFolder: folder })
    finished = true
  })()
  work.catch(() => {}) // a loser of the race below must not become an unhandled rejection
  try {
    await Promise.race([work, deadline])
  } finally {
    clearTimeout(timer)
    if (!finished) await terminateOwnBackend(url, client)
    client.end().catch(() => {}) // ends the session, which drops the key with it
    await closed
  }
}

/** A client stuck in `pg_advisory_lock` or a long statement cannot end itself: ask the server to drop its backend. */
async function terminateOwnBackend(url: string, client: pg.Client) {
  const pid = (client as unknown as { processID?: number }).processID
  if (!pid) return
  const killer = new pg.Client({ connectionString: url, application_name: 'doop-migrate-cleanup' })
  try {
    await killer.connect()
    await killer.query('select pg_terminate_backend($1)', [pid])
  } catch {
    // the caller's own end() still runs; c00.sh proves quiescence either way
  } finally {
    await killer.end().catch(() => {})
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const url = process.env.DATABASE_URL
  const appName = process.env.DOOP_MIGRATE_APP_NAME
  const seconds = Number(process.env.DOOP_MIGRATE_DEADLINE_SECONDS ?? 120)
  if (!url || !appName || !Number.isFinite(seconds) || seconds <= 0) {
    console.error(
      'migrate: DATABASE_URL, DOOP_MIGRATE_APP_NAME and a positive DOOP_MIGRATE_DEADLINE_SECONDS are required',
    )
    process.exit(2)
  }
  runMigrations({ url, appName, deadlineMs: seconds * 1000 }).then(
    () => process.exit(0),
    (err) => {
      console.error('migrate failed:', err)
      process.exit(1)
    },
  )
}
