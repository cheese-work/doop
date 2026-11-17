import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/* CHE-6627 / G2: an agent on an issue's page cannot create its first design frame until the recon is
   complete: every cell of the scan-derived screen x state x device matrix has a real image (or a
   scan-proven n/a), the issue carries the agent's confirmation comment for this exact recon, and the
   recon frame is locked. Test cases (a)-(f) are r5's. */
vi.mock('../server/db/persist.ts', () => {
  const noop = () => undefined
  return {
    deleteCanvas: noop,
    deleteFrame: noop,
    deleteGuideline: noop,
    deleteMember: noop,
    deleteReference: noop,
    saveActivity: noop,
    saveCanvas: noop,
    saveCanvasCopy: noop,
    saveFeedback: noop,
    saveFrame: noop,
    appendPageAuthor: noop,
    saveFrameVersion: noop,
    saveGuideline: noop,
    saveMember: noop,
    savePageCopy: noop,
    saveReference: noop,
    saveTask: noop,
  }
})
vi.mock('../server/resident.ts', () => ({ onFeedback: () => {} }))

import { reconManifestHash, setReconSources, warmReconEvidence, type AssetFacts } from '../server/reconGuard.ts'
import { expectedCells, hashScan, scanSources, type ReconScan } from '../server/reconScan.ts'
import { store } from '../server/store.ts'
import { PolicyRefused, systemContext, type WriteContext } from '../server/writePolicy.ts'
import { canvasPages } from '../shared/pages.ts'

const ISSUE = '01a1d642-a8dd-75cd-886c-97d80b9e0048'
const PROJECT = 'proj-a'
const MAIN_SHA = 'abc1234'
const sys = systemContext()
const agent: WriteContext = {
  kind: 'agent',
  taskId: 'task-a',
  agentId: 'agent-1',
  issueId: ISSUE,
  projectId: PROJECT,
  verified: true,
}

const SELECT = '<Select value={sort}>'
const SRC = (selectLine: string) => ({
  'v/screen.tsx': [
    selectLine,
    '  <SelectItem value="newest">Newest first</SelectItem>',
    '  <SelectItem value="oldest">Oldest first</SelectItem>',
    '</Select>',
    '<DropdownMenu></DropdownMenu>',
  ].join('\n'),
})

type Cell = { screen: string; device: number; candidate?: string; state?: string; asset?: string | null; na?: unknown }
type TestRecon = {
  scanHash: string
  mainSha: string
  scan: ReconScan
  candidates: { id: string; file: string; line: number; decision: string; reason?: string }[]
  matrix: Cell[]
}
type Opts = {
  selectLine?: string
  /** edit the generated recon before it is written */
  tweak?: (recon: TestRecon) => void
  assetFacts?: (cell: Cell, facts: AssetFacts) => AssetFacts | undefined
  comment?: false | ((hash: string, frameId: string, images: number) => string)
  commentAgent?: string
  commentAfterWrite?: boolean
  lock?: boolean
}

/** a bound canvas whose page belongs to ISSUE, a recon frame written for it, and the evidence Multica would serve */
async function setup(opts: Opts = {}) {
  const canvas = store.createCanvas('Multica', 'alice')
  const page = canvasPages(canvas)[0]!.id
  store.setPageIssue(canvas.id, page, ISSUE, 'member')
  store.bindProject(sys, canvas.id, PROJECT)
  const scan = scanSources(SRC(opts.selectLine ?? SELECT), ['v/screen.tsx'])
  const cells = expectedCells(scan)
  const recon: TestRecon = {
    scanHash: hashScan(scan),
    mainSha: MAIN_SHA,
    scan,
    candidates: scan.candidates.map((c) => ({ id: c.id, file: c.file, line: c.line, decision: 'keep' })),
    matrix: cells.map((c, i): Cell => ({
      screen: c.screen,
      device: c.device,
      candidate: c.candidate,
      state: c.state,
      asset: `img-${i}`,
    })),
  }
  opts.tweak?.(recon)
  const body = JSON.stringify(recon)
  const html = `<script type="application/json" id="doop-recon">${body}</script>`
  /* the recon frame itself is allowed before any recon exists */
  const frame = store.createFrame(agent, canvas.id, { name: 'Recon', pageId: page, html }, 'agent-1')!
  if (opts.lock !== false) store.updateFrame(sys, frame.id, { locked: true }, 'x')

  const facts = new Map<string, AssetFacts>()
  for (const cell of recon.matrix) {
    if (!cell.asset) continue
    const ok: AssetFacts = {
      bytes: 100,
      width: cell.device,
      hash: createHash('sha256').update(String(cell.asset)).digest('hex'),
    }
    const f = opts.assetFacts ? opts.assetFacts(cell, ok) : ok
    if (f) facts.set(cell.asset, f)
  }
  const applicable = recon.matrix.filter((c) => c.asset).length
  const now = Date.now()
  const comments =
    opts.comment === false
      ? []
      : [
          {
            agentId: opts.commentAgent ?? 'agent-1',
            at: opts.commentAfterWrite ? now + 60_000 : now - 1000,
            body: (
              opts.comment ??
              ((h, f, n) => `recon frame ${f}\nrecon-manifest: sha256=${h}\nmain-sha: ${MAIN_SHA}\nrecon-images: ${n}`)
            )(reconManifestHash(body), frame.id, applicable),
          },
        ]
  setReconSources({ assets: async (id) => facts.get(id), comments: async () => comments })
  await warmReconEvidence(canvas, page, agent)
  return { canvas, page, frame, recon }
}

const draw = (f: { canvas: { id: string }; page: string }, ctx: WriteContext = agent) =>
  store.createFrame(ctx, f.canvas.id, { name: 'Design', pageId: f.page, html: '<p>design</p>' }, 'agent-1')
const refused = (f: Awaited<ReturnType<typeof setup>>, pattern: RegExp) =>
  expect(() => draw(f)).toThrow(
    expect.objectContaining({ code: 'policy_refused', message: expect.stringMatching(pattern) }),
  )

beforeEach(() => {
  for (const canvas of store.allCanvases()) store.deleteCanvas(sys, canvas.id)
  setReconSources(undefined)
})

describe('G2 recon guard', () => {
  it('(a) every image missing -> policy_refused', async () => {
    const f = await setup({ tweak: (r) => r.matrix.forEach((c) => (c.asset = null)) })
    refused(f, /image/)
  })

  it('(b) all cells but one sort value -> policy_refused', async () => {
    const f = await setup({
      tweak: (r) => {
        r.matrix = r.matrix.filter((c) => !(c.state === 'oldest' && c.device === 1440))
      },
    })
    refused(f, /missing cell.*oldest/)
  })

  it('(c) an empty asset, a wrong-sized one, or one image reused for two cells -> policy_refused', async () => {
    refused(await setup({ assetFacts: (_c, facts) => ({ ...facts, bytes: 0 }) }), /empty/)
    refused(await setup({ assetFacts: (c, facts) => ({ ...facts, width: c.device + 1 }) }), /width/)
    refused(await setup({ assetFacts: (_c, facts) => ({ ...facts, hash: 'same' }) }), /same image/)
    refused(await setup({ assetFacts: (c, facts) => (c.state === 'oldest' ? undefined : facts) }), /not uploaded/)
  })

  it('(d) n/a without scan evidence -> policy_refused; n/a the scan proves -> ok', async () => {
    const hidden = '<Select className="hidden md:block" value={sort}>'
    const naOn = (evidence: (cand: { file: string; line: number }) => unknown) => (r: TestRecon) => {
      for (const c of r.matrix)
        if (c.candidate?.endsWith(':select') && c.device === 390) {
          c.asset = null
          c.na = evidence({ file: 'v/screen.tsx', line: 1 })
        }
    }
    /* the select exists on both devices: nothing proves the 390 cells away */
    refused(await setup({ tweak: naOn(() => ({ file: 'v/screen.tsx', line: 1, reason: 'not shown' })) }), /n\/a/)
    /* hidden below md in the source, but the cell carries no evidence */
    refused(await setup({ selectLine: hidden, tweak: naOn(() => undefined) }), /n\/a/)
    /* evidence pointing at the wrong line */
    refused(
      await setup({ selectLine: hidden, tweak: naOn(() => ({ file: 'v/screen.tsx', line: 9, reason: 'x' })) }),
      /n\/a/,
    )
    const ok = await setup({ selectLine: hidden, tweak: naOn((c) => ({ ...c, reason: 'hidden below md' })) })
    expect(draw(ok)).toBeTruthy()
  })

  it('(e) full matrix, a comment with this recon hash, a locked recon frame -> ok', async () => {
    const f = await setup()
    const frame = draw(f)
    expect(frame?.name).toBe('Design')
  })

  it('(f) recon edited after the comment -> policy_refused', async () => {
    const f = await setup()
    const html = f.frame.html.replace('"decision":"keep"', '"decision":"remove","reason":"x"')
    store.updateFrame(sys, f.frame.id, { html }, 'x')
    refused(f, /hash/)
  })

  it('refuses when the issue has no confirmation comment, or it is another agent’s, later than the write, wrong in a field', async () => {
    refused(await setup({ comment: false }), /comment/)
    refused(await setup({ commentAgent: 'agent-2' }), /comment/)
    refused(await setup({ commentAfterWrite: true }), /comment/)
    refused(
      await setup({ comment: (h, f, n) => `${f}\nrecon-manifest: sha256=${h}\nmain-sha: other\nrecon-images: ${n}` }),
      /main-sha/,
    )
    refused(
      await setup({
        comment: (h, f, n) => `${f}\nrecon-manifest: sha256=${h}\nmain-sha: ${MAIN_SHA}\nrecon-images: ${n - 1}`,
      }),
      /images/,
    )
    refused(
      await setup({ comment: (h, _f, n) => `recon-manifest: sha256=${h}\nmain-sha: ${MAIN_SHA}\nrecon-images: ${n}` }),
      /frame/,
    )
  })

  it('refuses while the recon frame is not locked', async () => {
    refused(await setup({ lock: false }), /lock/)
  })

  it('refuses a page with no recon frame, and when the scan hash does not match the scan or a candidate has no decision', async () => {
    const canvas = store.createCanvas('Multica', 'alice')
    const page = canvasPages(canvas)[0]!.id
    store.setPageIssue(canvas.id, page, ISSUE, 'member')
    store.bindProject(sys, canvas.id, PROJECT)
    setReconSources({ assets: async () => undefined, comments: async () => [] })
    await warmReconEvidence(canvas, page, agent)
    refused({ canvas, page } as never, /recon frame/)
    refused(await setup({ tweak: (r) => (r.scanHash = 'f'.repeat(64)) }), /scan hash/)
    refused(await setup({ tweak: (r) => r.candidates.pop() }), /decision/)
  })

  it('fails closed when no evidence source is plugged in, or the evidence was never warmed', async () => {
    const f = await setup()
    setReconSources(undefined)
    await warmReconEvidence(f.canvas, f.page, agent)
    refused(f, /comment|image|evidence/)
  })

  it('does not hold a user, the system, or a page with no issue', async () => {
    const f = await setup({ comment: false })
    expect(draw(f, { kind: 'user', userId: 'cheese' })).toBeTruthy()
    expect(draw(f, sys)).toBeTruthy()
    const plain = store.createCanvas('Scratch', 'alice')
    expect(store.createFrame({ kind: 'agent' }, plain.id, { name: 'x' }, 'a')).toBeTruthy()
  })

  it('PolicyRefused is the error type', async () => {
    const f = await setup({ comment: false })
    expect(() => draw(f)).toThrow(PolicyRefused)
  })

  /* Terra's P1: the exemption is for a frame that IS the recon, not for any HTML that carries one */
  it('exempts only a recon-only frame: a design with a doop-recon script is refused', async () => {
    const canvas = store.createCanvas('Multica', 'alice')
    const page = canvasPages(canvas)[0]!.id
    store.setPageIssue(canvas.id, page, ISSUE, 'member')
    store.bindProject(sys, canvas.id, PROJECT)
    setReconSources({ assets: async () => undefined, comments: async () => [] })
    await warmReconEvidence(canvas, page, agent)
    const RECON = '<script type="application/json" id="doop-recon">{}</script>'
    const make = (html: string) => () =>
      store.createFrame(agent, canvas.id, { name: 'x', pageId: page, html }, 'agent-1')
    for (const html of [
      `<div>design</div>${RECON}`,
      `${RECON}<section><h1>Pricing</h1></section>`,
      `${RECON}Pricing`,
      `<style>body{color:red}</style>${RECON}`,
      `${RECON}<script>document.body.append('design')</script>`,
      `${RECON}${RECON}`,
    ])
      expect(make(html), html).toThrow(PolicyRefused)
    expect(make(`<!doctype html><html><head><meta charset="utf-8"></head><body>${RECON}</body></html>`)).not.toThrow()
  })
})
