import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

/* CHE-7084 (S5 of CHE-7064, plan r3 D1.5): the attestation view names who wrote the attested page.
   `authors` is the distinct ledger rows (page_authors) of that page plus every page bound to the
   same issue; `provenanceComplete` is true only for a non-empty set with no `unknown` or `system`
   row and with a task id and agent id on every agent row. Real store, real ledger, temporary pglite. */
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doop-attauthors-'))
const cwd = process.cwd()
process.chdir(dir)
const dbm = await import('../server/db/index.ts')
const persist = await import('../server/db/persist.ts')
await dbm.initDb()
process.chdir(cwd)
vi.mock('../server/resident.ts', () => ({ onFeedback: () => {} }))
const { store } = await import('../server/store.ts')
const { systemContext } = await import('../server/writePolicy.ts')
const { canvasPages } = await import('../shared/pages.ts')
const { readAttestation, readServiceAttestation } = await import('../server/designAttestations.ts')
import type { WriteContext } from '../server/writePolicy.ts'

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

const ISSUE_A = '01a1d642-a8dd-75cd-886c-97d80b9e0048'
const ISSUE_B = '01a1d675-5861-786e-8567-3a074a37c386'
const sys = systemContext()
const agent = (n: string, provider = 'anthropic', model = 'claude-opus'): WriteContext => ({
  kind: 'agent',
  taskId: `task-${n}`,
  agentId: `agent-${n}`,
  issueId: ISSUE_A,
  projectId: 'proj-a',
  provider,
  model,
  verified: true,
})
const designer = agent('1')
/** the ledger identity of `designer` */
const DESIGNER_ROW = {
  kind: 'agent' as const,
  agentId: 'agent-1',
  taskId: 'task-1',
  provider: 'anthropic',
  model: 'claude-opus',
}
const editor = agent('2', 'openai', 'gpt-5')
const user: WriteContext = { kind: 'user', userId: 'cheese' }
const RECON_HTML = '<script type="application/json" id="doop-recon">{}</script>'

/** a canvas bound to proj-a: page A belongs to ISSUE_A, page B to `issueB` */
function bound(issueB: string = ISSUE_B) {
  const canvas = store.createCanvas('Authors', 'alice')
  const first = canvasPages(canvas)[0]!
  store.setPages(sys, canvas.id, [first, { id: 'pb', name: 'B' }])
  store.setPageIssue(canvas.id, first.id, ISSUE_A, 'member')
  store.setPageIssue(canvas.id, 'pb', issueB, 'member')
  store.bindProject(sys, canvas.id, 'proj-a')
  return { canvas, pa: first.id, pb: 'pb' }
}

/** store one attestation run for a page, the way attestPage does, then return its id */
async function attest(canvasId: string, pageId: string, flush = true): Promise<string> {
  if (flush) await persist.flush((id) => store.getFrame(id))
  const runId = `run-${canvasId}-${pageId}`
  await persist.saveAttestationRows([
    {
      runId,
      canvasId,
      pageId,
      frameId: 'f-attested',
      frameUpdatedAt: 1,
      ruleset: 'g3-r7',
      scanHash: null,
      inputs: { recon: [], start: null },
      result: 'complete',
      missing: [],
      createdAt: 1,
      createdBy: 'tester',
    },
  ])
  return runId
}

const view = async (runId: string) => (await readAttestation(runId))!
const kinds = (v: Awaited<ReturnType<typeof view>>) => v.authors.map((a) => a.kind)

beforeEach(() => {
  for (const canvas of store.allCanvases()) store.deleteCanvas(sys, canvas.id)
})

describe('authors and provenanceComplete on the attestation view', () => {
  it('a single designer is complete, with the identity from the ledger', async () => {
    const { canvas, pa } = bound()
    store.createFrame(designer, canvas.id, { name: 'f', pageId: pa, html: RECON_HTML }, 'agent')
    const v = await view(await attest(canvas.id, pa))
    expect(v.authors).toEqual([
      {
        kind: 'agent',
        agentId: 'agent-1',
        taskId: 'task-1',
        userId: '',
        provider: 'anthropic',
        model: 'claude-opus',
        sources: ['write'],
      },
    ])
    expect(v.provenanceComplete).toBe(true)
  })

  it('a designer plus a metadata editor lists both and stays complete', async () => {
    const { canvas, pa } = bound()
    const frame = store.createFrame(designer, canvas.id, { name: 'f', pageId: pa, html: RECON_HTML }, 'agent')!
    store.updateFrame(editor, frame.id, { name: 'renamed' }, 'agent')
    store.updateFrame(user, frame.id, { name: 'renamed again' }, 'cheese')
    const v = await view(await attest(canvas.id, pa))
    expect(v.authors.map((a) => a.agentId || a.userId).sort()).toEqual(['agent-1', 'agent-2', 'cheese'])
    expect(v.authors.find((a) => a.agentId === 'agent-2')).toMatchObject({ provider: 'openai', model: 'gpt-5' })
    expect(v.provenanceComplete).toBe(true)
  })

  it('a copied page carries the source rows, listed once with both sources', async () => {
    const { canvas, pa, pb } = bound(ISSUE_A)
    store.createFrame(designer, canvas.id, { name: 'f', pageId: pa, html: RECON_HTML }, 'agent')
    /* what S4 does on a page copy: the destination gets a `copy` row for every source row */
    persist.appendPageAuthor({ canvasId: canvas.id, pageId: pb, ...DESIGNER_ROW, source: 'copy', sourcePageId: pa })
    const v = await view(await attest(canvas.id, pb))
    const first = v.authors.find((a) => a.agentId === 'agent-1')!
    expect(first.sources).toContain('copy')
    expect(v.authors.filter((a) => a.agentId === 'agent-1')).toHaveLength(1)
    expect(v.provenanceComplete).toBe(true)
  })

  it('a second page of the same issue adds its writers', async () => {
    const { canvas, pa, pb } = bound(ISSUE_A)
    store.createFrame(designer, canvas.id, { name: 'a', pageId: pa, html: RECON_HTML }, 'agent')
    store.createFrame(editor, canvas.id, { name: 'b', pageId: pb, html: RECON_HTML }, 'agent')
    const v = await view(await attest(canvas.id, pa))
    expect(v.authors.map((a) => a.agentId).sort()).toEqual(['agent-1', 'agent-2'])
  })

  it('a page of another issue adds none', async () => {
    const { canvas, pa, pb } = bound(ISSUE_B)
    store.createFrame(designer, canvas.id, { name: 'a', pageId: pa, html: RECON_HTML }, 'agent')
    store.createFrame({ ...editor, issueId: ISSUE_B }, canvas.id, { name: 'b', pageId: pb, html: RECON_HTML }, 'agent')
    const v = await view(await attest(canvas.id, pa))
    expect(v.authors.map((a) => a.agentId)).toEqual(['agent-1'])
  })

  it('a page of the same issue on another canvas counts too', async () => {
    const one = bound()
    const two = bound()
    store.createFrame(designer, one.canvas.id, { name: 'a', pageId: one.pa, html: RECON_HTML }, 'agent')
    store.createFrame(editor, two.canvas.id, { name: 'b', pageId: two.pa, html: RECON_HTML }, 'agent')
    const v = await view(await attest(one.canvas.id, one.pa))
    expect(v.authors.map((a) => a.agentId).sort()).toEqual(['agent-1', 'agent-2'])
  })

  it('a system row makes provenance incomplete', async () => {
    const { canvas, pa } = bound()
    store.createFrame(designer, canvas.id, { name: 'f', pageId: pa, html: RECON_HTML }, 'agent')
    store.createFrame(sys, canvas.id, { name: 'g', pageId: pa, html: '<p/>' }, 'x')
    const v = await view(await attest(canvas.id, pa))
    expect(kinds(v)).toContain('system')
    expect(v.provenanceComplete).toBe(false)
  })

  it('an unknown row, here a legacy page, makes provenance incomplete', async () => {
    const { canvas, pa } = bound()
    store.createFrame(designer, canvas.id, { name: 'f', pageId: pa, html: RECON_HTML }, 'agent')
    persist.appendPageAuthor({ canvasId: canvas.id, pageId: pa, kind: 'unknown', source: 'legacy' })
    const v = await view(await attest(canvas.id, pa))
    expect(kinds(v)).toContain('unknown')
    expect(v.provenanceComplete).toBe(false)
  })

  it('an unknown row on a second page of the same issue also fails closed', async () => {
    const { canvas, pa, pb } = bound(ISSUE_A)
    store.createFrame(designer, canvas.id, { name: 'f', pageId: pa, html: RECON_HTML }, 'agent')
    persist.appendPageAuthor({ canvasId: canvas.id, pageId: pb, kind: 'unknown', source: 'legacy' })
    expect((await view(await attest(canvas.id, pa))).provenanceComplete).toBe(false)
  })

  it('an agent row without a task id or agent id is incomplete', async () => {
    const { canvas, pa } = bound()
    persist.appendPageAuthor({ canvasId: canvas.id, pageId: pa, kind: 'agent', agentId: 'agent-9', source: 'write' })
    expect((await view(await attest(canvas.id, pa))).provenanceComplete).toBe(false)
  })

  it('an empty set is incomplete', async () => {
    const { canvas, pa } = bound()
    const v = await view(await attest(canvas.id, pa))
    expect(v.authors).toEqual([])
    expect(v.provenanceComplete).toBe(false)
  })

  it('an unbound page lists only its own rows', async () => {
    const canvas = store.createCanvas('Free', 'alice')
    const page = canvasPages(canvas)[0]!.id
    store.createFrame(user, canvas.id, { name: 'f', html: '<p/>' }, 'cheese')
    const v = await view(await attest(canvas.id, page))
    expect(kinds(v)).toEqual(['user'])
    expect(v.provenanceComplete).toBe(true)
  })

  it('a writer whose frame is not saved yet is still named', async () => {
    const { canvas, pa } = bound()
    store.createFrame(designer, canvas.id, { name: 'f', pageId: pa, html: RECON_HTML }, 'agent')
    store.createFrame(user, canvas.id, { name: 'g', pageId: pa, html: '<p/>' }, 'cheese')
    const v = await view(await attest(canvas.id, pa, false))
    expect(v.authors.map((a) => a.agentId || a.userId).sort()).toEqual(['agent-1', 'cheese'])
  })

  it('the service view carries the same fields', async () => {
    const { canvas, pa } = bound()
    store.createFrame(designer, canvas.id, { name: 'f', pageId: pa, html: RECON_HTML }, 'agent')
    const runId = await attest(canvas.id, pa)
    const service = (await readServiceAttestation(runId))!
    expect(service.pageIssueId).toBe(ISSUE_A)
    expect(service.authors).toEqual((await view(runId)).authors)
    expect(service.provenanceComplete).toBe(true)
  })
})
