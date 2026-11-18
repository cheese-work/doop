import type { Client } from './harness.ts'

/* G3 ruleset g3-r6 (CHE-6853) asks for more than the frames of a proposal page: a `Motion` page with the
   issue's spec frame and an animated frame, and a doc frame for each hi-fi screen. These are the smallest ones. */

export const SECTIONS = ['Purpose', 'UX reasoning', 'UI reasoning', 'Ergonomics', 'States', 'Motion', 'Accessibility']
export const DOC_HTML = SECTIONS.map((h) => `<h3>${h}</h3><p>${h} is written here.</p>`).join('')
export const SPEC_HTML = `<table><tr><th>Name</th><th>Animated frame</th></tr><tr><td>fade</td><td>Fade</td></tr></table>`
export const ANIM_HTML = `<style>@keyframes f{from{opacity:0}to{opacity:1}} .b{animation:f 200ms}</style><div class="b"></div>`

/** Add the Motion page (spec frame `<key> · motion` and an animated frame) and a doc frame for each named hi-fi screen. */
export async function addMotionAndDocs(owner: Client, canvasId: string, key: string, hifiNames: string[]) {
  const post = async (name: string, html: string, pageId?: string) =>
    (await owner.post(`/api/canvases/${canvasId}/frames`, { name, html, ...(pageId ? { pageId } : {}) })).json()
  const pages = (await (await owner.get(`/api/canvases/${canvasId}`)).json()).pages as { id: string; name: string }[]
  const put = await owner.req(`/api/canvases/${canvasId}/pages`, {
    method: 'PUT',
    body: JSON.stringify({ pages: [...pages, { id: `${canvasId}:motion`, name: 'Motion' }], expectedPages: pages }),
  })
  if (put.status !== 200) throw new Error(`could not add the Motion page: ${put.status}`)
  const motion = `${canvasId}:motion`
  await post(`${key} · motion`, SPEC_HTML, motion)
  await post('Fade', ANIM_HTML, motion)
  for (const name of hifiNames) await post(`${name} · doc`, DOC_HTML)
}
