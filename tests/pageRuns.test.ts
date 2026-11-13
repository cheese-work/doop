import { expect, it } from 'vitest'
import { listPageRuns, type PageRun, type RunsSource } from '../server/multicaRuns.ts'
import type { Canvas } from '../shared/types.ts'

const ISSUE_A = '01a1d642-a8dd-75cd-886c-97d80b9e0048'
const run = (id: string, kind: PageRun['kind'], startedAt: string): PageRun => ({
  id,
  kind,
  status: 'completed',
  agentId: null,
  startedAt,
  completedAt: null,
  hopInUrl: `https://multica.example/${kind}/${id}`,
})
const canvas = (pages: Canvas['pages']): Canvas => ({
  id: 'c1',
  name: 'C',
  createdAt: 0,
  updatedAt: 0,
  frames: [],
  pages,
})
function source(calls: string[] = []): RunsSource {
  return {
    async issueRuns(issueId) {
      calls.push(`issue:${issueId}`)
      return [run('i1', 'issue', '2026-11-14T01:00:00Z'), run('i2', 'issue', '2026-11-14T03:00:00Z')]
    },
    async chatRuns(canvasId, issueId) {
      calls.push(`chat:${canvasId}:${issueId}`)
      return [run('c1', 'chat', '2026-11-14T02:00:00Z')]
    },
  }
}

it('a bound page lists the issue runs and the DM runs, newest first, each with a hop-in URL', async () => {
  const calls: string[] = []
  const result = await listPageRuns(
    canvas([{ id: 'p1', name: 'One', issueId: ISSUE_A, issueSource: 'member' }]),
    'p1',
    source(calls),
  )
  expect(result).toMatchObject({ ok: true, issueId: ISSUE_A, chat: 'ok' })
  if (!result.ok) throw new Error('unreachable')
  expect(result.runs.map((r) => r.id)).toEqual(['i2', 'c1', 'i1'])
  expect(result.runs.every((r) => r.hopInUrl.startsWith('https://'))).toBe(true)
  expect(calls).toEqual([`issue:${ISSUE_A}`, `chat:c1:${ISSUE_A}`])
})

it('a baseline page (no issue) lists only the project DM runs', async () => {
  const calls: string[] = []
  const result = await listPageRuns(canvas([{ id: 'p1', name: 'One' }]), 'p1', source(calls))
  if (!result.ok) throw new Error('unreachable')
  expect(result.issueId).toBeNull()
  expect(result.runs.map((r) => r.id)).toEqual(['c1'])
  expect(calls).toEqual(['chat:c1:null'])
})

it('reports the chat half as unavailable when the source has no DM resolver', async () => {
  const { chatRuns: _omit, ...issueOnly } = source()
  const result = await listPageRuns(
    canvas([{ id: 'p1', name: 'One', issueId: ISSUE_A, issueSource: 'member' }]),
    'p1',
    issueOnly,
  )
  expect(result).toMatchObject({ ok: true, chat: 'unavailable' })
  if (!result.ok) throw new Error('unreachable')
  expect(result.runs.map((r) => r.id)).toEqual(['i2', 'i1'])
})

it('fails closed on a malformed stored link: 409, nothing listed, no Multica call', async () => {
  const calls: string[] = []
  const result = await listPageRuns(
    canvas([{ id: 'p1', name: 'One', issueId: 'not-a-uuid', issueSource: 'member' }]),
    'p1',
    source(calls),
  )
  expect(result).toMatchObject({ ok: false, status: 409 })
  expect(calls).toEqual([])
})

it('an unknown page is a 404', async () => {
  expect(await listPageRuns(canvas([{ id: 'p1', name: 'One' }]), 'ghost', source())).toMatchObject({
    ok: false,
    status: 404,
  })
})
