/* Page rules 5, "Missing states" (CHE-9115 S6, plan r6 "Ask 5 states, per control"): `state-collapsed`,
   `state-ime-open`, `state-error`, `state-loading` and `state-unpaired`. parse5 over the frame HTML, no browser.
   `collect` reads one frame; `evaluate` runs over what was collected from every frame on the page, because a state
   drawn in one frame may satisfy a control of another, and only through a pairing identity (see `pairingKeys`).
   Warning mode only: nothing here blocks a gate, a publish or a lock. G3 `component_states_missing` owns the states
   of a Components-page component, so an element inside a `data-doop-component` is skipped. */

import { parse, type DefaultTreeAdapterTypes as Tree } from 'parse5'
import type { PageFinding, PageFrameInput, PageRule } from './frameLint.ts'

type Element = Tree.Element

/** Controls read from one frame. A frame over this is skipped, like one over the size cap (plan S3p fact cap). */
export const STATE_CONTROL_CAP = 1000

const STATE_RULES = ['state-collapsed', 'state-ime-open', 'state-error', 'state-loading'] as const
type StateRule = (typeof STATE_RULES)[number]

/** A control the frame draws, with what the state rules need to know about it. */
interface StateControl {
  selector: string
  doop_id?: string
  /** pairing identity keys: `id:<data-doop-id>` and `form:<form key>|<field key>`; none means no stable identity */
  keys: string[]
  /** the state rules that ask this control for a state */
  ask: StateRule[]
  /** the aria-expanded value, when it is `true` or `false` */
  expanded?: 'true' | 'false'
  /** the control itself is drawn invalid (`aria-invalid="true"` or `data-doop-state="error"`) */
  error_shown: boolean
  /** the control itself is drawn busy (`aria-busy="true"` or `data-doop-state="loading"`) */
  loading_shown: boolean
  /** states cleared by `data-doop-state-na="<state>: <reason>"` */
  na: string[]
}

interface StatesFacts {
  /** the frame has an element with `data-doop-state="ime-open"` */
  ime_open: boolean
  controls: StateControl[]
}

/** What `collect` returns: a frame that is not a design frame, or one over the control cap, has no controls to read. */
type Collected = { kind: 'facts'; facts: StatesFacts } | { kind: 'recon' } | { kind: 'over' }

const TEXT_TYPES = new Set(['', 'text', 'search', 'email', 'url', 'tel', 'password', 'number'])
const SELECTOR_STEPS = 12
const SELECTOR_LENGTH = 200

const isElement = (node: Tree.ChildNode): node is Element => 'tagName' in node

function attr(el: Element, name: string): string | undefined {
  return el.attrs.find((a) => a.name === name)?.value
}

const lowered = (value: string | undefined) => (value ?? '').trim().toLowerCase()

/** The sibling position of every element below one parent, by tag: built once per parent, so a wide frame does not
 *  cost a scan of the siblings for each control. */
function siblingIndex(parent: Tree.ParentNode, cache: Map<Tree.ParentNode, Map<Element, [number, number]>>) {
  let index = cache.get(parent)
  if (index) return index
  index = new Map()
  const byTag = new Map<string, Element[]>()
  for (const child of parent.childNodes) {
    if (!isElement(child)) continue
    const same = byTag.get(child.tagName) ?? []
    same.push(child)
    byTag.set(child.tagName, same)
  }
  for (const same of byTag.values()) same.forEach((el, i) => index!.set(el, [i + 1, same.length]))
  cache.set(parent, index)
  return index
}

/** A CSS path below `body` that finds the element again: `:nth-of-type` only where a same-tag sibling exists. */
function selectorOf(el: Element, cache: Map<Tree.ParentNode, Map<Element, [number, number]>>): string {
  const id = attr(el, 'data-doop-id')
  if (id) return `[data-doop-id="${id.replace(/["\\]/g, '\\$&')}"]`
  const steps: string[] = []
  let length = 0
  for (let node: Tree.ParentNode | null = el; node && 'tagName' in node; node = node.parentNode) {
    const tag = node.tagName
    if (tag === 'html' || tag === 'body') break
    const [nth, total] = node.parentNode ? (siblingIndex(node.parentNode, cache).get(node) ?? [1, 1]) : [1, 1]
    const step = total > 1 ? `${tag}:nth-of-type(${nth})` : tag
    steps.unshift(step)
    length += step.length + 3
    if (steps.length >= SELECTOR_STEPS || length > SELECTOR_LENGTH) break
  }
  return steps.join(' > ')
}

function isSubmit(el: Element, inForm: boolean): boolean {
  const type = lowered(attr(el, 'type'))
  if (el.tagName === 'input') return type === 'submit'
  if (el.tagName !== 'button') return false
  return type === 'submit' || (inForm && type !== 'button' && type !== 'reset')
}

function isTextField(el: Element): boolean {
  if (el.tagName === 'textarea') return true
  return el.tagName === 'input' && TEXT_TYPES.has(lowered(attr(el, 'type')))
}

function isEditable(el: Element): boolean {
  const value = attr(el, 'contenteditable')
  return value !== undefined && lowered(value) !== 'false'
}

/** `data-doop-state-na="<state>: <reason>"`: the same reading as G3, and a missing reason clears nothing. */
function notApplicable(el: Element): string[] {
  const value = attr(el, 'data-doop-state-na')
  if (value === undefined) return []
  const [state = '', ...reason] = value.split(':')
  return reason.join(':').trim() ? [lowered(state)] : []
}

/** The pairing identity of a control (plan F3): its `data-doop-id`, or its form-scoped key. A page-wide `name`, `id`,
 *  role or accessible name is never one. */
function pairingKeys(el: Element, form: string[] | undefined): string[] {
  const keys: string[] = []
  const doopId = attr(el, 'data-doop-id')
  if (doopId) keys.push(`id:${doopId}`)
  if (form?.length) {
    const name = attr(el, 'name')
    const id = attr(el, 'id')
    const fields = [...(name ? [`n:${name}`] : []), ...(id ? [`i:${id}`] : [])]
    for (const f of form) for (const field of fields) keys.push(`form:${f}|${field}`)
  }
  return keys
}

interface Pending {
  el: Element
  form: string[] | undefined
  inForm: boolean
}

function collect(html: string): Collected {
  const doc = parse(html)
  const cache = new Map<Tree.ParentNode, Map<Element, [number, number]>>()
  const found: Array<{ pending: Pending; text: boolean; editable: boolean; select: boolean; submit: boolean }> = []
  let wireframe = false
  let imeOpen = false
  /* the walk is iterative: frame HTML is untrusted and may nest deeper than the call stack allows */
  const stack: Array<Pending & { component: boolean }> = []
  const push = (parent: Tree.ParentNode, form: string[] | undefined, inForm: boolean, component: boolean) => {
    const children = parent.childNodes.filter(isElement)
    for (let i = children.length - 1; i >= 0; i--) stack.push({ el: children[i]!, form, inForm, component })
  }
  push(doc, undefined, false, false)
  for (let next = stack.pop(); next; next = stack.pop()) {
    const { el, component } = next
    if (el.tagName === 'script' && attr(el, 'id') === 'doop-recon') return { kind: 'recon' }
    if (attr(el, 'data-doop-stage') === 'wireframe') wireframe = true
    if (lowered(attr(el, 'data-doop-state')) === 'ime-open') imeOpen = true
    let form = next.form
    let inForm = next.inForm
    if (el.tagName === 'form') {
      inForm = true
      const parts: string[] = []
      const doopId = attr(el, 'data-doop-id')
      const id = attr(el, 'id')
      if (doopId) parts.push(`d:${doopId}`)
      if (id) parts.push(`i:${id}`)
      form = parts
    }
    const inComponent = component || attr(el, 'data-doop-component') !== undefined
    if (!inComponent) {
      const expanded = lowered(attr(el, 'aria-expanded'))
      const control = {
        pending: { el, form, inForm },
        text: isTextField(el),
        editable: isEditable(el),
        select: el.tagName === 'select',
        submit: isSubmit(el, inForm),
      }
      if (
        expanded === 'true' ||
        expanded === 'false' ||
        control.text ||
        control.editable ||
        control.select ||
        control.submit
      ) {
        if (found.length >= STATE_CONTROL_CAP) return { kind: 'over' }
        found.push(control)
      }
    }
    push(el, form, inForm, inComponent)
  }
  const controls: StateControl[] = []
  for (const { pending, text, editable, select, submit } of found) {
    const { el, form } = pending
    const expanded = lowered(attr(el, 'aria-expanded'))
    const state = lowered(attr(el, 'data-doop-state'))
    const ask: StateRule[] = []
    if (expanded === 'true' || expanded === 'false') ask.push('state-collapsed')
    if ((text || editable) && !wireframe) ask.push('state-ime-open')
    if (text || select) ask.push('state-error')
    if (submit) ask.push('state-loading')
    if (!ask.length) continue
    const doopId = attr(el, 'data-doop-id')
    controls.push({
      selector: selectorOf(el, cache),
      ...(doopId ? { doop_id: doopId } : {}),
      keys: pairingKeys(el, form),
      ask,
      ...(expanded === 'true' || expanded === 'false' ? { expanded } : {}),
      error_shown: lowered(attr(el, 'aria-invalid')) === 'true' || state === 'error',
      loading_shown: lowered(attr(el, 'aria-busy')) === 'true' || state === 'loading',
      na: notApplicable(el),
    })
  }
  return { kind: 'facts', facts: { ime_open: imeOpen, controls } }
}

const isCollected = (value: unknown): value is Collected =>
  typeof value === 'object' && value !== null && 'kind' in value

const ASK: Record<StateRule, string> = {
  'state-collapsed': 'Disclosure drawn in one state only: no frame shows the other aria-expanded value',
  'state-ime-open': 'No frame with data-doop-state="ime-open" shows this field',
  'state-error': 'No error state drawn for this field (aria-invalid="true" or data-doop-state="error")',
  'state-loading': 'No loading state drawn for this submit button (aria-busy="true" or data-doop-state="loading")',
}

const ruleState = (rule: StateRule) => rule.slice('state-'.length)

interface UsableFrame {
  frame_id: string
  facts: StatesFacts
  /** how many controls of this frame carry each pairing key; a key that is not 1 is ambiguous and pairs nothing */
  keyCount: Map<string, number>
}

function evaluate(inputs: PageFrameInput[]): PageFinding[] {
  const frames: UsableFrame[] = []
  let skipped = 0
  for (const input of inputs) {
    if (input.hidden) continue
    const collected = isCollected(input.facts) ? input.facts : undefined
    if (collected?.kind === 'recon') continue
    if (collected?.kind !== 'facts') {
      /* skipped (no facts) or over the control cap: counted, and it never clears a warning */
      skipped++
      continue
    }
    const keyCount = new Map<string, number>()
    for (const control of collected.facts.controls)
      for (const key of new Set(control.keys)) keyCount.set(key, (keyCount.get(key) ?? 0) + 1)
    frames.push({ frame_id: input.frame_id, facts: collected.facts, keyCount })
  }
  /* the controls that carry a key, by key, over every frame where that key is unambiguous */
  const byKey = new Map<string, Array<{ frame: UsableFrame; control: StateControl }>>()
  for (const frame of frames)
    for (const control of frame.facts.controls)
      for (const key of new Set(control.keys))
        if (frame.keyCount.get(key) === 1) byKey.set(key, [...(byKey.get(key) ?? []), { frame, control }])

  const evidence = (frame: UsableFrame, control: StateControl, rule: StateRule): boolean => {
    const own =
      rule === 'state-ime-open'
        ? frame.facts.ime_open
        : rule === 'state-error'
          ? control.error_shown
          : rule === 'state-loading'
            ? control.loading_shown
            : false
    if (own || control.na.includes(ruleState(rule))) return true
    for (const key of new Set(control.keys)) {
      if (frame.keyCount.get(key) !== 1) continue
      for (const other of byKey.get(key) ?? []) {
        if (other.frame === frame) continue
        if (rule === 'state-ime-open' && other.frame.facts.ime_open) return true
        if (rule === 'state-error' && other.control.error_shown) return true
        if (rule === 'state-loading' && other.control.loading_shown) return true
        if (rule === 'state-collapsed' && other.control.expanded && other.control.expanded !== control.expanded)
          return true
      }
    }
    return false
  }

  const note = skipped ? `; pairing incomplete: ${skipped} frames skipped` : ''
  const findings: PageFinding[] = []
  for (const frame of frames) {
    for (const control of frame.facts.controls) {
      const missing = control.ask.filter((rule) => !evidence(frame, control, rule))
      if (!missing.length) continue
      const element = { ...(control.doop_id ? { doop_id: control.doop_id } : {}), selector: control.selector }
      if (!control.keys.length) {
        findings.push({
          frame_id: frame.frame_id,
          rule: 'state-unpaired',
          level: 'warn',
          element,
          message: `No stable identity; add data-doop-id so its states can pair (missing: ${missing.map(ruleState).join(', ')})${note}`,
        })
        continue
      }
      for (const rule of missing)
        findings.push({
          frame_id: frame.frame_id,
          rule,
          level: 'warn',
          element,
          message: `${ASK[rule]}; or add data-doop-state-na="${ruleState(rule)}: <reason>"${note}`,
        })
    }
  }
  return findings
}

export const statesPageRule: PageRule = { id: 'states', collect, evaluate }
