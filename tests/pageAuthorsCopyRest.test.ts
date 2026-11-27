import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { expect, it } from 'vitest'
import { Client, startServer, type Server } from './harness.ts'

/* CHE-7083: a paste or duplicate that names `copiedFrom` carries the source page's writers into the new page, and
   survives a restart. A source the caller cannot read, or a malformed list, is refused. */
async function ledger(server: Server, canvasId: string) {
  await server.stopped
  const client = new PGlite(path.join(server.dataDir, 'data', 'pg'))
  try {
    const result = await client.query<{ page_id: string; kind: string; source: string; source_page_id: string }>(
      'select page_id, kind, source, source_page_id from page_authors where canvas_id = $1 order by source, source_page_id',
      [canvasId],
    )
    return result.rows
  } finally {
    await client.close()
  }
}

it('POST frames with copiedFrom writes copy rows; a bad or unreadable source is refused', async () => {
  const server = await startServer()
  try {
    const owner = await new Client(server).signUp('copy-owner@test.dev', 'Copy Owner')
    const stranger = await new Client(server).signUp('copy-stranger@test.dev', 'Stranger')
    const source = await (await owner.post('/api/canvases', { name: 'Source' })).json()
    const target = await (await owner.post('/api/canvases', { name: 'Target' })).json()
    const other = await (await stranger.post('/api/canvases', { name: 'Theirs' })).json()
    const sourcePage = source.pages[0].id as string
    expect((await owner.post(`/api/canvases/${source.id}/frames`, { name: 'S', html: '<p>s</p>' })).status).toBe(200)

    const pasted = await owner.post(`/api/canvases/${target.id}/frames`, {
      name: 'Pasted',
      html: '<p>s</p>',
      copiedFrom: [{ canvasId: source.id, pageId: sourcePage }],
    })
    expect(pasted.status).toBe(200)

    for (const copiedFrom of ['nope', [{ canvasId: source.id }], Array.from({ length: 101 }, () => ({}))]) {
      const refused = await owner.post(`/api/canvases/${target.id}/frames`, { name: 'x', html: '<p/>', copiedFrom })
      expect(refused.status).toBe(400)
    }
    /* a canvas the caller cannot read is never inherited from */
    const unreadable = await owner.post(`/api/canvases/${target.id}/frames`, {
      name: 'x',
      html: '<p/>',
      copiedFrom: [{ canvasId: other.id, pageId: other.pages[0].id }],
    })
    expect(unreadable.status).toBeGreaterThanOrEqual(400)

    server.stop({ keepData: true })
    const rows = await ledger(server, target.id)
    expect(rows).toMatchObject([
      { kind: 'user', source: 'copy', source_page_id: sourcePage },
      { kind: 'user', source: 'write', source_page_id: '' },
    ])
  } finally {
    server.stop()
  }
}, 60_000)
