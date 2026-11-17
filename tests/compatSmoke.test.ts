import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
// @ts-expect-error plain .mjs script, no types
import { runSmoke } from '../scripts/deploy-smoke.mjs'
// @ts-expect-error plain .mjs script, no types
import { missingGroups, routeGroups, staleGroups } from '../scripts/route-groups.mjs'
import { startServer, type Server } from './harness.ts'

/* CHE-5474 S4c, C-8.5c "Smoke": one read and one write per route group in deploy/cd/smoke-routes.json,
   and a CI failure when a server route group is not listed there. */
const routes = JSON.parse(readFileSync('deploy/cd/smoke-routes.json', 'utf8')) as {
  groups: { group: string; read?: unknown; write?: unknown }[]
}

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

  it('gives every listed group one read and one write', () => {
    expect(routes.groups.length).toBeGreaterThan(30)
    for (const g of routes.groups) {
      expect(g.read, `${g.group} read`).toBeTruthy()
      expect(g.write, `${g.group} write`).toBeTruthy()
    }
  })
})

describe('runSmoke against a scripted fetch', () => {
  const sleep = async () => {}
  const base = { baseUrl: 'http://app:4400', origin: 'http://localhost', sleep, healthDeadlineMs: 50 }
  const one = {
    groups: [
      {
        group: '/api/x',
        read: { method: 'GET', path: '/api/x', expect: [200] },
        write: { method: 'POST', path: '/api/x', body: { a: 1 }, expect: [200, 201] },
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
          read: { method: 'GET', path: '/api/c/{id}', expect: [200] },
          write: { method: 'POST', path: '/api/c', body: {}, expect: [200], save: { id: 'id' } },
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
          read: { method: 'GET', path: '/api/c/{id}', expect: [200] },
          write: { method: 'POST', path: '/api/c', body: {}, expect: [200] },
        },
      ],
    }
    const out = await runSmoke({ ...base, routes: routes2, fetchImpl: scripted({ ...ok, 'POST /api/c': reply(200) }) })
    expect(out.ok).toBe(false)
    expect(out.failed[0]).toEqual(expect.objectContaining({ group: '/api/c', kind: 'read' }))
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

  it('passes every listed read and write', async () => {
    const out = await runSmoke({ baseUrl: server.base, origin: server.base, routes })
    expect(out.failed).toEqual([])
    expect(out.ok).toBe(true)
    expect(out.results.length).toBe(routes.groups.length * 2 + 0)
  }, 120_000)
})
