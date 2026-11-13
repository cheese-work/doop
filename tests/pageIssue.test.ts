import { describe, expect, it } from 'vitest'
import { deriveDesignLinks, parseMulticaTaskId, resolvePageIssue } from '../shared/pageIssue.ts'

const ISSUE_A = '01a1d642-a8dd-75cd-886c-97d80b9e0048'
const ISSUE_B = '01a1d675-5861-786e-8567-3a074a37c386'
const RUN = '01A1D675-3408-7B02-9816-B361C7E895FC'
const pages = [
  { id: 'p1', name: 'One' },
  { id: 'p2', name: 'Two' },
]
const none = () => undefined

describe('parseMulticaTaskId', () => {
  it('accepts a uuid and lowercases it', () => {
    expect(parseMulticaTaskId(RUN)).toBe(RUN.toLowerCase())
  })
  it.each([undefined, '', 'run-1', ['a', 'b'], `${RUN} `, `${RUN}; drop table`, 42])('rejects %j', (v) => {
    expect(parseMulticaTaskId(v)).toBeUndefined()
  })
})

describe('resolvePageIssue', () => {
  it('returns the stored issue id', () => {
    expect(resolvePageIssue({ id: 'p1', name: 'One', issueId: ISSUE_A })).toBe(ISSUE_A)
  })
  it('fails closed on a missing page, a missing link or a malformed id', () => {
    expect(resolvePageIssue(undefined)).toBeNull()
    expect(resolvePageIssue({ id: 'p1', name: 'One' })).toBeNull()
    expect(resolvePageIssue({ id: 'p1', name: 'One', issueId: 'not-a-uuid' })).toBeNull()
  })
})

describe('deriveDesignLinks', () => {
  it('links a page to the one issue whose Design URL names it', () => {
    const { links, conflicts } = deriveDesignLinks(
      'c1',
      pages,
      [{ id: ISSUE_A, designUrl: 'https://doop.example/c/c1?page=p2' }],
      none,
    )
    expect([...links]).toEqual([['p2', ISSUE_A]])
    expect(conflicts.size).toBe(0)
  })
  it('resolves a frame link to its page', () => {
    const { links } = deriveDesignLinks(
      'c1',
      pages,
      [{ id: ISSUE_A, designUrl: 'https://doop.example/c/c1?frame=f9' }],
      (f) => (f === 'f9' ? 'p1' : undefined),
    )
    expect([...links]).toEqual([['p1', ISSUE_A]])
  })
  it('ignores a forged URL: other canvas, unknown page, no page, bad issue id', () => {
    const { links, conflicts } = deriveDesignLinks(
      'c1',
      pages,
      [
        { id: ISSUE_A, designUrl: 'https://doop.example/c/other?page=p1' },
        { id: ISSUE_A, designUrl: 'https://doop.example/c/c1?page=ghost' },
        { id: ISSUE_A, designUrl: 'https://doop.example/c/c1' },
        { id: 'not-a-uuid', designUrl: 'https://doop.example/c/c1?page=p1' },
        { id: ISSUE_B, designUrl: null },
      ],
      none,
    )
    expect(links.size).toBe(0)
    expect(conflicts.size).toBe(0)
  })
  it('two issues on one page: conflict, no link', () => {
    const { links, conflicts } = deriveDesignLinks(
      'c1',
      pages,
      [
        { id: ISSUE_A, designUrl: 'https://doop.example/c/c1?page=p1' },
        { id: ISSUE_B, designUrl: 'https://doop.example/c/c1?frame=f1' },
      ],
      (f) => (f === 'f1' ? 'p1' : undefined),
    )
    expect(links.size).toBe(0)
    expect([...conflicts]).toEqual(['p1'])
  })
  it('one issue naming two pages (frame and page in one URL): conflict on both', () => {
    const { links, conflicts } = deriveDesignLinks(
      'c1',
      pages,
      [{ id: ISSUE_A, designUrl: 'https://doop.example/c/c1?page=p1&frame=f2' }],
      (f) => (f === 'f2' ? 'p2' : undefined),
    )
    expect(links.size).toBe(0)
    expect([...conflicts].sort()).toEqual(['p1', 'p2'])
  })
})
