import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../server/db/persist.ts', () => {
  const noop = () => undefined
  return {
    deleteCanvas: noop,
    deleteFrame: noop,
    deleteGuideline: noop,
    deleteMember: noop,
    deleteReference: noop,
    saveCanvas: noop,
    saveCanvasCopy: noop,
    saveFrame: noop,
    saveGuideline: noop,
    savePageCopy: noop,
    saveDeletedPages: noop,
    saveMember: noop,
    saveReference: noop,
  }
})
import {
  httpDesignIssueSource,
  multicaDesignIssueSource,
  resetDesignLinkFreshness,
  syncAllDesignLinks,
  syncCanvasDesignLinks,
  type DesignIssueSource,
} from '../server/designLinkSync.ts'
import { store } from '../server/store.ts'
import { systemContext } from '../server/writePolicy.ts'
import { resolvePageIssue } from '../shared/pageIssue.ts'
import { canvasPages } from '../shared/pages.ts'

/* CHE-10542: the runtime caller of store.applyDesignLinks. Issues come from Multica's read link only. */

const ISSUE_A = '01a1d642-a8dd-75cd-886c-97d80b9e0048'
const ISSUE_B = '01a1d675-5861-786e-8567-3a074a37c386'
const PROP = 'b73a1103-30d7-4f9b-9412-4edcd64f5232'
const CONFIG = { apiUrl: 'https://multica.test', token: 'tok', workspaceId: 'ws-1' }

beforeEach(() => {
  resetDesignLinkFreshness()
  for (const canvas of store.allCanvases()) store.deleteCanvas(systemContext(), canvas.id)
})

function twoPages() {
  const canvas = store.createCanvas('Bound', 'alice')
  const first = canvasPages(canvas)[0]!
  store.setPages(systemContext(), canvas.id, [first, { id: 'p2', name: 'Two' }])
  return { canvas, first }
}
const issueOf = (canvasId: string, pageId: string) =>
  resolvePageIssue(canvasPages(store.getCanvas(canvasId)!).find((p) => p.id === pageId))
const url = (canvasId: string, page: string) => `https://doop.example/c/${canvasId}?page=${page}`
/** a source that answers like Multica: the issues whose Design url contains the needle */
const sourceOf = (issues: { id: string; designUrl: string | null }[]): DesignIssueSource => ({
  issuesNaming: async (needle) => issues.filter((i) => i.designUrl?.includes(needle)),
})

describe('syncCanvasDesignLinks', () => {
  it('binds the page an issue Design url names', async () => {
    const { canvas, first } = twoPages()
    const source = sourceOf([{ id: ISSUE_A, designUrl: url(canvas.id, first.id) }])
    await syncCanvasDesignLinks(canvas.id, source)
    expect(issueOf(canvas.id, first.id)).toBe(ISSUE_A)
    expect(issueOf(canvas.id, 'p2')).toBeNull()
  })

  it('binds nothing when two issues name one page', async () => {
    const { canvas, first } = twoPages()
    const source = sourceOf([
      { id: ISSUE_A, designUrl: url(canvas.id, first.id) },
      { id: ISSUE_B, designUrl: url(canvas.id, first.id) },
    ])
    await syncCanvasDesignLinks(canvas.id, source)
    expect(issueOf(canvas.id, first.id)).toBeNull()
  })

  it('clears a design link whose URL went stale', async () => {
    const { canvas, first } = twoPages()
    await syncCanvasDesignLinks(canvas.id, sourceOf([{ id: ISSUE_A, designUrl: url(canvas.id, first.id) }]))
    expect(issueOf(canvas.id, first.id)).toBe(ISSUE_A)
    resetDesignLinkFreshness()
    /* the issue now names page 2, then names none */
    await syncCanvasDesignLinks(canvas.id, sourceOf([{ id: ISSUE_A, designUrl: url(canvas.id, 'p2') }]))
    expect(issueOf(canvas.id, first.id)).toBeNull()
    expect(issueOf(canvas.id, 'p2')).toBe(ISSUE_A)
    resetDesignLinkFreshness()
    await syncCanvasDesignLinks(canvas.id, sourceOf([]))
    expect(issueOf(canvas.id, 'p2')).toBeNull()
  })

  it('never changes a member link', async () => {
    const { canvas, first } = twoPages()
    store.setPageIssue(canvas.id, first.id, ISSUE_A, 'member')
    await syncCanvasDesignLinks(canvas.id, sourceOf([{ id: ISSUE_B, designUrl: url(canvas.id, first.id) }]))
    expect(issueOf(canvas.id, first.id)).toBe(ISSUE_A)
    resetDesignLinkFreshness()
    await syncCanvasDesignLinks(canvas.id, sourceOf([]))
    expect(issueOf(canvas.id, first.id)).toBe(ISSUE_A)
  })

  it('changes nothing when Multica is not configured', async () => {
    const { canvas, first } = twoPages()
    expect(multicaDesignIssueSource({})).toBeUndefined()
    expect(multicaDesignIssueSource({ MULTICA_API_URL: 'https://m.test', MULTICA_API_TOKEN: 't' })).toBeUndefined()
    store.applyDesignLinks(canvas.id, [{ id: ISSUE_A, designUrl: url(canvas.id, first.id) }])
    /* an unconfigured sync must not clear the existing design link either */
    expect(await syncCanvasDesignLinks(canvas.id, undefined)).toBe(false)
    expect(await syncAllDesignLinks(undefined)).toBe(0)
    expect(issueOf(canvas.id, first.id)).toBe(ISSUE_A)
  })

  it('leaves every link as it was when the read fails', async () => {
    const { canvas, first } = twoPages()
    store.applyDesignLinks(canvas.id, [{ id: ISSUE_A, designUrl: url(canvas.id, first.id) }])
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const broken: DesignIssueSource = {
      issuesNaming: async () => {
        throw new Error('Multica answered 503')
      },
    }
    expect(await syncCanvasDesignLinks(canvas.id, broken)).toBe(false)
    expect(await syncAllDesignLinks(broken)).toBe(0)
    expect(issueOf(canvas.id, first.id)).toBe(ISSUE_A)
    warn.mockRestore()
  })

  it('reads Multica once inside the freshness window', async () => {
    const { canvas } = twoPages()
    const issuesNaming = vi.fn(async () => [])
    await syncCanvasDesignLinks(canvas.id, { issuesNaming }, 1_000)
    await syncCanvasDesignLinks(canvas.id, { issuesNaming }, 2_000)
    expect(issuesNaming).toHaveBeenCalledTimes(1)
    await syncCanvasDesignLinks(canvas.id, { issuesNaming }, 20_000)
    expect(issuesNaming).toHaveBeenCalledTimes(2)
  })
})

describe('syncAllDesignLinks', () => {
  it('reconciles every canvas from one read', async () => {
    const one = twoPages()
    const two = twoPages()
    const issuesNaming = vi.fn(
      sourceOf([
        { id: ISSUE_A, designUrl: url(one.canvas.id, one.first.id) },
        { id: ISSUE_B, designUrl: url(two.canvas.id, 'p2') },
      ]).issuesNaming,
    )
    await syncAllDesignLinks({ issuesNaming })
    expect(issuesNaming).toHaveBeenCalledTimes(1)
    expect(issuesNaming).toHaveBeenCalledWith('/c/')
    expect(issueOf(one.canvas.id, one.first.id)).toBe(ISSUE_A)
    expect(issueOf(two.canvas.id, 'p2')).toBe(ISSUE_B)
  })
})

describe('httpDesignIssueSource', () => {
  function fakeMultica(pages: unknown[], properties: unknown[] = [{ id: PROP, name: 'Design', type: 'url' }]) {
    const asked: { path: string; query: URLSearchParams; auth: string | null; workspace: string | null }[] = []
    const impl = (async (input: string | URL | Request, init?: RequestInit) => {
      const u = new URL(String(input))
      const headers = new Headers(init?.headers)
      asked.push({
        path: u.pathname,
        query: u.searchParams,
        auth: headers.get('authorization'),
        workspace: headers.get('x-workspace-id'),
      })
      if (u.pathname === '/api/properties') return Response.json({ properties })
      const page = pages[Number(u.searchParams.get('offset')) / 100]
      return page ? Response.json(page) : new Response('nope', { status: 404 })
    }) as typeof fetch
    return { impl, asked }
  }

  it('asks for the Design property by id, with the read link headers, and pages through the answer', async () => {
    const { impl, asked } = fakeMultica([
      { issues: [{ id: ISSUE_A, properties: { [PROP]: 'https://d/c/x?page=p1' } }], has_more: true },
      { issues: [{ id: ISSUE_B, properties: {} }], has_more: false },
    ])
    const issues = await httpDesignIssueSource(CONFIG, impl).issuesNaming('/c/x')
    expect(issues).toEqual([
      { id: ISSUE_A, designUrl: 'https://d/c/x?page=p1' },
      { id: ISSUE_B, designUrl: null },
    ])
    const list = asked.filter((a) => a.path === '/api/issues')
    expect(list).toHaveLength(2)
    expect(JSON.parse(list[0]!.query.get('properties')!)).toEqual({ [PROP]: [{ op: 'contains', value: '/c/x' }] })
    expect(list[0]!.query.get('workspace_id')).toBe('ws-1')
    for (const a of asked) expect([a.auth, a.workspace]).toEqual(['Bearer tok', 'ws-1'])
  })

  it('accepts the property under its old name, Design url', async () => {
    const { impl } = fakeMultica([{ issues: [], has_more: false }], [{ id: PROP, name: 'Design url', type: 'url' }])
    expect(await httpDesignIssueSource(CONFIG, impl).issuesNaming('/c/')).toEqual([])
  })

  it('fails closed on a missing property, an odd payload or a Multica error', async () => {
    await expect(httpDesignIssueSource(CONFIG, fakeMultica([], []).impl).issuesNaming('/c/')).rejects.toThrow(
      /Design url property/,
    )
    await expect(httpDesignIssueSource(CONFIG, fakeMultica([{ nope: true }]).impl).issuesNaming('/c/')).rejects.toThrow(
      /unexpected issues payload/,
    )
    await expect(
      httpDesignIssueSource(CONFIG, fakeMultica([{ issues: [{ properties: {} }], has_more: false }]).impl).issuesNaming(
        '/c/',
      ),
    ).rejects.toThrow(/no id/)
    await expect(httpDesignIssueSource(CONFIG, fakeMultica([]).impl).issuesNaming('/c/')).rejects.toThrow(/404/)
  })

  it('refuses a partial list rather than reconcile on it', async () => {
    const endless = Array.from({ length: 60 }, () => ({ issues: [], has_more: true }))
    await expect(httpDesignIssueSource(CONFIG, fakeMultica(endless).impl).issuesNaming('/c/')).rejects.toThrow(
      /partial list/,
    )
  })
})
