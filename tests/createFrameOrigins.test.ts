import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/* CHE-7083 (S4 of CHE-7064): every `createFrame` caller declares where its content comes from. The compiler already
   demands an origin argument; this table pins WHICH origin each caller declares, so a caller that starts copying
   content (and so must inherit the source page's authors) cannot keep saying `new` unnoticed. */
const root = path.resolve(import.meta.dirname, '..')

/** the text of each `createFrame(...)` call in a file, balanced to its closing paren */
function calls(file: string): string[] {
  const src = fs.readFileSync(path.join(root, file), 'utf8')
  const out: string[] = []
  for (const match of src.matchAll(/(?<!function )\bcreateFrame\(/g)) {
    const start = match.index! + match[0].length
    let depth = 1
    let i = start
    for (; i < src.length && depth > 0; i++) {
      if (src[i] === '(') depth++
      else if (src[i] === ')') depth--
    }
    out.push(src.slice(start, i - 1))
  }
  return out
}

/** the origin a call passes: the literal `new`, the `origin` a route computed, or a `copy` literal */
function originOf(call: string): string {
  const tail = call
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/,\s*([}\]])/g, ' $1')
    .replace(/,$/, '')
  if (/\{ kind: 'new' \}$/.test(tail)) return 'new'
  if (/\{ kind: 'copy'/.test(tail)) return 'copy'
  if (/\borigin$/.test(tail)) return 'origin'
  return `unknown: ${tail.slice(-60)}`
}

/** file -> the origin of each of its callers, in source order. A caller that copies content declares `copy`
 *  (or, for the REST route that takes it from the client, a computed `origin`). */
const CALLERS: Record<string, string[]> = {
  'server/actions.ts': ['origin'], // the passthrough to the store hands on the origin its own caller declared
  'server/demo.ts': ['new'],
  'server/githubRecon.ts': ['new'],
  'server/index.ts': ['origin', 'new', 'new'], // REST create (new, or copy when the client names copiedFrom); import; clone-from-url
  'server/ingest.ts': ['new'],
  'server/mcp.ts': ['new'],
  'server/meta.ts': ['new'],
  'server/resident.ts': ['new'],
  'server/seed.ts': ['new', 'new'],
  'server/webpageImport.ts': ['new'],
}

describe('createFrame callers declare their origin', () => {
  it.each(Object.entries(CALLERS))('%s', (file, expected) => {
    expect(calls(file).map(originOf)).toEqual(expected)
  })

  it('no other server file calls createFrame', () => {
    const listed = new Set(Object.keys(CALLERS))
    const found = fs
      .readdirSync(path.join(root, 'server'), { recursive: true, encoding: 'utf8' })
      .filter((f) => f.endsWith('.ts'))
      .map((f) => `server/${f}`)
      .filter((f) => !listed.has(f) && f !== 'server/store.ts' && calls(f).length > 0)
    expect(found).toEqual([])
  })
})
