/* Rule 25 `repeated-markup` (CHE-9115 S7, plan r6): a page rule over the HTML of every frame. A subtree with at least
   two element descendants and some text, that three or more places on the page repeat with the same tags, classes
   and inline style keys (text stripped) and that no `data-doop-component` covers, is markup a component should hold.

   Narrowed from Hallmark 82 (a counting device of empty marks) and 3 (equal icon-above-heading tiles): both are
   Hallmark's, so a subtree without text or with fewer than two descendants, and an icon-above-heading tile, give
   nothing here. Pure over parse5 trees, so it runs without a browser. The walk is iterative: a frame is user HTML and
   can nest to any depth. */

import { parse, type DefaultTreeAdapterTypes as Tree } from 'parse5'
import { COMPONENT_ATTR, INSTANCE_ATTR } from './components.ts'
import type { PageFinding, PageFrameInput, PageRule } from './frameLint.ts'

/** The most candidate subtrees one frame reports. A frame over it is `capped`; `evaluate` skips it and says so. */
export const SUBTREE_HASH_CAP = 5000
/** Identical subtrees needed on the page before the rule speaks. */
export const REPEAT_THRESHOLD = 3

const SKIPPED_TAGS = new Set(['head', 'script', 'style', 'template', 'noscript'])
const HEADING_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6'])

export interface RepeatedEntry {
  /** hash of the normalized subtree */
  hash: string
  /** index into `entries` of the nearest candidate ancestor, or -1 */
  parent: number
  tag: string
  doop_id?: string
  selector: string
}

export interface RepeatedFacts {
  entries: RepeatedEntry[]
  /** the frame held more than `SUBTREE_HASH_CAP` candidates, so `entries` is a part */
  capped: boolean
}

interface Node {
  el: Tree.Element
  parent: number
  /** `tag` or `tag:nth-of-type(n)`, the part this element adds to a selector path */
  part: string
  children: number[]
  ownText: boolean
  inComponent: boolean
  hash: string
  descendants: number
  hasText: boolean
}

const attr = (el: Tree.Element, name: string): string | undefined => el.attrs.find((a) => a.name === name)?.value
const isElement = (node: Tree.ChildNode): node is Tree.Element => 'tagName' in node
const isText = (node: Tree.ChildNode): node is Tree.TextNode => node.nodeName === '#text'
const childNodesOf = (node: Tree.ParentNode): Tree.ChildNode[] => node.childNodes

/** cyrb53: a 53-bit string hash, enough to tell subtrees apart with no practical collision on one page. */
function hashString(text: string): string {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ code, 2654435761)
    h2 = Math.imul(h2 ^ code, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)
}

/** Sorted, de-duplicated class names and inline-style property names: the parts of an element that make its markup. */
function signature(el: Tree.Element): string {
  const classes = [...new Set((attr(el, 'class') ?? '').split(/\s+/).filter(Boolean))].sort()
  const styleKeys = [
    ...new Set(
      (attr(el, 'style') ?? '')
        .split(';')
        .map((decl) => decl.split(':')[0]?.trim().toLowerCase() ?? '')
        .filter(Boolean),
    ),
  ].sort()
  return `${el.tagName}.${classes.join('.')}{${styleKeys.join(',')}}`
}

/** The elements directly under `parent`, skipped tags left out, each with the path part it adds to a selector. */
function elementsUnder(
  parent: Tree.Document | Tree.DocumentFragment | Tree.Element,
): Array<{ el: Tree.Element; part: string }> {
  const kids = childNodesOf(parent)
    .filter(isElement)
    .filter((el) => !SKIPPED_TAGS.has(el.tagName))
  const total = new Map<string, number>()
  for (const kid of kids) total.set(kid.tagName, (total.get(kid.tagName) ?? 0) + 1)
  const seen = new Map<string, number>()
  return kids.map((el) => {
    const n = (seen.get(el.tagName) ?? 0) + 1
    seen.set(el.tagName, n)
    return { el, part: (total.get(el.tagName) ?? 0) > 1 ? `${el.tagName}:nth-of-type(${n})` : el.tagName }
  })
}

/** Pre-order list of the elements below `root`: a node always comes after its parent. */
function walk(root: Tree.Document | Tree.DocumentFragment): Node[] {
  const nodes: Node[] = []
  const pending = elementsUnder(root)
    .reverse()
    .map((kid) => ({ ...kid, parent: -1 }))
  for (let item = pending.pop(); item; item = pending.pop()) {
    const index = nodes.length
    const ownText = childNodesOf(item.el).some((child) => isText(child) && child.value.trim() !== '')
    const parent = nodes[item.parent]
    nodes.push({
      el: item.el,
      parent: item.parent,
      part: item.part,
      children: [],
      ownText,
      inComponent:
        (parent?.inComponent ?? false) ||
        attr(item.el, COMPONENT_ATTR) !== undefined ||
        attr(item.el, INSTANCE_ATTR) !== undefined,
      hash: '',
      descendants: 0,
      hasText: ownText,
    })
    parent?.children.push(index)
    const kids = elementsUnder(item.el)
    for (let k = kids.length - 1; k >= 0; k--) pending.push({ ...kids[k]!, parent: index })
  }
  return nodes
}

/** Children before parents: the hash, the descendant count and whether the subtree holds text. */
function summarize(nodes: Node[]): void {
  for (let i = nodes.length - 1; i >= 0; i--) {
    const node = nodes[i]!
    const kids = node.children.map((index) => nodes[index]!)
    node.hash = hashString(`${signature(node.el)}(${kids.map((kid) => kid.hash).join(',')})`)
    node.descendants = kids.reduce((sum, kid) => sum + kid.descendants + 1, 0)
    node.hasText = node.ownText || kids.some((kid) => kid.hasText)
  }
}

/** Hallmark gate 3's tile: an `svg` or `img` first, with a heading beside it. Equal tiles are equal-width by markup. */
function isIconAboveHeading(node: Node, nodes: Node[]): boolean {
  const kids = node.children.map((index) => nodes[index]!)
  const first = kids[0]
  if (!first || (first.el.tagName !== 'svg' && first.el.tagName !== 'img')) return false
  return kids.some((kid) => HEADING_TAGS.has(kid.el.tagName) || attr(kid.el, 'role') === 'heading')
}

const SELECTOR_MAX_PARTS = 64

function selectorOf(nodes: Node[], index: number): string {
  const doopId = attr(nodes[index]!.el, 'data-doop-id')
  if (doopId) return `[data-doop-id="${doopId.replace(/["\\]/g, '\\$&')}"]`
  const parts: string[] = []
  for (let i = index; i >= 0 && parts.length < SELECTOR_MAX_PARTS; i = nodes[i]!.parent) {
    // the browser collector's paths start below <html>
    if (nodes[i]!.el.tagName !== 'html') parts.unshift(nodes[i]!.part)
    if (nodes[i]!.parent < 0) return parts.join(' > ')
  }
  return `… > ${parts.join(' > ')}`
}

/** Facts of one parsed frame. Exported so a test can feed it a tree built by hand. */
export function collectTree(root: Tree.Document | Tree.DocumentFragment): RepeatedFacts {
  const nodes = walk(root)
  summarize(nodes)
  const entries: RepeatedEntry[] = []
  /** per node: its own entry index, else the nearest candidate ancestor's, else -1 */
  const nearest: number[] = []
  let capped = false
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]!
    const above = node.parent >= 0 ? nearest[node.parent]! : -1
    nearest.push(above)
    const candidate = !node.inComponent && node.descendants >= 2 && node.hasText && !isIconAboveHeading(node, nodes)
    if (!candidate) continue
    if (entries.length >= SUBTREE_HASH_CAP) {
      capped = true
      continue
    }
    const doopId = attr(node.el, 'data-doop-id')
    entries.push({
      hash: node.hash,
      parent: above,
      tag: node.el.tagName,
      ...(doopId ? { doop_id: doopId } : {}),
      selector: selectorOf(nodes, i),
    })
    nearest[i] = entries.length - 1
  }
  return { entries, capped }
}

function collect(html: string): RepeatedFacts {
  return collectTree(parse(html))
}

function isFacts(value: unknown): value is RepeatedFacts {
  return typeof value === 'object' && value !== null && 'entries' in value && 'capped' in value
}

function evaluate(inputs: PageFrameInput[]): PageFinding[] {
  /* a frame with no facts (over the size or fact cap) or one capped here is counted, never read as clean */
  const frames: Array<{ frame_id: string; facts: RepeatedFacts }> = []
  for (const input of inputs) {
    if (isFacts(input.facts) && !input.facts.capped) frames.push({ frame_id: input.frame_id, facts: input.facts })
  }
  const note = frames.length < inputs.length ? ` (considered ${frames.length} of ${inputs.length} frames)` : ''
  const hits = new Map<string, Array<{ frame_id: string; entries: RepeatedEntry[]; index: number }>>()
  for (const { frame_id, facts } of frames) {
    facts.entries.forEach((entry, index) => {
      const list = hits.get(entry.hash) ?? []
      list.push({ frame_id, entries: facts.entries, index })
      hits.set(entry.hash, list)
    })
  }
  const repeated = new Set([...hits].filter(([, list]) => list.length >= REPEAT_THRESHOLD).map(([hash]) => hash))
  const findings: PageFinding[] = []
  for (const list of hits.values()) {
    if (list.length < REPEAT_THRESHOLD) continue
    /* a part of a repeated block repeats with it: report the outer block, not each part */
    const outer = list.filter((hit) => {
      for (let up = hit.entries[hit.index]!.parent; up >= 0; up = hit.entries[up]!.parent) {
        if (repeated.has(hit.entries[up]!.hash)) return false
      }
      return true
    })
    const first = outer[0]
    if (!first || outer.length < REPEAT_THRESHOLD) continue
    const entry = first.entries[first.index]!
    const frameCount = new Set(outer.map((hit) => hit.frame_id)).size
    findings.push({
      frame_id: first.frame_id,
      rule: 'repeated-markup',
      level: 'warn',
      element: { ...(entry.doop_id ? { doop_id: entry.doop_id } : {}), selector: entry.selector },
      message: `${outer.length} identical <${entry.tag}> blocks${frameCount > 1 ? ` across ${frameCount} frames` : ''}, none a component: make one component and reuse it${note}`,
    })
  }
  return findings
}

export const repeatedMarkupRule: PageRule = {
  id: 'repeated-markup',
  collect,
  over: (facts) => isFacts(facts) && facts.capped,
  evaluate,
}
