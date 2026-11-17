import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

/* CHE-7082 (S3 of CHE-7064): the append-only page author ledger. Every frame write appends
   the writer's row to `page_authors` in the same tick, after assertWritable and before the frame
   save is queued. Real store, real persistence layer, temporary pglite. */
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doop-pageauthors-'))
const cwd = process.cwd()
process.chdir(dir)
const dbm = await import('../server/db/index.ts')
const t = await import('../server/db/schema.ts')
const persist = await import('../server/db/persist.ts')
await dbm.initDb()
process.chdir(cwd)
vi.mock('../server/resident.ts', () => ({ onFeedback: () => {} }))
const { store } = await import('../server/store.ts')
const { PolicyRefused, systemContext } = await import('../server/writePolicy.ts')
const { canvasPages } = await import('../shared/pages.ts')
const { eq } = await import('drizzle-orm')
import type { WriteContext } from '../server/writePolicy.ts'

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

const ISSUE_A = '01a1d642-a8dd-75cd-886c-97d80b9e0048'
const ISSUE_B = '01a1d675-5861-786e-8567-3a074a37c386'
const sys = systemContext()
const agentA: WriteContext = {
  kind: 'agent',
  taskId: 'task-a',
  agentId: 'agent-1',
  issueId: ISSUE_A,
  projectId: 'proj-a',
  provider: 'anthropic',
  model: 'claude-opus',
  verified: true,
}
const user: WriteContext = { kind: 'user', userId: 'cheese' }
/** the one frame G2 lets an agent create on a page bound to an issue before its recon is done */
const RECON_HTML = '<script type="application/json" id="doop-recon">{}</script>'

/** a canvas bound to proj-a: page A belongs to ISSUE_A, page B to ISSUE_B */
function bound() {
  const canvas = store.createCanvas('Ledger', 'alice')
  const first = canvasPages(canvas)[0]!
  store.setPages(sys, canvas.id, [first, { id: 'pb', name: 'B' }])
  store.setPageIssue(canvas.id, first.id, ISSUE_A, 'member')
  store.setPageIssue(canvas.id, 'pb', ISSUE_B, 'member')
  store.bindProject(sys, canvas.id, 'proj-a')
  return { canvas, pa: first.id, pb: 'pb' }
}

const rows = async (canvasId: string, pageId?: string) => {
  await persist.settlePageAuthors()
  // Rows written in the same millisecond tie on first_at, so pin an order the tests can rely on.
  const list = await persist.listPageAuthors(canvasId, pageId)
  return [...list].sort((a, b) => `${a.kind}/${a.taskId}`.localeCompare(`${b.kind}/${b.taskId}`))
}
const brief = (list: Awaited<ReturnType<typeof rows>>) =>
  list.map((r) => ({ kind: r.kind, agentId: r.agentId, taskId: r.taskId, userId: r.userId, source: r.source }))

beforeEach(() => {
  for (const canvas of store.allCanvases()) store.deleteCanvas(sys, canvas.id)
})

describe('one row per writer on every frame mutator', () => {
  it('createFrame appends the writer to the frame page', async () => {
    const { canvas, pa } = bound()
    const frame = store.createFrame(agentA, canvas.id, { name: 'f', pageId: pa, html: RECON_HTML }, 'agent')!
    expect(brief(await rows(canvas.id, pa))).toEqual([
      { kind: 'agent', agentId: 'agent-1', taskId: 'task-a', userId: '', source: 'write' },
    ])
    expect((await rows(canvas.id, pa))[0]).toMatchObject({
      frameId: frame.id,
      provider: 'anthropic',
      model: 'claude-opus',
    })
  })

  it('updateFrame appends the writer, for any field', async () => {
    const c = store.createCanvas('Ledger', 'alice')
    const page = canvasPages(c)[0]!.id
    const frame = store.createFrame(sys, c.id, { name: 'f', html: '<p/>' }, 'x')!
    store.updateFrame(user, frame.id, { name: 'renamed' }, 'cheese')
    expect(brief(await rows(c.id, page))).toEqual([
      { kind: 'system', agentId: '', taskId: '', userId: '', source: 'write' },
      { kind: 'user', agentId: '', taskId: '', userId: 'cheese', source: 'write' },
    ])
  })

  it('deleteFrame appends the writer to the page the frame was on', async () => {
    const c = store.createCanvas('Ledger', 'alice')
    const page = canvasPages(c)[0]!.id
    const frame = store.createFrame(sys, c.id, { name: 'f', html: '<p/>' }, 'x')!
    store.deleteFrame(user, frame.id)
    expect(brief(await rows(c.id, page)).map((r) => r.kind)).toEqual(['system', 'user'])
  })

  it('a frame moved to another page puts the writer on both pages', async () => {
    const c = store.createCanvas('Ledger', 'alice')
    store.setPages(sys, c.id, [canvasPages(c)[0]!, { id: 'p2', name: 'P2' }])
    const page = canvasPages(c)[0]!.id
    const frame = store.createFrame(sys, c.id, { name: 'f', html: '<p/>' }, 'x')!
    store.updateFrame(user, frame.id, { pageId: 'p2' }, 'cheese')
    expect((await rows(c.id, page)).map((r) => r.kind)).toEqual(['system', 'user'])
    expect((await rows(c.id, 'p2')).map((r) => r.kind)).toEqual(['user'])
  })

  it('the same writer twice is one row; a second task is a second row', async () => {
    const { canvas, pa } = bound()
    const frame = store.createFrame(agentA, canvas.id, { name: 'f', pageId: pa, html: RECON_HTML }, 'agent')!
    store.updateFrame(agentA, frame.id, { html: '<p>2</p>' }, 'agent')
    store.updateFrame({ ...agentA, taskId: 'task-a2' }, frame.id, { html: '<p>3</p>' }, 'agent')
    expect((await rows(canvas.id, pa)).map((r) => r.taskId)).toEqual(['task-a', 'task-a2'])
  })

  it('an agent that only claims a task id is refused and leaves no row', async () => {
    const c = store.createCanvas('Ledger', 'alice')
    const claimed: WriteContext = { kind: 'agent', taskId: 'claimed-task', agentId: 'claimed-agent' }
    expect(() => store.createFrame(claimed, c.id, { name: 'f', html: RECON_HTML }, 'agent')).toThrow(PolicyRefused)
    expect(await rows(c.id)).toEqual([])
  })

  it('a refused write leaves no row', async () => {
    const { canvas, pb } = bound()
    expect(() => store.createFrame(agentA, canvas.id, { name: 'f', pageId: pb, html: '<p/>' }, 'agent')).toThrow(
      PolicyRefused,
    )
    expect(await rows(canvas.id)).toEqual([])
  })
})

describe('the kind comes from the write context, never from the client', () => {
  const cases: [string, WriteContext, { kind: string; agentId: string; taskId: string; userId: string }][] = [
    ['agent with a verified task', agentA, { kind: 'agent', agentId: 'agent-1', taskId: 'task-a', userId: '' }],
    ['signed-in member', user, { kind: 'user', agentId: '', taskId: '', userId: 'cheese' }],
    ['the server itself', sys, { kind: 'system', agentId: '', taskId: '', userId: '' }],
    [
      'agent over MCP with no task (only possible on an unbound canvas)',
      { kind: 'agent', origin: 'mcp' },
      { kind: 'unknown', agentId: '', taskId: '', userId: '' },
    ],
    ['agent with no task', { kind: 'agent' }, { kind: 'unknown', agentId: '', taskId: '', userId: '' }],
    [
      'verified flag without agent or task ids',
      { kind: 'agent', verified: true },
      { kind: 'unknown', agentId: '', taskId: '', userId: '' },
    ],
  ]
  for (const [name, ctx, want] of cases) {
    it(name, async () => {
      const c = store.createCanvas('Ledger', 'alice')
      const page = canvasPages(c)[0]!.id
      if (ctx.kind === 'agent' && ctx.verified && ctx.agentId) {
        store.setPageIssue(c.id, page, ISSUE_A, 'member')
        store.bindProject(sys, c.id, 'proj-a')
      }
      store.createFrame(ctx, c.id, { name: 'f', html: RECON_HTML }, 'x')
      expect(brief(await rows(c.id, page))).toEqual([{ ...want, source: 'write' }])
    })
  }
})

describe('the row is persisted no later than the frame', () => {
  it('createFrame: the moment the frame row is readable, the ledger row is', async () => {
    const c = store.createCanvas('Ledger', 'alice')
    const frame = store.createFrame(user, c.id, { name: 'f', html: '<p/>' }, 'cheese')!
    for (let i = 0; i < 200; i++) {
      const [row] = await dbm.db.select().from(t.frames).where(eq(t.frames.id, frame.id))
      if (row) break
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    expect(await dbm.db.select().from(t.frames).where(eq(t.frames.id, frame.id))).toHaveLength(1)
    expect(await dbm.db.select().from(t.pageAuthors).where(eq(t.pageAuthors.canvasId, c.id))).toHaveLength(1)
  })

  it('updateFrame: a flush writes the frame and its ledger row', async () => {
    const c = store.createCanvas('Ledger', 'alice')
    const frame = store.createFrame(sys, c.id, { name: 'f', html: '<p/>' }, 'x')!
    store.updateFrame(user, frame.id, { html: '<p>edited</p>' }, 'cheese')
    await persist.flush((id) => store.getFrame(id))
    const [saved] = await dbm.db.select().from(t.frames).where(eq(t.frames.id, frame.id))
    expect(saved?.html).toBe('<p>edited</p>')
    const list = await dbm.db.select().from(t.pageAuthors).where(eq(t.pageAuthors.canvasId, c.id))
    expect(list.map((r) => r.kind).sort()).toEqual(['system', 'user'])
  })
})

describe('boot backfill', () => {
  it('gives each page that holds frames and has no row one legacy unknown row, once', async () => {
    const c = store.createCanvas('Legacy', 'alice')
    store.setPages(sys, c.id, [canvasPages(c)[0]!, { id: 'p2', name: 'P2' }, { id: 'p3', name: 'P3' }])
    const [p1] = canvasPages(c)
    store.createFrame(sys, c.id, { name: 'a', pageId: p1!.id, html: '<p/>' }, 'x')
    store.createFrame(sys, c.id, { name: 'b', pageId: 'p2', html: '<p/>' }, 'x')
    await persist.settlePageAuthors()
    // the pre-ledger state: p1 has no row, p2 keeps its own, p3 is empty
    await dbm.db.delete(t.pageAuthors).where(eq(t.pageAuthors.pageId, p1!.id))

    expect(await persist.backfillPageAuthors([c])).toBe(1)
    expect(brief(await rows(c.id, p1!.id))).toEqual([
      { kind: 'unknown', agentId: '', taskId: '', userId: '', source: 'legacy' },
    ])
    expect(brief(await rows(c.id, 'p2')).map((r) => r.source)).toEqual(['write'])
    expect(await rows(c.id, 'p3')).toEqual([])

    expect(await persist.backfillPageAuthors([c])).toBe(0)
    expect(await rows(c.id)).toHaveLength(2)
  })

  it('a frame with no page id counts for the first page', async () => {
    const c = store.createCanvas('Legacy', 'alice')
    const frame = store.createFrame(sys, c.id, { name: 'a', html: '<p/>' }, 'x')!
    await persist.settlePageAuthors()
    await dbm.db.delete(t.pageAuthors).where(eq(t.pageAuthors.canvasId, c.id))
    delete (frame as { pageId?: string }).pageId
    expect(await persist.backfillPageAuthors([c])).toBe(1)
    expect((await rows(c.id))[0]).toMatchObject({ pageId: canvasPages(c)[0]!.id, kind: 'unknown', source: 'legacy' })
  })
})

describe('writePolicy scan: only the store and persistence append to page_authors', () => {
  const walk = async (dirPath: string, out: string[] = []) => {
    for (const name of fs.readdirSync(dirPath)) {
      const full = path.join(dirPath, name)
      if (fs.statSync(full).isDirectory()) await walk(full, out)
      else if (/\.(ts|tsx)$/.test(name)) out.push(full)
    }
    return out
  }
  const ledgerWrite = [/\bpersist\.(appendPageAuthor|backfillPageAuthors)\b/, /\bpageAuthors\b/, /\bpage_authors\b/]
  const allowed = new Set([
    path.join('server', 'store.ts'),
    path.join('server', 'db', 'persist.ts'),
    path.join('server', 'db', 'schema.ts'),
  ])

  it('no other server file touches the ledger', async () => {
    const offenders = (await walk('server'))
      .filter((file) => !allowed.has(file))
      .filter((file) => ledgerWrite.some((pattern) => pattern.test(fs.readFileSync(file, 'utf8'))))
    expect(offenders).toEqual([])
  })

  it('the scan really sees a writer: the store appends and persistence owns the table', () => {
    expect(/\bpersist\.appendPageAuthor\b/.test(fs.readFileSync('server/store.ts', 'utf8'))).toBe(true)
    expect(/\bpageAuthors\b/.test(fs.readFileSync('server/db/persist.ts', 'utf8'))).toBe(true)
    expect(ledgerWrite.some((pattern) => pattern.test('persist.appendPageAuthor(row)'))).toBe(true)
  })
})
