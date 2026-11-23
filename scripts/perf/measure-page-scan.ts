/* Time one `scanPage` with the real page rules (S6 states, S7 repeated markup) over a page of about 10,000,000 chars
   built from the CHE-6942 fixture frames (CHE-9115 S3p, plan done-when h). Run on X99:
 *
 *   npx tsx scripts/perf/measure-page-scan.ts /home/congvc/doop-fixtures/mRAnnjvGod/fixture.json [chars]
 *
 * The fixture holds private designs and stays outside the repo. Prints one JSON line: chars, frames, ms, scope. */
import { readFileSync } from 'node:fs'
import { scanPage, type ScanFrame } from '../../server/frameLintPageScan.ts'
import { PAGE_RULES } from '../../shared/frameLint.ts'

const [path, target = '10000000'] = process.argv.slice(2)
if (!path) throw new Error('usage: measure-page-scan.ts <fixture.json> [chars]')
const fixture = JSON.parse(readFileSync(path, 'utf8')) as { frames: Array<{ html?: string }> }
const sources = fixture.frames.map((f) => f.html ?? '')

const limit = Number(target)
const frames: ScanFrame[] = []
let chars = 0
const roundChars = sources.reduce((sum, html) => sum + html.length, 0)
if (roundChars === 0) throw new Error('the fixture has no html')
for (let round = 0; chars + roundChars <= limit; round++) {
  for (const [i, html] of sources.entries()) frames.push({ id: `r${round}-f${i}`, html })
  chars += roundChars
}

const runs: number[] = []
let scope = ''
for (let n = 0; n < 3; n++) {
  const started = performance.now()
  const scan = await scanPage(frames, PAGE_RULES, {
    budgetMs: 15_000,
    maxFrameChars: 1_500_000,
    maxPageChars: 10_000_000,
  })
  runs.push(Math.round(performance.now() - started))
  scope = scan.scope
}
console.log(JSON.stringify({ chars, frames: frames.length, ms_runs: runs, scope }))
