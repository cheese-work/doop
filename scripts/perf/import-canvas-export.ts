/* Recreate a canvas JSON exported from another doop (GET /api/canvases/<id>) on a local instance
 * (CHE-6196). The new canvas gets a new id; pages and frames keep their names, order and geometry.
 * `cookie` is the session of an account on the target instance, never one from the source. */

export interface CanvasExport {
  id: string
  name: string
  pages: { id: string; name: string }[]
  frames: { pageId?: string; name: string; x: number; y: number; width: number; height: number; html?: string }[]
}

async function call<T>(baseUrl: string, cookie: string, method: string, path: string, body: unknown): Promise<T> {
  const res = await fetch(baseUrl + path, {
    method,
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`${method} ${path} answered ${res.status}: ${(await res.text()).slice(0, 200)}`)
  return (await res.json()) as T
}

export async function importCanvasExport(baseUrl: string, cookie: string, exported: CanvasExport): Promise<string> {
  const created = await call<{ id: string; pages?: { id: string; name: string }[] }>(
    baseUrl,
    cookie,
    'POST',
    '/api/canvases',
    { name: exported.name },
  )
  const id = created.id
  // page ids embed the canvas id (`<id>:page1`), so each one is rebuilt for the new canvas
  const pageIds = new Map(exported.pages.map((p, i) => [p.id, `${id}:p${i + 1}`]))
  const pages = exported.pages.map((p) => ({ id: pageIds.get(p.id)!, name: p.name }))
  await call(baseUrl, cookie, 'PUT', `/api/canvases/${id}/pages`, {
    pages,
    expectedPages: created.pages ?? [{ id: `${id}:page1`, name: 'Page 1' }],
  })
  // one at a time: auto-placement and the response order must match the export
  for (const f of exported.frames) {
    const pageId = pageIds.get(f.pageId ?? exported.pages[0]!.id)
    await call(baseUrl, cookie, 'POST', `/api/canvases/${id}/frames`, {
      name: f.name,
      pageId,
      x: f.x,
      y: f.y,
      width: f.width,
      height: f.height,
      html: f.html,
    })
  }
  return id
}
