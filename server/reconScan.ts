import { createHash } from 'node:crypto'
import { posix } from 'node:path'

/**
 * recon-scan (G2, CHE-6078 r5): reads product source, starting from the screens a designer names,
 * and lists the interactive candidates a recon must photograph: buttons, menus, selects/toggles
 * with every value, inputs, aria-labelled and test-id'd elements.
 *
 * A HEURISTIC floor under the designer's memory, not a proof of completeness. Known limits:
 * relative imports only (no aliases, no dynamic or barrel re-export resolution); line-based regexes,
 * so a control built by a helper function or named something unlisted is missed; device visibility
 * comes from `hidden`/`md:` classes on the same line only. Read-only: it never writes anything.
 */

export const DEVICES = [1440, 390] as const

export type ScanCandidate = {
  /** `<file>:<line>:<kind>`, stable for one source revision */
  id: string
  file: string
  line: number
  kind: string
  /** the visible states to photograph besides the resting one: every select value, menu `open`, toggle `on`/`off` */
  states: string[]
  /** devices the candidate exists on, when a class on its line hides it from the others */
  devices?: number[]
  /** the screens (scan roots) whose import graph reaches this file */
  screens: string[]
}
export type ReconScan = { screens: string[]; candidates: ScanCandidate[] }
export type ExpectedCell = { key: string; screen: string; device: number; candidate?: string; state?: string }

const NAME_END = String.raw`(?![\w-])`
const tag = (names: string) => new RegExp(`<(?:${names})${NAME_END}`)
const PATTERNS: { kind: string; re: RegExp; states?: string[]; values?: boolean }[] = [
  { kind: 'button', re: new RegExp(`<(?:Button|button)${NAME_END}|role="button"`) },
  { kind: 'icon', re: tag('MoreHorizontal|MoreVertical|Ellipsis|EllipsisVertical') },
  { kind: 'menu', re: tag('DropdownMenu|ContextMenu|Popover|Menu'), states: ['open'] },
  { kind: 'select', re: tag('Select|select|RadioGroup|ToggleGroup|Tabs'), values: true },
  {
    kind: 'toggle',
    re: new RegExp(`<(?:Switch|Checkbox|Toggle)${NAME_END}|<input[^>]*type=["'](?:checkbox|radio)["']`),
    states: ['on', 'off'],
  },
  { kind: 'input', re: tag('Input|input|Textarea|textarea') },
  { kind: 'labelled', re: /aria-label=/ },
  { kind: 'testid', re: /data-testid=/ },
]
const SELECT_END = /<\/(?:Select|select|RadioGroup|ToggleGroup|Tabs)>/
const SELECT_ITEM = /<(?:SelectItem|RadioGroupItem|ToggleGroupItem|TabsTrigger|option)\b[^>]*?\bvalue=["'{]+([^"'}]+)/
const SORT_TEXT = /\b(?:newest|oldest)[ -]first\b/i
const MAX_VALUE_LINES = 60

const CLASS_HIDDEN = /(?:^|[\s"'`])hidden(?=[\s"'`])/
const CLASS_SHOW_UP = /\b(?:sm|md|lg|xl):(?:flex|block|inline-flex|inline-block|inline|grid)\b/
const CLASS_HIDDEN_BELOW = /\b(?:max-sm|max-md|max-lg):hidden\b/
const CLASS_HIDDEN_ABOVE = /\b(?:sm|md|lg|xl):hidden\b/

function devicesOf(line: string): number[] | undefined {
  if ((CLASS_HIDDEN.test(line) && CLASS_SHOW_UP.test(line)) || CLASS_HIDDEN_BELOW.test(line)) return [1440]
  if (CLASS_HIDDEN_ABOVE.test(line)) return [390]
  return undefined
}

const EXTENSIONS = ['', '.tsx', '.ts', '.jsx', '.js', '/index.tsx', '/index.ts', '/index.jsx', '/index.js']
const IMPORT_RE = /(?:import|export)\b[^'"`;]*?from\s*['"](\.[^'"]+)['"]|import\(\s*['"](\.[^'"]+)['"]\s*\)/g

/** every file reachable from `root` through relative imports that are in `files` */
function reach(files: Record<string, string>, root: string): string[] {
  const seen = [root]
  for (let i = 0; i < seen.length; i++) {
    const from = seen[i]!
    const source = files[from]
    if (source === undefined) continue
    for (const m of source.matchAll(IMPORT_RE)) {
      const spec = m[1] ?? m[2]!
      const base = posix.join(posix.dirname(from), spec)
      const hit = EXTENSIONS.map((ext) => base + ext).find((p) => files[p] !== undefined)
      if (hit && !seen.includes(hit)) seen.push(hit)
    }
  }
  return seen
}

function scanFile(file: string, source: string): Omit<ScanCandidate, 'screens'>[] {
  const lines = source.split('\n')
  const out: Omit<ScanCandidate, 'screens'>[] = []
  let sortSeen = false
  for (const [i, text] of lines.entries()) {
    const line = i + 1
    const add = (kind: string, states: string[]) =>
      out.push({ id: `${file}:${line}:${kind}`, file, line, kind, states, ...devicesFor(text) })
    const isToggle = PATTERNS.find((p) => p.kind === 'toggle')!.re.test(text)
    for (const p of PATTERNS) {
      if (!p.re.test(text)) continue
      if (p.kind === 'input' && isToggle) continue
      if (p.values) {
        const states: string[] = []
        for (const next of lines.slice(i, i + MAX_VALUE_LINES)) {
          const value = SELECT_ITEM.exec(next)?.[1]
          if (value && !states.includes(value)) states.push(value)
          if (SELECT_END.test(next)) break
        }
        add(p.kind, states)
      } else add(p.kind, p.states ?? [])
    }
    /* a sort written as text ("Newest first"), once per file: both directions are states to photograph */
    if (!sortSeen && SORT_TEXT.test(text) && !SELECT_ITEM.test(text)) {
      sortSeen = true
      add('toggle', ['newest-first', 'oldest-first'])
    }
  }
  return out
}
const devicesFor = (text: string) => {
  const devices = devicesOf(text)
  return devices ? { devices } : {}
}

/** `files`: repo-relative path -> source text. `screens`: the root files the designer names. */
export function scanSources(files: Record<string, string>, screens: string[]): ReconScan {
  const byId = new Map<string, ScanCandidate>()
  for (const screen of screens) {
    for (const file of reach(files, screen)) {
      for (const c of scanFile(file, files[file] ?? '')) {
        const known = byId.get(c.id)
        if (known) known.screens.push(screen)
        else byId.set(c.id, { ...c, screens: [screen] })
      }
    }
  }
  const candidates = [...byId.values()].sort(
    (a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.kind.localeCompare(b.kind),
  )
  return { screens, candidates }
}

/** The photo matrix the scan demands: each screen x device at rest, plus each candidate state x device. */
export function expectedCells(scan: ReconScan): ExpectedCell[] {
  const cells: ExpectedCell[] = []
  for (const screen of scan.screens)
    for (const device of DEVICES) {
      cells.push({ key: `${screen}|${device}||`, screen, device })
      for (const c of scan.candidates)
        if (c.screens.includes(screen))
          for (const state of c.states)
            cells.push({ key: `${screen}|${device}|${c.id}|${state}`, screen, device, candidate: c.id, state })
    }
  return cells
}

export function hashScan(scan: ReconScan): string {
  return createHash('sha256').update(JSON.stringify(scan)).digest('hex')
}
