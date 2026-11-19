import { describe, expect, it } from 'vitest'
import { httpRequirementSource, multicaRequirementSource } from '../server/requirementSource.ts'

/* CHE-6629: where the ledger's source lines come from. Multica's own routes,
   `GET /api/issues/:id` (description) and `GET /api/issues/:id/comments`
   (the whole list unless fold/recent/thread is asked for). */

const ISSUE = '01a1e586-c5e6-71a7-9cae-c5b32b8f2818'
const CONFIG = { apiUrl: 'https://multica.test', token: 'tok', workspaceId: 'ws-1' }

function fakeFetch(routes: Record<string, () => Response>) {
  const asked: { url: string; auth: string | null; workspace: string | null }[] = []
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const headers = new Headers(init?.headers)
    asked.push({ url, auth: headers.get('authorization'), workspace: headers.get('x-workspace-id') })
    const route = routes[new URL(url).pathname]
    return route ? route() : new Response('nope', { status: 404 })
  }) as typeof fetch
  return { impl, asked }
}
const json =
  (body: unknown, status = 200) =>
  () =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

describe('httpRequirementSource issueKey', () => {
  it('reads the issue identifier, the key the Motion spec frame is named after (CHE-6853)', async () => {
    const { impl } = fakeFetch({ [`/api/issues/${ISSUE}`]: json({ id: ISSUE, identifier: ' CHE-6853 ' }) })
    expect(await httpRequirementSource(CONFIG, impl).issueKey(ISSUE)).toBe('CHE-6853')
  })

  it('fails closed on a missing identifier or a Multica error', async () => {
    for (const body of [{ id: ISSUE }, { id: ISSUE, identifier: '  ' }, { id: ISSUE, identifier: 7 }]) {
      const { impl } = fakeFetch({ [`/api/issues/${ISSUE}`]: json(body) })
      await expect(httpRequirementSource(CONFIG, impl).issueKey(ISSUE)).rejects.toThrow(/identifier/)
    }
    const { impl } = fakeFetch({ [`/api/issues/${ISSUE}`]: json({}, 500) })
    await expect(httpRequirementSource(CONFIG, impl).issueKey(ISSUE)).rejects.toThrow(/500/)
  })
})

describe('httpRequirementSource', () => {
  it('reads the description and every comment, and keeps only the description and member lines', async () => {
    const { impl, asked } = fakeFetch({
      [`/api/issues/${ISSUE}`]: json({ id: ISSUE, description: 'Add a minimap' }),
      [`/api/issues/${ISSUE}/comments`]: json([
        { id: 'aaaaaaaa-1', author_type: 'member', content: 'kebab menu\nsort' },
        { id: 'bbbbbbbb-2', author_type: 'agent', content: 'done' },
      ]),
    })
    const lines = await httpRequirementSource(CONFIG, impl).lines(ISSUE)
    expect(lines.map((l) => l.text)).toEqual(['Add a minimap', 'kebab menu', 'sort'])
    expect(lines.map((l) => l.id.split(':')[0])).toEqual(['desc#0', 'aaaaaaaa#0', 'aaaaaaaa#1'])
    expect(asked.map((a) => [a.auth, a.workspace])).toEqual([
      ['Bearer tok', 'ws-1'],
      ['Bearer tok', 'ws-1'],
    ])
    expect(asked.every((a) => !a.url.includes('fold') && !a.url.includes('recent'))).toBe(true)
  })

  it('treats a null description as no description', async () => {
    const { impl } = fakeFetch({
      [`/api/issues/${ISSUE}`]: json({ id: ISSUE, description: null }),
      [`/api/issues/${ISSUE}/comments`]: json([]),
    })
    expect(await httpRequirementSource(CONFIG, impl).lines(ISSUE)).toEqual([])
  })

  it('fails closed: a Multica error, a bad payload or a withheld comment is no source at all', async () => {
    const ok = json({ id: ISSUE, description: 'x' })
    const cases: Record<string, () => Response>[] = [
      { [`/api/issues/${ISSUE}`]: json({}, 500), [`/api/issues/${ISSUE}/comments`]: json([]) },
      { [`/api/issues/${ISSUE}`]: ok, [`/api/issues/${ISSUE}/comments`]: json({ not: 'a list' }) },
      { [`/api/issues/${ISSUE}`]: ok, [`/api/issues/${ISSUE}/comments`]: json([], 403) },
      {
        [`/api/issues/${ISSUE}`]: ok,
        [`/api/issues/${ISSUE}/comments`]: json([
          { id: 'cccccccc-3', author_type: 'member', content: '[withheld]', withheld: true },
        ]),
      },
    ]
    for (const routes of cases)
      await expect(httpRequirementSource(CONFIG, fakeFetch(routes).impl).lines(ISSUE)).rejects.toThrow()
  })
})

describe('multicaRequirementSource', () => {
  it('is plugged in only when the API url, token and workspace are all set', () => {
    expect(multicaRequirementSource({})).toBeUndefined()
    expect(multicaRequirementSource({ MULTICA_API_URL: 'https://m', MULTICA_API_TOKEN: 't' })).toBeUndefined()
    expect(
      multicaRequirementSource({ MULTICA_API_URL: 'https://m/', MULTICA_API_TOKEN: 't', MULTICA_WORKSPACE_ID: 'w' }),
    ).toBeDefined()
  })
})
