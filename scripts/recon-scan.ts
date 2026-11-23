/**
 * recon-scan (G2, CHE-6078): list the interactive candidates and the photo matrix of a product repo.
 * Read-only. A heuristic floor, not a proof of completeness (limits: server/reconScan.ts).
 *
 * Usage: bun x tsx scripts/recon-scan.ts --repo <checkout> --root <file> [--root <file>...] [--within <dir>] [--sha <main sha>]
 *   --root    a screen's entry file, relative to --repo; the scan follows its relative imports
 *   --within  only read files under this dir (default: the whole checkout)
 * Prints JSON: { mainSha, scanHash, scan, cells } to paste into doop-recon.
 */
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { expectedCells, hashScan, scanSources } from '../server/reconScan.ts'

const { values } = parseArgs({
  options: {
    repo: { type: 'string' },
    root: { type: 'string', multiple: true },
    within: { type: 'string' },
    sha: { type: 'string' },
  },
})
if (!values.repo || !values.root?.length) {
  console.error('usage: recon-scan --repo <checkout> --root <file> [--root <file>...] [--within <dir>] [--sha <sha>]')
  process.exit(2)
}
const repo = path.resolve(values.repo)
const files: Record<string, string> = {}
const walk = (dir: string) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full)
    else if (/\.(?:[jt]sx?)$/.test(entry.name))
      files[path.relative(repo, full).split(path.sep).join('/')] = readFileSync(full, 'utf8')
  }
}
walk(path.join(repo, values.within ?? ''))

const missing = values.root.filter((root) => files[root] === undefined)
if (missing.length) {
  console.error(`root not found under the scanned dir: ${missing.join(', ')}`)
  process.exit(1)
}
const scan = scanSources(files, values.root)
console.log(
  JSON.stringify(
    { mainSha: values.sha, scanHash: hashScan(scan), scan, cells: expectedCells(scan).map((c) => c.key) },
    null,
    2,
  ),
)
