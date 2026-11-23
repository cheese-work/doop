/* Build the C8 canvas performance fixture (CHE-5889, CHE-5793 step 22). Step 30 reruns this.
 *
 *   npx tsx scripts/perf/build-canvas-fixture.ts --export /home/congvc/doop-export/mRAnnjvGod.json --out /home/congvc/doop-fixtures/mRAnnjvGod
 *
 * Input: the canvas JSON of `mRAnnjvGod` (GET /api/canvases/<id>, the shape CHE-6196 exported).
 * Output, in a directory outside the repo (the frames are private designs):
 *   fixture.json   pages and frames in the shape import-canvas-export.ts takes, without ids, owners or timestamps
 *   manifest.json  geometry and an html hash per frame, and one `sha256` over all of it
 * stdout is the manifest SHA256, the one value the PR records. The manifest holds no html. */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import type { CanvasExport } from './import-canvas-export.ts'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')

export interface FixtureManifest {
  pages: string[]
  frames: number
  frameList: { page: number; name: string; x: number; y: number; width: number; height: number; htmlSha256: string }[]
  /** over pages and frameList; independent of canvas id, owner and timestamps */
  sha256: string
}

export function fixtureManifest(canvas: CanvasExport): FixtureManifest {
  const pageIndex = new Map(canvas.pages.map((p, i) => [p.id, i]))
  const pages = canvas.pages.map((p) => p.name)
  const frameList = canvas.frames.map((f) => ({
    page: pageIndex.get(f.pageId ?? canvas.pages[0]!.id) ?? 0,
    name: f.name,
    x: f.x,
    y: f.y,
    width: f.width,
    height: f.height,
    htmlSha256: sha256(f.html ?? ''),
  }))
  return { pages, frames: frameList.length, frameList, sha256: sha256(JSON.stringify({ pages, frameList })) }
}

export function buildFixture(exportPath: string, outDir: string): FixtureManifest {
  const out = path.resolve(outDir)
  if (out === REPO || out.startsWith(REPO + path.sep))
    throw new Error(`${out} is inside the repo: the fixture holds private designs and stays on X99, outside it`)
  const canvas = JSON.parse(readFileSync(exportPath, 'utf8')) as CanvasExport
  const fixture: CanvasExport = {
    id: canvas.id,
    name: canvas.name,
    pages: canvas.pages.map((p) => ({ id: p.id, name: p.name })),
    frames: canvas.frames.map((f) => ({
      pageId: f.pageId,
      name: f.name,
      x: f.x,
      y: f.y,
      width: f.width,
      height: f.height,
      html: f.html,
    })),
  }
  const manifest = fixtureManifest(fixture)
  mkdirSync(out, { recursive: true })
  writeFileSync(path.join(out, 'fixture.json'), JSON.stringify(fixture))
  writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2))
  return manifest
}

function main() {
  const { values } = parseArgs({ options: { export: { type: 'string' }, out: { type: 'string' } } })
  if (!values.export || !values.out) throw new Error('usage: --export <canvas.json> --out <dir outside the repo>')
  const m = buildFixture(values.export, values.out)
  console.error(`${m.frames} frames on ${m.pages.length} pages, written to ${values.out}`)
  console.log(m.sha256)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main()
  } catch (err) {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  }
}
