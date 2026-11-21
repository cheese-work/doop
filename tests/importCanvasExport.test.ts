import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { importCanvasExport, type CanvasExport } from '../scripts/perf/import-canvas-export.ts'
import { summarizeCanvas } from '../scripts/perf/measure-canvas-load.ts'
import { Client, startServer, type Server } from './harness.ts'

/* CHE-6196: a canvas JSON exported from another doop lands in a local instance with
   its pages, frame order, geometry and HTML intact, under the new canvas id. */

const PNG = 'data:image/png;base64,AAAA'
const exported: CanvasExport = {
  id: 'SRCcanvas01',
  name: 'multica',
  pages: [
    { id: 'SRCcanvas01:page1', name: 'Baseline' },
    { id: 'SRCcanvas01:flows', name: 'Flows' },
  ],
  frames: [
    { pageId: 'SRCcanvas01:page1', name: 'A', x: 10, y: 20, width: 300, height: 200, html: '<p>héllo</p>' },
    { pageId: 'SRCcanvas01:flows', name: 'B', x: 400, y: 20, width: 320, height: 240, html: `<img src="${PNG}">` },
    { pageId: 'SRCcanvas01:page1', name: 'C', x: 800, y: 20, width: 100, height: 100, html: '<p>c</p>' },
  ],
}

let server: Server
let client: Client
beforeAll(async () => {
  server = await startServer()
  client = await new Client(server).signUp('import@example.com', 'Import')
})
afterAll(() => server.stop())

describe('importCanvasExport', () => {
  it('recreates pages, frames and their HTML under a new canvas id', async () => {
    const id = await importCanvasExport(server.base, client.header(), exported)
    expect(id).not.toBe(exported.id)
    const got = (await (await client.get(`/api/canvases/${id}`)).json()) as CanvasExport
    expect(got.name).toBe('multica')
    expect(got.pages.map((p) => p.name)).toEqual(['Baseline', 'Flows'])
    // each frame sits on the page with the same name as in the export (its first column)
    const pageName = (c: CanvasExport, pageId?: string) => c.pages.find((p) => p.id === pageId)?.name
    /* cheese/main keeps frames stacked per page, so the canvas lists them page by
       page: compare the order within each page (a stable sort by page name) */
    const byPage = (c: CanvasExport) =>
      c.frames
        .map((f) => [pageName(c, f.pageId) ?? '', f.name, f.x, f.y, f.width, f.height, f.html] as const)
        .sort((a, b) => a[0].localeCompare(b[0]))
    expect(byPage(got)).toEqual(byPage(exported))
    expect(summarizeCanvas(got)).toEqual(summarizeCanvas(exported))
  })

  it('fails loudly, naming the status, when the session cannot edit', async () => {
    await expect(importCanvasExport(server.base, '', exported)).rejects.toThrow(/401/)
  })
})
