import { createHash } from 'node:crypto'
import { SLOPLINT_SHA } from '../shared/designCompleteness.ts'
import type { Client } from './harness.ts'

/* G3 ruleset g3-r6 (CHE-6853) asks for more than the frames of a proposal page: a `Motion` page with the
   issue's spec frame and an animated frame, and a doc frame for each hi-fi screen. These are the smallest ones. */

export const SECTIONS = ['Purpose', 'UX reasoning', 'UI reasoning', 'Ergonomics', 'States', 'Motion', 'Accessibility']
export const DOC_HTML = SECTIONS.map((h) => `<h3>${h}</h3><p>${h} is written here.</p>`).join('')
export const SPEC_HTML = `<table><tr><th>Name</th><th>Animated frame</th></tr><tr><td>fade</td><td>Fade</td></tr><tr><td>Button · hover</td><td>Fade</td></tr></table>`
export const ANIM_HTML = `<style>@keyframes f{from{opacity:0}to{opacity:1}} .b{animation:f 200ms}</style><div class="b"></div>`

/* G3 ruleset g3-r7 (CHE-6854): a `Components` page with a tokens frame and one component, Button, with every state drawn or n/a */
export const TOKENS_HTML = `<style>:root{--color-ink:#111;--type-body:14px;--space-2:8px;--radius-md:6px}</style><div data-doop-tokens></div>`
const MOTION = JSON.stringify({
  trigger: 'hover',
  property: 'opacity',
  duration: '200ms',
  easing: 'ease',
  reducedMotion: 'none',
})
export const BUTTON_HTML = `<div data-doop-component="Button"><b data-doop-variant="primary" data-doop-state="default"></b>
<b data-doop-state="hover" data-doop-motion='${MOTION}'></b><i data-doop-state-na="focus: native ring"></i><i data-doop-state-na="disabled: never"></i>
<i data-doop-state-na="loading: never"></i><i data-doop-state-na="error: never"></i></div>`

/** The `sloplint` argument of check_design_completeness: a result per visible, non-recon frame of the first page, as a reviewer would send them. */
export async function sloplintFor(owner: Client, canvasId: string) {
  const frames = (await (await owner.get(`/api/canvases/${canvasId}`)).json()).frames as {
    id: string
    html: string
    updatedAt: number
    pageId?: string
    hidden?: boolean
  }[]
  const result_json = JSON.stringify({ findings: [] })
  return frames
    .filter((f) => !f.pageId?.match(/:(motion|components)$/) && !f.hidden && !f.html.includes('doop-recon'))
    .map((f) => ({
      frame_id: f.id,
      updated_at: f.updatedAt,
      tool_sha: SLOPLINT_SHA,
      result_json,
      sha256: createHash('sha256').update(result_json).digest('hex'),
    }))
}

/** Add the Motion and Components pages (spec frame `<key> · motion`, an animated frame, tokens and Button) and a doc frame for each named hi-fi screen. */
export async function addMotionAndDocs(owner: Client, canvasId: string, key: string, hifiNames: string[]) {
  const post = async (name: string, html: string, pageId?: string) =>
    (await owner.post(`/api/canvases/${canvasId}/frames`, { name, html, ...(pageId ? { pageId } : {}) })).json()
  const pages = (await (await owner.get(`/api/canvases/${canvasId}`)).json()).pages as { id: string; name: string }[]
  const put = await owner.req(`/api/canvases/${canvasId}/pages`, {
    method: 'PUT',
    body: JSON.stringify({
      pages: [...pages, { id: `${canvasId}:motion`, name: 'Motion' }],
      expectedPages: pages,
    }),
  })
  if (put.status !== 200) throw new Error(`could not add the Motion page: ${put.status}`)
  const motion = `${canvasId}:motion`
  await post(`${key} · motion`, SPEC_HTML, motion)
  await post('Fade', ANIM_HTML, motion)
  /* a real component: its main carries the definition's id (the engine drops a name-keyed marker), and making it adds the Components page */
  const made = await owner.post(`/api/canvases/${canvasId}/components`, {
    name: 'Button',
    html: BUTTON_HTML.replace(' data-doop-component="Button"', ''),
    autoProps: false,
  })
  if (made.status !== 200 && made.status !== 201) throw new Error(`could not create Button: ${made.status}`)
  const after = (await (await owner.get(`/api/canvases/${canvasId}`)).json()).pages as { id: string; name: string }[]
  await post('Tokens', TOKENS_HTML, after.find((p) => p.name === 'Components')!.id)
  for (const name of hifiNames) await post(`${name} · doc`, DOC_HTML)
}
