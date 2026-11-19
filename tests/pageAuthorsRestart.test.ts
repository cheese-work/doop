import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { expect, it } from 'vitest'
import { Client, startServer, type Server } from './harness.ts'

/* CHE-7082: the ledger row survives a real server restart on the same pglite data directory,
   and the boot backfill neither duplicates it nor invents a legacy row for a page that has one. */
async function ledger(server: Server) {
  await server.stopped
  const client = new PGlite(path.join(server.dataDir, 'data', 'pg'))
  try {
    const result = await client.query<{ canvas_id: string; page_id: string; kind: string; source: string }>(
      'select canvas_id, page_id, kind, source from page_authors order by first_at, id',
    )
    return result.rows
  } finally {
    await client.close()
  }
}

it('keeps the writer row across a restart and backfills once', async () => {
  let server: Server = await startServer()
  try {
    const owner = await new Client(server).signUp('ledger@test.dev', 'Ledger Owner')
    const canvas = await (await owner.post('/api/canvases', { name: 'Ledger' })).json()
    const frame = await owner.post(`/api/canvases/${canvas.id}/frames`, { name: 'Frame', html: '<p>hi</p>' })
    expect(frame.status).toBe(200)

    const dataDir = server.dataDir
    server.stop({ keepData: true })
    const first = await ledger(server)
    expect(first.filter((row) => row.canvas_id === canvas.id)).toMatchObject([{ kind: 'user', source: 'write' }])

    server = await startServer({}, dataDir)
    server.stop({ keepData: true })
    const second = await ledger(server)
    expect(second.filter((row) => row.canvas_id === canvas.id)).toEqual(
      first.filter((row) => row.canvas_id === canvas.id),
    )
  } finally {
    server.stop()
  }
}, 60_000)
