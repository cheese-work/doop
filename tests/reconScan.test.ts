import { describe, expect, it } from 'vitest'
import { expectedCells, hashScan, scanSources, type ScanCandidate } from '../server/reconScan.ts'

/* CHE-6627 / G2: recon-scan reads product source and lists the interactive candidates a designer must
   photograph. Read-only and heuristic: a floor under the designer's memory, never a proof of completeness. */
const files = {
  'views/screen.tsx': [
    "import { Header } from './header'",
    'export function Screen() {',
    '  return (',
    '    <div>',
    '      <Header />',
    '      <Button onClick={save}>Save</Button>',
    '    </div>',
    '  )',
    '}',
  ].join('\n'),
  'views/header.tsx': [
    'export function Header() {',
    '  return (',
    '    <div>',
    '      <Select value={sort} onValueChange={setSort}>',
    '        <SelectTrigger />',
    '        <SelectItem value="newest">Newest first</SelectItem>',
    '        <SelectItem value="oldest">Oldest first</SelectItem>',
    '      </Select>',
    '      <DropdownMenu>',
    '        <DropdownMenuTrigger><MoreHorizontal className="h-4" /></DropdownMenuTrigger>',
    '      </DropdownMenu>',
    '      <Switch checked={on} />',
    '      <button className="hidden md:block">Desk</button>',
    '      <Input aria-label="Search" />',
    '      <div data-testid="thing" />',
    '    </div>',
    '  )',
    '}',
  ].join('\n'),
  'views/unrelated.tsx': 'export const X = () => <button>never imported</button>',
}

const find = (cs: ScanCandidate[], file: string, line: number, kind: string) =>
  cs.find((c) => c.file === file && c.line === line && c.kind === kind)

describe('recon-scan', () => {
  const scan = scanSources(files, ['views/screen.tsx'])

  it('follows relative imports and ignores files nothing imports', () => {
    expect(scan.candidates.some((c) => c.file === 'views/unrelated.tsx')).toBe(false)
    expect(scan.candidates.some((c) => c.file === 'views/header.tsx')).toBe(true)
    expect(find(scan.candidates, 'views/screen.tsx', 6, 'button')).toBeTruthy()
  })

  it('lists every value of a select, so a missing sort direction is visible', () => {
    expect(find(scan.candidates, 'views/header.tsx', 4, 'select')?.states).toEqual(['newest', 'oldest'])
  })

  it('catches the kebab icon, the menu, the switch, the input, the aria-label and the test id', () => {
    for (const [line, kind] of [
      [10, 'icon'],
      [9, 'menu'],
      [12, 'toggle'],
      [14, 'input'],
      [14, 'labelled'],
      [15, 'testid'],
    ] as const)
      expect(find(scan.candidates, 'views/header.tsx', line, kind), `${kind}@${line}`).toBeTruthy()
    expect(find(scan.candidates, 'views/header.tsx', 9, 'menu')?.states).toEqual(['open'])
    expect(find(scan.candidates, 'views/header.tsx', 12, 'toggle')?.states).toEqual(['on', 'off'])
  })

  it('records the devices a candidate exists on when the class hides it', () => {
    expect(find(scan.candidates, 'views/header.tsx', 13, 'button')?.devices).toEqual([1440])
    expect(find(scan.candidates, 'views/header.tsx', 4, 'select')?.devices).toBeUndefined()
  })

  it('catches a "Newest first" text toggle as a two-state toggle', () => {
    const s = scanSources({ 'a.tsx': '<button>{sort === "new" ? "Newest first" : "Oldest first"}</button>' }, ['a.tsx'])
    expect(s.candidates.find((c) => c.kind === 'toggle')?.states).toEqual(['newest-first', 'oldest-first'])
  })

  it('derives the photo matrix: screen x device base cells, plus one per candidate state x device', () => {
    const keys = expectedCells(scan).map((c) => c.key)
    expect(new Set(keys).size).toBe(keys.length)
    expect(keys).toContain('views/screen.tsx|1440||')
    expect(keys).toContain('views/screen.tsx|390||')
    expect(keys).toContain('views/screen.tsx|390|views/header.tsx:4:select|oldest')
    expect(keys).toContain('views/screen.tsx|1440|views/header.tsx:9:menu|open')
  })

  it('hashes the scan the same way every time', () => {
    expect(hashScan(scan)).toBe(hashScan(scanSources(files, ['views/screen.tsx'])))
    expect(hashScan(scan)).not.toBe(
      hashScan(scanSources({ ...files, 'views/unrelated.tsx': '' }, ['views/header.tsx'])),
    )
  })
})
