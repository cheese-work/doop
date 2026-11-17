import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

/* CHE-7082 review round 1: a writer row and the frame state it describes become durable together.
   A failed ledger insert must keep the frame mutation out of the database until the row lands, and an
   update or delete arriving while a save is in flight must not leave a frame state without its writer. */
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doop-pageauthors-fail-'))
const cwd = process.cwd()
process.chdir(dir)
const dbm = await import('../server/db/index.ts')
const t = await import('../server/db/schema.ts')
const persist = await import('../server/db/persist.ts')
await dbm.initDb()
process.chdir(cwd)
vi.mock('../server/resident.ts', () => ({ onFeedback: () => {} }))
const { store } = await import('../server/store.ts')
const { systemContext } = await import('../server/writePolicy.ts')
const { canvasPages } = await import('../shared/pages.ts')
const { eq, sql } = await import('drizzle-orm')
import type { WriteContext } from '../server/writePolicy.ts'

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

const sys = systemContext()
const who = (userId: string): WriteContext => ({ kind: 'user', userId })
const flush = () => persist.flush((id) => store.getFrame(id))
const frameHtml = async (id: string) =>
  (await dbm.db.select().from(t.frames).where(eq(t.frames.id, id))).map((row) => row.html)
const userRows = async (canvasId: string) =>
  (await dbm.db.select().from(t.pageAuthors).where(eq(t.pageAuthors.canvasId, canvasId))).map((row) => row.userId)

/** a trigger that makes the ledger insert of one task fail or stall inside the database */
async function trap(userId: string, body: string) {
  await dbm.db.execute(
    sql.raw(`create or replace function trap_${userId.replace(/\W/g, '_')}() returns trigger as $$
    begin if new.user_id = '${userId}' then ${body} end if; return new; end $$ language plpgsql`),
  )
  await dbm.db.execute(
    sql.raw(
      `create trigger trap_${userId.replace(/\W/g, '_')} before insert on page_authors for each row execute function trap_${userId.replace(/\W/g, '_')}()`,
    ),
  )
}
const untrap = (userId: string) =>
  dbm.db.execute(sql.raw(`drop trigger if exists trap_${userId.replace(/\W/g, '_')} on page_authors`))

function fresh() {
  const canvas = store.createCanvas('Failure', 'alice')
  const pageId = canvasPages(canvas)[0]!.id
  const frame = store.createFrame(sys, canvas.id, { name: 'f', pageId, html: 'v0' }, 'x')!
  return { canvas, frame }
}

describe('a failed ledger insert never leaves the frame durable without its writer', () => {
  it('holds the frame mutation back, then lands both on the next write', async () => {
    const { canvas, frame } = fresh()
    await flush()
    await trap('u-fail', "raise exception 'ledger down';")
    vi.spyOn(console, 'error').mockImplementation(() => {})

    store.updateFrame(who('u-fail'), frame.id, { html: 'v1' }, 'x')
    await flush()
    expect(await userRows(canvas.id)).not.toContain('u-fail')
    expect(await frameHtml(frame.id)).toEqual(['v0'])

    /* a later write by a writer the ledger already holds must not hide the failure */
    store.updateFrame(sys, frame.id, { name: 'renamed' }, 'x')
    await flush()
    expect(await userRows(canvas.id)).not.toContain('u-fail')
    expect(await frameHtml(frame.id)).toEqual(['v0'])

    await untrap('u-fail')
    await flush()
    expect(await userRows(canvas.id)).toContain('u-fail')
    expect(await frameHtml(frame.id)).toEqual(['v1'])
  })

  it('keeps the writer of a delete when its insert fails, and lands it on the next flush', async () => {
    const { canvas, frame } = fresh()
    await flush()
    await trap('u-del', "raise exception 'ledger down';")
    store.deleteFrame(who('u-del'), frame.id)
    await flush()
    expect(await userRows(canvas.id)).not.toContain('u-del')
    expect(await frameHtml(frame.id)).toEqual(['v0'])

    await untrap('u-del')
    await flush()
    expect(await userRows(canvas.id)).toContain('u-del')
    expect(await frameHtml(frame.id)).toEqual([])
  })
})

describe('an update during an in-flight save', () => {
  it('never persists a frame state before the writer row of that state', async () => {
    const { canvas, frame } = fresh()
    await flush()
    await trap('u-slow', 'perform pg_sleep(0.3);')
    await trap('u-late', 'perform pg_sleep(0.3);')

    store.updateFrame(who('u-slow'), frame.id, { html: 'v1' }, 'x')
    const done = flush()
    store.updateFrame(who('u-late'), frame.id, { html: 'v2' }, 'x')
    let stop = false
    const finished = done.then(() => flush()).finally(() => (stop = true))
    const violations: string[] = []
    while (!stop) {
      const [html] = await frameHtml(frame.id)
      const rows = await userRows(canvas.id)
      if (html === 'v1' && !rows.includes('u-slow')) violations.push('v1 without task-slow')
      if (html === 'v2' && !rows.includes('u-late')) violations.push('v2 without task-late')
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    await finished
    expect(violations).toEqual([])
    expect(await frameHtml(frame.id)).toEqual(['v2'])
    expect(await userRows(canvas.id)).toEqual(expect.arrayContaining(['u-slow', 'u-late']))
  })

  it('a delete behind a pending update keeps both writers', async () => {
    const { canvas, frame } = fresh()
    store.updateFrame(who('u-u'), frame.id, { html: 'v1' }, 'x')
    store.deleteFrame(who('u-d'), frame.id)
    await flush()
    expect(await frameHtml(frame.id)).toEqual([])
    expect(await userRows(canvas.id)).toEqual(expect.arrayContaining(['u-u', 'u-d']))
  })
})

/* pglite runs on the main thread, so a SQL sleep would freeze the test too: delay the transaction in JS. */
const delayTransaction = (ms: number, failFirst = false) => {
  const real = dbm.db.transaction.bind(dbm.db)
  let failed = !failFirst
  return vi.spyOn(dbm.db, 'transaction').mockImplementation(async (...args: Parameters<typeof real>) => {
    await new Promise((resolve) => setTimeout(resolve, ms))
    if (!failed) {
      failed = true
      throw new Error('commit failed')
    }
    return real(...args)
  })
}

describe('shutdown flush with a save already in flight', () => {
  it('does not return before an in-flight transaction commits', async () => {
    const { canvas, frame } = fresh()
    await flush()
    const spy = delayTransaction(300)
    store.updateFrame(who('u-inflight'), frame.id, { html: 'v1' }, 'x')
    const pending = flush() // starts the save: its job has taken the rows, no timer is left
    await new Promise((resolve) => setTimeout(resolve, 50))
    let finished = false
    await flush().then(() => (finished = true)) // a second flush (SIGTERM during a save)
    spy.mockRestore()
    expect(await userRows(canvas.id)).toContain('u-inflight') // it returned only after the commit
    expect(await frameHtml(frame.id)).toEqual(['v1'])
    expect(finished).toBe(true)
    await pending
  })

  it('retries a job that fails after the flush started', async () => {
    const { canvas, frame } = fresh()
    await flush()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const spy = delayTransaction(100, true)
    store.updateFrame(who('u-late-fail'), frame.id, { html: 'v1' }, 'x')
    const first = flush()
    await new Promise((resolve) => setTimeout(resolve, 20))
    const second = flush() // snapshots while the first job is still running, then fails
    await Promise.all([first, second])
    spy.mockRestore()
    expect(await userRows(canvas.id)).toContain('u-late-fail')
    expect(await frameHtml(frame.id)).toEqual(['v1'])
  })
})
