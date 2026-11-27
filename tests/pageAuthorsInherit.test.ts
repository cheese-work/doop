import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

/* CHE-7083 (S4 of CHE-7064): the author ledger travels with the content. A copy, a page move and a
   restore never lose the writers of the page they came from. Real store, real persistence layer,
   temporary pglite; every case goes through the real store mutators. */
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doop-pageauthors-inherit-'))
const cwd = process.cwd()
process.chdir(dir)
const dbm = await import('../server/db/index.ts')
const persist = await import('../server/db/persist.ts')
await dbm.initDb()
process.chdir(cwd)
vi.mock('../server/resident.ts', () => ({ onFeedback: () => {} }))
const { store } = await import('../server/store.ts')
const actions = await import('../server/actions.ts')
const { systemContext } = await import('../server/writePolicy.ts')
const { canvasPages } = await import('../shared/pages.ts')
import type { WriteContext } from '../server/writePolicy.ts'

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

const sys = systemContext()
const ISSUE_A = '01a1d642-a8dd-75cd-886c-97d80b9e0048'
const ISSUE_B = '01a1d675-5861-786e-8567-3a074a37c386'
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
const agentB: WriteContext = {
  ...agentA,
  taskId: 'task-b',
  agentId: 'agent-2',
  issueId: ISSUE_B,
  provider: 'openai',
  model: 'gpt',
}
const user: WriteContext = { kind: 'user', userId: 'cheese' }
/** the one frame G2 lets an agent create on a page bound to an issue before its recon is done */
const RECON_HTML = '<script type="application/json" id="doop-recon">{}</script>'
const NEW = { kind: 'new' } as const

const rows = async (canvasId: string, pageId: string) => {
  await persist.flush((id) => store.getFrame(id))
  const list = await persist.listPageAuthors(canvasId, pageId)
  return list
    .map((r) => ({
      kind: r.kind,
      agentId: r.agentId,
      taskId: r.taskId,
      userId: r.userId,
      source: r.source,
      sourcePageId: r.sourcePageId,
    }))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
}
const row = (
  kind: string,
  who: { agentId?: string; taskId?: string; userId?: string },
  source: string,
  sourcePageId = '',
) => ({ kind, agentId: '', taskId: '', userId: '', ...who, source, sourcePageId })
const sorted = (list: ReturnType<typeof row>[]) =>
  [...list].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))

const writtenByA = (source = 'write', sourcePageId = '') =>
  row('agent', { agentId: 'agent-1', taskId: 'task-a' }, source, sourcePageId)
const writtenByB = (source = 'write', sourcePageId = '') =>
  row('agent', { agentId: 'agent-2', taskId: 'task-b' }, source, sourcePageId)

/** a canvas with page one written by agent A and page two written by agent B */
function twoPages() {
  const canvas = store.createCanvas('Ledger', 'alice')
  const first = canvasPages(canvas)[0]!
  store.setPages(sys, canvas.id, [first, { id: 'pb', name: 'B' }])
  store.setPageIssue(canvas.id, first.id, ISSUE_A, 'member')
  store.setPageIssue(canvas.id, 'pb', ISSUE_B, 'member')
  store.bindProject(sys, canvas.id, 'proj-a')
  store.createFrame(agentA, canvas.id, { name: 'a', pageId: first.id, html: RECON_HTML }, 'agent', NEW)
  store.createFrame(agentB, canvas.id, { name: 'b', pageId: 'pb', html: RECON_HTML }, 'agent', NEW)
  return { canvas, pa: first.id, pb: 'pb' }
}

beforeEach(() => {
  for (const canvas of store.allCanvases()) store.deleteCanvas(sys, canvas.id)
})

describe('copy paths inherit the source page rows', () => {
  it('duplicatePage: the copy holds every source row as a copy, plus the copier', async () => {
    const { canvas, pa } = twoPages()
    const copy = await store.duplicatePage(user, canvas.id, pa, 'cheese')
    expect(copy).toBeTruthy()
    expect(await rows(canvas.id, copy!.page.id)).toEqual(
      sorted([writtenByA('copy', pa), row('user', { userId: 'cheese' }, 'write')]),
    )
    /* the source page is untouched */
    expect(await rows(canvas.id, pa)).toEqual([writtenByA()])
  })

  it('duplicatePage: a copy of a legacy page inherits unknown', async () => {
    const canvas = store.createCanvas('Legacy', 'alice')
    const first = canvasPages(canvas)[0]!
    store.createFrame(sys, canvas.id, { name: 'a', html: '<p/>' }, 'x', NEW)
    await persist.flush((id) => store.getFrame(id))
    /* the pre-ledger state: the page holds a frame but no row, so the boot backfill gives it one legacy row */
    await dbm.db.delete((await import('../server/db/schema.ts')).pageAuthors)
    expect(await persist.backfillPageAuthors([canvas])).toBe(1)
    const copy = await store.duplicatePage(sys, canvas.id, first.id, 'x')
    expect(await rows(canvas.id, copy!.page.id)).toEqual(
      sorted([row('unknown', {}, 'copy', first.id), row('system', {}, 'write')]),
    )
  })

  it('duplicateCanvas: each destination page gets the rows of its source page, plus the copier', async () => {
    const { canvas, pa, pb } = twoPages()
    const copy = await store.duplicateCanvas(user, canvas.id, 'bob', 'cheese')
    expect(copy).toBeTruthy()
    expect(await rows(copy!.id, pa)).toEqual(
      sorted([writtenByA('copy', pa), row('user', { userId: 'cheese' }, 'write')]),
    )
    expect(await rows(copy!.id, pb)).toEqual(
      sorted([writtenByB('copy', pb), row('user', { userId: 'cheese' }, 'write')]),
    )
    expect(await rows(canvas.id, pa)).toEqual([writtenByA()])
  })

  it('createFrame with origin copy: the frame page inherits the rows of the source pages', async () => {
    const { canvas, pa, pb } = twoPages()
    const target = store.createCanvas('Target', 'alice')
    const targetPage = canvasPages(target)[0]!.id
    store.createFrame(user, target.id, { name: 'pasted', html: '<p/>' }, 'cheese', {
      kind: 'copy',
      sourcePages: [
        { canvasId: canvas.id, pageId: pa },
        { canvasId: canvas.id, pageId: pb },
      ],
    })
    expect(await rows(target.id, targetPage)).toEqual(
      sorted([writtenByA('copy', pa), writtenByB('copy', pb), row('user', { userId: 'cheese' }, 'write')]),
    )
  })

  it('createFrame with origin new copies nothing', async () => {
    const { canvas, pa } = twoPages()
    store.createFrame(user, canvas.id, { name: 'fresh', pageId: pa, html: '<p/>' }, 'cheese', NEW)
    expect(await rows(canvas.id, pa)).toEqual(sorted([writtenByA(), row('user', { userId: 'cheese' }, 'write')]))
  })
})

describe('a page move', () => {
  it('copies the source page rows into the destination, and the writer lands on both pages', async () => {
    const { canvas, pa, pb } = twoPages()
    const frame = canvas.frames.find((f) => f.pageId === pa)!
    store.updateFrame(user, frame.id, { pageId: pb }, 'cheese')
    expect(await rows(canvas.id, pb)).toEqual(
      sorted([writtenByB(), writtenByA('copy', pa), row('user', { userId: 'cheese' }, 'write')]),
    )
    /* the source keeps its history and gains the mover */
    expect(await rows(canvas.id, pa)).toEqual(sorted([writtenByA(), row('user', { userId: 'cheese' }, 'write')]))
  })

  it('an edit that stays on the page copies nothing', async () => {
    const { canvas, pa, pb } = twoPages()
    const frame = canvas.frames.find((f) => f.pageId === pa)!
    store.updateFrame(user, frame.id, { html: '<p>edited</p>' }, 'cheese')
    expect(await rows(canvas.id, pb)).toEqual([writtenByB()])
  })
})

describe('restore paths add the restorer and keep earlier rows', () => {
  it('restoreFrameVersion', async () => {
    const { canvas, pa } = twoPages()
    const frame = canvas.frames.find((f) => f.pageId === pa)!
    store.updateFrame({ kind: 'user', userId: 'bob' }, frame.id, { html: '<p>b rewrite</p>' }, 'bob')
    persist.saveFrameVersion({
      id: 'v-a',
      frameId: frame.id,
      canvasId: canvas.id,
      html: '<p>a</p>',
      width: frame.width,
      height: frame.height,
      savedBy: 'agent',
      savedAt: Date.now(),
      htmlBytes: 8,
    })
    const [version] = await persist.listFrameVersions(frame.id)
    const actor = actions.resolveActor({ name: 'cheese', kind: 'user' })
    const restored = await actions.restoreFrameVersion(frame.id, version!.id, actor)
    expect(restored?.frame.html).toBe('<p>a</p>')
    /* the restorer joins; agent A (the first author) and bob (the rewrite) stay */
    expect(await rows(canvas.id, pa)).toEqual(
      sorted([writtenByA(), row('user', { userId: 'bob' }, 'write'), row('user', {}, 'write')]),
    )
  })

  it('the undo of a deleted frame (createFrame, origin new) keeps the page history', async () => {
    const { canvas, pa } = twoPages()
    const frame = canvas.frames.find((f) => f.pageId === pa)!
    store.deleteFrame(user, frame.id)
    store.createFrame(user, canvas.id, { name: frame.name, pageId: pa, html: frame.html }, 'cheese', NEW)
    expect(await rows(canvas.id, pa)).toEqual(sorted([writtenByA(), row('user', { userId: 'cheese' }, 'write')]))
  })
})
