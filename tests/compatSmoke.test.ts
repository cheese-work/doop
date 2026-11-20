import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
// @ts-expect-error plain .mjs script, no types
import { runSmoke } from '../scripts/deploy-smoke.mjs'
// @ts-expect-error plain .mjs script, no types
import { missingGroups, routeGroups, staleGroups } from '../scripts/route-groups.mjs'
import { startServer, type Server } from './harness.ts'

/* CHE-5474 S4c, C-8.5c "Smoke": an ordered chain of calls per route group in deploy/cd/smoke-routes.json.
   Real writes are read back; a `contract` call names the outside service that makes success impossible in the
   sandbox; a group with no write says why. A CI failure when a server route group is not listed there. */
interface Call {
  kind: 'read' | 'write' | 'contract'
  method: string
  path: string
  expect?: number[]
  contract?: string
  expectJson?: Record<string, string>
  expectByStatus?: Record<string, Record<string, string>>
  body?: unknown
}
interface Group {
  group: string
  calls: Call[]
  noWrite?: string
}
const routes = JSON.parse(readFileSync('deploy/cd/smoke-routes.json', 'utf8')) as { groups: Group[] }

describe('route groups', () => {
  it('finds the groups the server mounts, and not the Gemini worker process', () => {
    const groups: string[] = routeGroups('server')
    expect(groups).toEqual(expect.arrayContaining(['/api/canvases', '/api/auth', '/healthz', '/mcp', '/u']))
    expect(groups).not.toContain('/runs')
  })

  it('reports a server group that smoke-routes.json does not list', () => {
    expect(missingGroups({ groups: [{ group: '/api/a' }] }, ['/api/a', '/api/b'])).toEqual(['/api/b'])
    expect(missingGroups({ groups: [{ group: '/api/a' }, { group: '/api/b' }] }, ['/api/a', '/api/b'])).toEqual([])
  })

  it('reports a listed group the server no longer has', () => {
    expect(staleGroups({ groups: [{ group: '/api/a' }, { group: '/api/gone' }] }, ['/api/a'])).toEqual(['/api/gone'])
  })

  it('lists every group the server mounts (a route group missing from smoke-routes.json fails CI)', () => {
    expect(missingGroups(routes, routeGroups('server'))).toEqual([])
    expect(staleGroups(routes, routeGroups('server'))).toEqual([])
  })

  it('gives every group a read or contract call, and a real write or a stated reason there is none', () => {
    expect(routes.groups.length).toBeGreaterThan(30)
    for (const g of routes.groups) {
      const kinds = new Set(g.calls.map((c) => c.kind))
      expect(kinds.has('read') || kinds.has('contract'), `${g.group} read`).toBe(true)
      if (!kinds.has('write')) expect(g.noWrite?.length ?? 0, `${g.group} noWrite reason`).toBeGreaterThanOrEqual(20)
    }
  })

  it('keeps the real operations real: no placeholder 404/405 outside the static groups', () => {
    const staticGroups = new Set([
      '/a',
      '/assets',
      '/bg',
      '/i',
      '/icons',
      '/photos',
      '/api',
      '/api/admin',
      '/api/feedback',
      '/api/mcp-consent',
      '/api/tasks',
    ])
    for (const g of routes.groups)
      for (const c of g.calls) {
        const want = c.expect ?? [200]
        if (want.every((s) => s === 404 || s === 405))
          expect(staticGroups.has(g.group), `${g.group} ${c.path} expects only ${want}`).toBe(true)
        if (c.kind === 'write')
          expect(
            want.every((s) => s >= 200 && s < 300),
            `${g.group} ${c.method} ${c.path} write must succeed`,
          ).toBe(true)
        if (c.kind === 'contract')
          expect((c.contract ?? '').length, `${g.group} ${c.path} contract reason`).toBeGreaterThanOrEqual(20)
      }
  })

  it('gives /api/agents and /api/image-descriptions a real write that is read back (C-8.5c: one read, one write per group)', () => {
    for (const name of ['/api/agents', '/api/image-descriptions']) {
      const g = routes.groups.find((x) => x.group === name)!
      expect(g.noWrite, `${name} must not skip its write`).toBeUndefined()
      const writeAt = g.calls.findIndex((c) => c.kind === 'write')
      expect(writeAt, `${name} write`).toBeGreaterThanOrEqual(0)
      expect(
        g.calls.slice(writeAt + 1).some((c) => c.kind === 'read' && c.expectJson),
        `${name} read-back after the write`,
      ).toBe(true)
    }
  })

  it('gives /api/custom-providers an enabled/disabled contract that an absent route cannot meet', () => {
    const g = routes.groups.find((x) => x.group === '/api/custom-providers')!
    const call = g.calls.find((c) => c.kind === 'contract')!
    expect(call.method).toBe('POST')
    expect(Object.keys(call.expectByStatus ?? {}).sort()).toEqual(['400', '404'])
    for (const want of Object.values(call.expectByStatus ?? {})) expect(want.error?.length ?? 0).toBeGreaterThan(10)
  })

  it('writes to at least eleven groups and reads at least ten of those writes back', () => {
    const writers = routes.groups.filter((g) => g.calls.some((c) => c.kind === 'write'))
    expect(writers.length).toBeGreaterThanOrEqual(11)
    const readBack = routes.groups.reduce(
      (n, g) => n + g.calls.filter((c) => c.kind === 'read' && c.expectJson).length,
      0,
    )
    expect(readBack).toBeGreaterThanOrEqual(10)
  })
})

describe('runSmoke against a scripted fetch', () => {
  const sleep = async () => {}
  const base = { baseUrl: 'http://app:4400', origin: 'http://localhost', sleep, healthDeadlineMs: 50 }
  const one = {
    groups: [
      {
        group: '/api/x',
        calls: [
          { kind: 'read', method: 'GET', path: '/api/x', expect: [200] },
          { kind: 'write', method: 'POST', path: '/api/x', body: { a: 1 }, expect: [200, 201] },
        ],
      },
    ],
  }
  const reply = (status: number, headers: Record<string, string> = {}, body = '{}') =>
    new Response(body, { status, headers })
  const scripted =
    (table: Record<string, Response | (() => Response)>) =>
    async (url: string, init: RequestInit = {}) => {
      const key = `${init.method ?? 'GET'} ${new URL(url).pathname}`
      const hit = table[key]
      if (!hit) throw new Error(`no scripted reply for ${key}`)
      return typeof hit === 'function' ? hit() : hit.clone()
    }
  const ok = {
    'GET /healthz': reply(200),
    'POST /api/auth/sign-up/email': reply(200, { 'set-cookie': 'doop.session=abc; Path=/; HttpOnly' }),
    'GET /api/x': reply(200),
    'POST /api/x': reply(201),
  }

  it('passes when health is 200 and every call answers an expected status', async () => {
    const out = await runSmoke({ ...base, routes: one, fetchImpl: scripted(ok) })
    expect(out.ok).toBe(true)
    expect(out.results.map((r: { kind: string; status: number }) => [r.kind, r.status])).toEqual([
      ['read', 200],
      ['write', 201],
    ])
  })

  it('fails when a call answers a status outside its expect list, and names the call', async () => {
    const out = await runSmoke({ ...base, routes: one, fetchImpl: scripted({ ...ok, 'POST /api/x': reply(500) }) })
    expect(out.ok).toBe(false)
    expect(out.failed).toEqual([expect.objectContaining({ group: '/api/x', kind: 'write', status: 500 })])
  })

  it('still runs every other call after one fails', async () => {
    const out = await runSmoke({ ...base, routes: one, fetchImpl: scripted({ ...ok, 'GET /api/x': reply(503) }) })
    expect(out.ok).toBe(false)
    expect(out.results).toHaveLength(2)
  })

  it('fails when a call cannot reach the server', async () => {
    const fetchImpl = scripted({
      ...ok,
      'GET /api/x': () => {
        throw new Error('ECONNREFUSED')
      },
    })
    const out = await runSmoke({ ...base, routes: one, fetchImpl })
    expect(out.ok).toBe(false)
    expect(out.failed[0]).toEqual(expect.objectContaining({ group: '/api/x', kind: 'read' }))
  })

  it('fails when health never answers 200', async () => {
    const out = await runSmoke({ ...base, routes: one, fetchImpl: scripted({ ...ok, 'GET /healthz': reply(503) }) })
    expect(out.ok).toBe(false)
    expect(out.failed[0]).toEqual(expect.objectContaining({ group: '/healthz' }))
  })

  it('fails when the smoke user cannot sign up', async () => {
    const out = await runSmoke({
      ...base,
      routes: one,
      fetchImpl: scripted({ ...ok, 'POST /api/auth/sign-up/email': reply(500) }),
    })
    expect(out.ok).toBe(false)
  })

  it('sends the session cookie and Origin, and substitutes a captured value into a later path', async () => {
    const seen: { key: string; cookie?: string; origin?: string }[] = []
    const routes2 = {
      groups: [
        {
          group: '/api/c',
          calls: [
            { kind: 'write', method: 'POST', path: '/api/c', body: {}, expect: [200], save: { id: 'id' } },
            { kind: 'read', method: 'GET', path: '/api/c/{id}', expect: [200] },
          ],
        },
      ],
    }
    const fetchImpl = async (url: string, init: RequestInit = {}) => {
      const h = new Headers(init.headers)
      const key = `${init.method ?? 'GET'} ${new URL(url).pathname}`
      seen.push({ key, cookie: h.get('cookie') ?? undefined, origin: h.get('origin') ?? undefined })
      if (key === 'GET /healthz') return reply(200)
      if (key === 'POST /api/auth/sign-up/email') return reply(200, { 'set-cookie': 'doop.session=abc; Path=/' })
      if (key === 'POST /api/c') return reply(200, {}, JSON.stringify({ id: 'cv1' }))
      if (key === 'GET /api/c/cv1') return reply(200)
      return reply(404)
    }
    const out = await runSmoke({ ...base, routes: routes2, fetchImpl })
    expect(out.ok).toBe(true)
    expect(seen.find((s) => s.key === 'POST /api/c')).toEqual(
      expect.objectContaining({ cookie: expect.stringContaining('doop.session=abc'), origin: 'http://localhost' }),
    )
    expect(seen.map((s) => s.key)).toContain('GET /api/c/cv1')
  })

  it('fails a call whose path needs a value that was never captured', async () => {
    const routes2 = {
      groups: [
        {
          group: '/api/c',
          calls: [
            { kind: 'write', method: 'POST', path: '/api/c', body: {}, expect: [200] },
            { kind: 'read', method: 'GET', path: '/api/c/{id}', expect: [200] },
          ],
        },
      ],
    }
    const out = await runSmoke({ ...base, routes: routes2, fetchImpl: scripted({ ...ok, 'POST /api/c': reply(200) }) })
    expect(out.ok).toBe(false)
    expect(out.failed[0]).toEqual(expect.objectContaining({ group: '/api/c', kind: 'read' }))
  })

  it('fails when a real operation answers 200 but the read-back shows the write did not happen', async () => {
    const chain = {
      groups: [
        {
          group: '/api/c',
          calls: [
            { kind: 'write', method: 'POST', path: '/api/c', body: { name: 'a' }, save: { id: 'id' } },
            { kind: 'read', method: 'GET', path: '/api/c/{id}', expectJson: { name: 'a' } },
          ],
        },
      ],
    }
    const table = { ...ok, 'POST /api/c': reply(200, {}, '{"id":"cv1"}') }
    const good = await runSmoke({
      ...base,
      routes: chain,
      fetchImpl: scripted({ ...table, 'GET /api/c/cv1': reply(200, {}, '{"name":"a"}') }),
    })
    expect(good.ok).toBe(true)
    const bad = await runSmoke({
      ...base,
      routes: chain,
      fetchImpl: scripted({ ...table, 'GET /api/c/cv1': reply(200, {}, '{"name":"b"}') }),
    })
    expect(bad.ok).toBe(false)
    expect(bad.failed[0]).toEqual(
      expect.objectContaining({ kind: 'read', status: 200, error: expect.stringContaining('name') }),
    )
  })

  it('fails a write that answers a 404 placeholder instead of success', async () => {
    const chain = {
      groups: [
        {
          group: '/api/c',
          calls: [
            { kind: 'write', method: 'POST', path: '/api/not-a-route', body: {} },
            { kind: 'read', method: 'GET', path: '/api/c' },
          ],
        },
      ],
    }
    const out = await runSmoke({
      ...base,
      routes: chain,
      fetchImpl: scripted({ ...ok, 'POST /api/not-a-route': reply(404), 'GET /api/c': reply(200) }),
    })
    expect(out.ok).toBe(false)
    expect(out.failed[0]).toEqual(expect.objectContaining({ kind: 'write', status: 404 }))
  })

  it('checks the body that goes with the status a call answered (expectByStatus), and fails an unlisted status or body', async () => {
    const contract = (extra = {}) => ({
      groups: [
        {
          group: '/api/p',
          noWrite: 'a provider needs an outside endpoint, so only the contract is checked',
          calls: [
            {
              kind: 'contract',
              method: 'POST',
              path: '/api/p',
              body: {},
              expectByStatus: { '400': { error: 'Give it a name' }, '404': { error: 'it is off here' } },
              ...extra,
            },
          ],
        },
      ],
    })
    const run = (res: Response) =>
      runSmoke({ ...base, routes: contract(), fetchImpl: scripted({ ...ok, 'POST /api/p': res }) })
    expect((await run(reply(400, {}, '{"error":"Give it a name"}'))).ok).toBe(true)
    expect((await run(reply(404, {}, '{"error":"it is off here"}'))).ok).toBe(true)
    // a route that is not there: the generic 404 body, a 200 or a 500 are all a failure
    expect((await run(reply(404, {}, '{"error":"Not found"}'))).ok).toBe(false)
    expect((await run(reply(404, {}, 'not json'))).ok).toBe(false)
    expect((await run(reply(200, {}, '{"error":"Give it a name"}'))).ok).toBe(false)
    expect((await run(reply(500, {}, '{"error":"Give it a name"}'))).ok).toBe(false)
  })

  it('fails a group with neither a write nor a noWrite reason, and one with no read', async () => {
    const noWriteChain = { groups: [{ group: '/api/c', calls: [{ kind: 'read', method: 'GET', path: '/api/c' }] }] }
    const f = scripted({ ...ok, 'GET /api/c': reply(200) })
    expect((await runSmoke({ ...base, routes: noWriteChain, fetchImpl: f })).ok).toBe(false)
    const reasoned = { groups: [{ ...noWriteChain.groups[0], noWrite: 'read-only configuration' }] }
    expect((await runSmoke({ ...base, routes: reasoned, fetchImpl: f })).ok).toBe(true)
    const noRead = { groups: [{ group: '/api/c', calls: [{ kind: 'write', method: 'POST', path: '/api/c' }] }] }
    expect(
      (await runSmoke({ ...base, routes: noRead, fetchImpl: scripted({ ...ok, 'POST /api/c': reply(200) }) })).ok,
    ).toBe(false)
  })
})

describe('deploy-smoke.mjs and smoke-routes.json ship in the image', () => {
  it('copies both into the runtime stage, so the candidate image can run the suite', () => {
    const dockerfile = readFileSync('Dockerfile', 'utf8')
    expect(dockerfile).toMatch(/COPY\s+scripts\/deploy-smoke\.mjs\s+\.\/scripts\/deploy-smoke\.mjs/)
    expect(dockerfile).toMatch(/COPY\s+deploy\/cd\/smoke-routes\.json\s+\.\/deploy\/cd\/smoke-routes\.json/)
  })
})

describe('the smoke suite against a real server', () => {
  let server: Server
  beforeAll(async () => {
    server = await startServer()
  }, 70_000)
  afterAll(() => server?.stop())

  it('passes every listed operation, and a broken real operation fails it', async () => {
    const out = await runSmoke({ baseUrl: server.base, origin: server.base, routes })
    expect(out.failed).toEqual([])
    expect(out.ok).toBe(true)
    const broken = JSON.parse(JSON.stringify(routes)) as typeof routes
    const canvases = broken.groups.find((g) => g.group === '/api/canvases')!
    canvases.calls.find((c) => c.method === 'PATCH')!.body = { name: 'Other' }
    const bad = await runSmoke({ baseUrl: server.base, origin: server.base, routes: broken })
    expect(bad.ok).toBe(false)
    expect(bad.failed.map((f: { group: string }) => f.group)).toContain('/api/canvases')
    expect(out.results.length).toBe(routes.groups.reduce((n, g) => n + g.calls.length, 0))
  }, 120_000)

  const breakCall = (group: string, method: string, patch: Partial<Call>) => {
    const broken = JSON.parse(JSON.stringify(routes)) as typeof routes
    const call = broken.groups.find((g) => g.group === group)!.calls.find((c) => c.method === method)!
    Object.assign(call, patch)
    return broken
  }

  it('fails smoke when the /api/agents write is refused, and when it is not stored', async () => {
    const refused = await runSmoke({
      baseUrl: server.base,
      origin: server.base,
      routes: breakCall('/api/agents', 'POST', { body: { name: 'x' } }),
    })
    expect(refused.ok).toBe(false)
    expect(refused.failed.map((f: { group: string; kind: string }) => `${f.group} ${f.kind}`)).toContain(
      '/api/agents write',
    )
    const notStored = await runSmoke({
      baseUrl: server.base,
      origin: server.base,
      routes: breakCall('/api/agents', 'PATCH', { body: { blurb: 'A different line from the one read back' } }),
    })
    expect(notStored.ok).toBe(false)
    expect(notStored.failed.map((f: { group: string }) => f.group)).toContain('/api/agents')
  }, 120_000)

  it('fails smoke when the /api/image-descriptions write is refused, and when it is not stored', async () => {
    const refused = await runSmoke({
      baseUrl: server.base,
      origin: server.base,
      routes: breakCall('/api/image-descriptions', 'PUT', { body: { mode: 'nonsense' } }),
    })
    expect(refused.ok).toBe(false)
    expect(refused.failed.map((f: { group: string; kind: string }) => `${f.group} ${f.kind}`)).toContain(
      '/api/image-descriptions write',
    )
    const notStored = await runSmoke({
      baseUrl: server.base,
      origin: server.base,
      routes: breakCall('/api/image-descriptions', 'PUT', { body: { mode: 'server' } }),
    })
    expect(notStored.ok).toBe(false)
    expect(notStored.failed.map((f: { group: string }) => f.group)).toContain('/api/image-descriptions')
  }, 120_000)

  it('meets the /api/custom-providers contract on a booted server with the feature on, and fails a wrong contract', async () => {
    const only = { groups: routes.groups.filter((g) => g.group === '/api/custom-providers') }
    const on = await runSmoke({ baseUrl: server.base, origin: server.base, routes: only })
    expect(on.failed).toEqual([])
    expect(on.results).toEqual([expect.objectContaining({ group: '/api/custom-providers', status: 400, ok: true })])
    const wrong = JSON.parse(JSON.stringify(only)) as typeof only
    wrong.groups[0]!.calls[0]!.expectByStatus = { '400': { error: 'some other text' }, '404': { error: 'nope' } }
    expect((await runSmoke({ baseUrl: server.base, origin: server.base, routes: wrong })).ok).toBe(false)
  }, 120_000)
})

describe('the /api/custom-providers contract with the feature switched off', () => {
  let off: Server
  beforeAll(async () => {
    off = await startServer({ DOOP_CUSTOM_PROVIDERS: 'false' })
  }, 70_000)
  afterAll(() => off?.stop())

  it('answers 404 with the off message, and the contract accepts it', async () => {
    const only = { groups: routes.groups.filter((g) => g.group === '/api/custom-providers') }
    const out = await runSmoke({ baseUrl: off.base, origin: off.base, routes: only })
    expect(out.failed).toEqual([])
    expect(out.results).toEqual([expect.objectContaining({ status: 404, ok: true })])
  }, 120_000)
})
