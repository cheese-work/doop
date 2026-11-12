import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, startServer, type Server } from './harness.ts'

/**
 * Soft delete (CHE-5306) against the REAL server: a delete keeps the frame
 * and its version rows across a reboot, a restore brings the history back,
 * and no code path hard-deletes a frame, a page or a version.
 */

const DOC_A = '<!doctype html><html><body><h1>Alpha</h1><p>the first design, by hand</p></body></html>'
const DOC_B =
  '<!doctype html><html><body><main><h2>Beta</h2><section>a completely different design</section></main></body></html>'

interface VersionRow {
  id: string
  htmlBytes: number
}

let server: Server
let client: Client
let canvasId: string

beforeAll(async () => {
  server = await startServer()
  client = new Client(server)
  await client.signUp('trash@test.dev', 'Tess')
  canvasId = (await (await client.post('/api/canvases', { name: 'Trash' })).json()).id
}, 70_000)

afterAll(() => server?.stop())

async function eventually<T>(read: () => Promise<T>, ok: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 3000
  for (;;) {
    const value = await read()
    if (ok(value) || Date.now() > deadline) return value
    await new Promise((r) => setTimeout(r, 50))
  }
}

const versionsOf = (c: Client, frameId: string, count: number) =>
  eventually(
    async () => (await (await c.get(`/api/frames/${frameId}/versions`)).json()) as VersionRow[],
    (list) => Array.isArray(list) && list.length === count,
  )

async function frameWithHistory(name: string, pageId?: string) {
  const res = await client.post(`/api/canvases/${canvasId}/frames`, {
    name,
    html: DOC_A,
    ...(pageId ? { pageId } : {}),
  })
  const frame = (await res.json()) as { id: string }
  await client.patch(`/api/frames/${frame.id}`, { html: DOC_B })
  const versions = await versionsOf(client, frame.id, 1)
  return { id: frame.id, versions }
}

describe('frame delete and restore', () => {
  it('keeps the version rows through a delete and a reboot, and restore returns the frame with its history', async () => {
    const { id, versions } = await frameWithHistory('Hero')
    expect((await client.delete(`/api/frames/${id}`)).status).toBe(200)

    const live = await (await client.get(`/api/canvases/${canvasId}`)).json()
    expect(live.frames.map((f: { id: string }) => f.id)).not.toContain(id)

    /* the trash lists it, so a client can find what to restore */
    const trash = await (await client.get(`/api/canvases/${canvasId}/trash`)).json()
    expect(trash.frames).toEqual([expect.objectContaining({ id, name: 'Hero' })])

    server.stop({ keepData: true })
    await server.stopped
    server = await startServer({}, server.dataDir)
    client = new Client(server)
    await client.post('/api/auth/sign-in/email', { email: 'trash@test.dev', password: 'password12345' })

    const restored = await client.post(`/api/frames/${id}/restore`)
    expect(restored.status).toBe(200)
    expect(await restored.json()).toMatchObject({ id, name: 'Hero', html: DOC_B })
    const back = await (await client.get(`/api/canvases/${canvasId}`)).json()
    expect(back.frames.map((f: { id: string }) => f.id)).toContain(id)
    expect((await versionsOf(client, id, 1)).map((v) => v.id)).toEqual(versions.map((v) => v.id))
  }, 70_000)

  it('refuses writes to a deleted frame with 410 naming it', async () => {
    const { id } = await frameWithHistory('Gone')
    await client.delete(`/api/frames/${id}`)
    const writes = [
      client.patch(`/api/frames/${id}`, { html: DOC_A }),
      client.patch(`/api/frames/${id}`, { width: 100 }),
      client.put(`/api/frames/${id}/approval`, { ready: true }),
      client.post(`/api/frames/${id}/append`, { html_chunk: '<p>x</p>' }),
      client.post(`/api/frames/${id}/versions/anything/restore`),
    ]
    for (const res of await Promise.all(writes)) {
      expect(res.status).toBe(410)
      const body = await res.json()
      expect(body.error).toMatch(/Gone/)
      expect(body.error).toMatch(/deleted/)
    }
  })
})

describe('page delete and restore', () => {
  it('brings the page, its frames and their history back', async () => {
    const pagesRes = await client.get(`/api/canvases/${canvasId}`)
    const canvas = await pagesRes.json()
    const pages = canvas.pages as Array<{ id: string; name: string }>
    const extra = { id: 'page-extra', name: 'Extra' }
    const added = await client.put(`/api/canvases/${canvasId}/pages`, {
      pages: [...pages, extra],
      expectedPages: pages,
    })
    expect(added.status).toBe(200)

    const { id, versions } = await frameWithHistory('InExtra', extra.id)
    await client.delete(`/api/frames/${id}`)
    const del = await client.put(`/api/canvases/${canvasId}/pages`, { pages, expectedPages: [...pages, extra] })
    expect(del.status).toBe(200)
    expect(
      (await (await client.get(`/api/canvases/${canvasId}`)).json()).pages.map((p: { id: string }) => p.id),
    ).not.toContain(extra.id)

    const restored = await client.post(`/api/canvases/${canvasId}/pages/${extra.id}/restore`)
    expect(restored.status).toBe(200)
    const body = await restored.json()
    expect(body.page).toMatchObject({ id: extra.id, name: 'Extra' })
    expect(body.frames.map((f: { id: string }) => f.id)).toEqual([id])
    const after = await (await client.get(`/api/canvases/${canvasId}`)).json()
    expect(after.pages.map((p: { id: string }) => p.id)).toContain(extra.id)
    expect(after.frames.find((f: { id: string }) => f.id === id)).toMatchObject({ pageId: extra.id, html: DOC_B })
    expect((await versionsOf(client, id, 1)).map((v) => v.id)).toEqual(versions.map((v) => v.id))
  })
})

describe('nothing is hard-deleted', () => {
  /* the only server code allowed to remove rows, each with its reason */
  const ALLOWED: Record<string, string> = {
    'server/db/persist.ts': 'deleteCanvas (whole-canvas delete) and the 50-version retention trim',
  }

  function sources(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) return entry.name === 'migrations' ? [] : sources(full)
      return entry.name.endsWith('.ts') ? [full] : []
    })
  }

  it('no code path deletes a frame, a page or a version row outside the allowlist', () => {
    const offenders: string[] = []
    for (const file of sources(path.join(process.cwd(), 'server'))) {
      const rel = path.relative(process.cwd(), file)
      const text = readFileSync(file, 'utf8')
      const removes = /\.delete\(\s*(t\.)?(frames|frameVersions|pages)\b/.test(text)
      if (removes && !ALLOWED[rel]) offenders.push(rel)
    }
    expect(offenders).toEqual([])
    /* persist keeps no per-frame delete: a frame delete is a flag, not a row removal */
    const persist = readFileSync(path.join(process.cwd(), 'server/db/persist.ts'), 'utf8')
    expect(persist).not.toMatch(/export (async )?function deleteFrame\b/)
    /* the three allowed sites: version trim, deleteCanvas frames, deleteCanvas versions; a fourth needs a reason here */
    expect(persist.match(/\.delete\(\s*t\.(frames|frameVersions|pages)\b/g)).toHaveLength(3)
  })
})
