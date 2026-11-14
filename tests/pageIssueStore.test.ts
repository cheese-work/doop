import { beforeEach, expect, it, vi } from 'vitest'

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
    saveMember: noop,
    saveReference: noop,
  }
})
import { store } from '../server/store.ts'
import { canvasPages } from '../shared/pages.ts'
import { resolvePageIssue } from '../shared/pageIssue.ts'

const ISSUE_A = '01a1d642-a8dd-75cd-886c-97d80b9e0048'
const ISSUE_B = '01a1d675-5861-786e-8567-3a074a37c386'

beforeEach(() => {
  for (const canvas of store.allCanvases()) store.deleteCanvas(canvas.id)
})

function twoPages() {
  const canvas = store.createCanvas('Bound', 'alice')
  const first = canvasPages(canvas)[0]!
  store.setPages(canvas.id, [first, { id: 'p2', name: 'Two' }])
  return { canvas, first, second: 'p2' }
}
const issueOf = (canvasId: string, pageId: string) =>
  resolvePageIssue(canvasPages(store.getCanvas(canvasId)!).find((p) => p.id === pageId))

it('a member write binds a page to an issue and clears it', () => {
  const { canvas, first } = twoPages()
  store.setPageIssue(canvas.id, first.id, ISSUE_A, 'member')
  expect(issueOf(canvas.id, first.id)).toBe(ISSUE_A)
  store.setPageIssue(canvas.id, first.id, null, 'member')
  expect(issueOf(canvas.id, first.id)).toBeNull()
})

it('refuses an unknown page, an unknown canvas and a malformed issue id', () => {
  const { canvas, first } = twoPages()
  expect(store.setPageIssue(canvas.id, 'ghost', ISSUE_A, 'member')).toBeUndefined()
  expect(store.setPageIssue('nope', first.id, ISSUE_A, 'member')).toBeUndefined()
  expect(store.setPageIssue(canvas.id, first.id, 'not-a-uuid', 'member')).toBeUndefined()
  expect(issueOf(canvas.id, first.id)).toBeNull()
})

it('a page-list save can neither forge nor drop a link', () => {
  const { canvas, first } = twoPages()
  store.setPageIssue(canvas.id, first.id, ISSUE_A, 'member')
  /* forged: client names an issue on page 2 and a different one on page 1 */
  store.setPages(canvas.id, [
    { ...first, issueId: ISSUE_B, issueSource: 'member' },
    { id: 'p2', name: 'Two', issueId: ISSUE_B, issueSource: 'member' },
  ])
  expect(issueOf(canvas.id, first.id)).toBe(ISSUE_A)
  expect(issueOf(canvas.id, 'p2')).toBeNull()
  /* a rename that omits the link keeps it */
  store.setPages(canvas.id, [
    { id: first.id, name: 'Renamed' },
    { id: 'p2', name: 'Two' },
  ])
  expect(issueOf(canvas.id, first.id)).toBe(ISSUE_A)
})

it('a duplicated page and a copied canvas start unbound', async () => {
  const { canvas, first } = twoPages()
  store.setPageIssue(canvas.id, first.id, ISSUE_A, 'member')
  const dup = await store.duplicatePage(canvas.id, first.id, 'alice')
  expect(issueOf(canvas.id, dup!.page.id)).toBeNull()
  const copy = await store.duplicateCanvas(canvas.id, 'alice', 'alice')
  for (const page of canvasPages(copy!)) expect(resolvePageIssue(page)).toBeNull()
  expect(issueOf(canvas.id, first.id)).toBe(ISSUE_A)
})

it('deleting a page takes its link along; a new page with that id starts unbound', () => {
  const { canvas, first } = twoPages()
  store.setPageIssue(canvas.id, 'p2', ISSUE_A, 'member')
  store.setPages(canvas.id, [first])
  store.setPages(canvas.id, [first, { id: 'p2', name: 'Two again' }])
  expect(issueOf(canvas.id, 'p2')).toBeNull()
})

const designUrl = (canvasId: string, page: string) => `https://doop.example/c/${canvasId}?page=${page}`

it('derivation from the Design URL links, and drops a stale design link when the URL moves', () => {
  const { canvas, first } = twoPages()
  store.applyDesignLinks(canvas.id, [{ id: ISSUE_A, designUrl: designUrl(canvas.id, first.id) }])
  expect(issueOf(canvas.id, first.id)).toBe(ISSUE_A)
  /* the issue's Design URL now points at page 2: the old link is stale */
  store.applyDesignLinks(canvas.id, [{ id: ISSUE_A, designUrl: designUrl(canvas.id, 'p2') }])
  expect(issueOf(canvas.id, first.id)).toBeNull()
  expect(issueOf(canvas.id, 'p2')).toBe(ISSUE_A)
  /* the issue lost its Design URL */
  store.applyDesignLinks(canvas.id, [{ id: ISSUE_A, designUrl: null }])
  expect(issueOf(canvas.id, 'p2')).toBeNull()
})

it('two issues on one page fail closed and clear a design link', () => {
  const { canvas, first } = twoPages()
  store.applyDesignLinks(canvas.id, [{ id: ISSUE_A, designUrl: designUrl(canvas.id, first.id) }])
  store.applyDesignLinks(canvas.id, [
    { id: ISSUE_A, designUrl: designUrl(canvas.id, first.id) },
    { id: ISSUE_B, designUrl: designUrl(canvas.id, first.id) },
  ])
  expect(issueOf(canvas.id, first.id)).toBeNull()
})

it('derivation never overwrites or clears a member link', () => {
  const { canvas, first } = twoPages()
  store.setPageIssue(canvas.id, first.id, ISSUE_A, 'member')
  store.applyDesignLinks(canvas.id, [{ id: ISSUE_B, designUrl: designUrl(canvas.id, first.id) }])
  expect(issueOf(canvas.id, first.id)).toBe(ISSUE_A)
  store.applyDesignLinks(canvas.id, [])
  expect(issueOf(canvas.id, first.id)).toBe(ISSUE_A)
})
