/* Local load-time measurement, no human credential (CHE-6196, CHE-5793 step 4b).
 *
 *   bun run build                       # once per checkout: the server serves dist/
 *   npx tsx scripts/perf/measure-local.ts --export /home/congvc/doop-export/mRAnnjvGod.json --runs 5 [--viewport 2560x1440]
 *
 * Starts the production server from this checkout on a free port, with an embedded Postgres in a
 * temp directory; signs up a throwaway account; imports the exported canvas JSON as that account's
 * canvas; checks the import; runs measure-canvas-load.ts against it; stops the server and deletes
 * the temp directory. Absolute times differ from C00; only a local before/after pair is comparable.
 * stdout is the JSON result, progress goes to stderr. */
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { importCanvasExport, type CanvasExport } from './import-canvas-export.ts'
import { measureCanvasLoad, parseViewport, summarizeCanvas } from './measure-canvas-load.ts'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const port = (probe.address() as { port: number }).port
      probe.close(() => resolve(port))
    })
  })
}

async function waitHealthy(base: string, isDead: () => boolean) {
  for (const deadline = Date.now() + 90_000; Date.now() < deadline; await new Promise((r) => setTimeout(r, 100))) {
    if (isDead()) throw new Error('the local doop server exited before it answered /healthz')
    try {
      if ((await fetch(`${base}/healthz`)).ok) return
    } catch {
      /* not up yet */
    }
  }
  throw new Error('the local doop server did not answer /healthz within 90 s')
}

/** `name=value; name2=value2` from a sign-up response */
function cookieHeader(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ')
}

export async function withLocalDoop<T>(fn: (base: string, cookie: string) => Promise<T>): Promise<T> {
  if (!existsSync(path.join(ROOT, 'dist', 'index.html'))) throw new Error('dist/ is missing: run `bun run build` first')
  const dir = mkdtempSync(path.join(tmpdir(), 'doop-measure-'))
  // the server reads dist/ and writes data/ relative to its working directory
  symlinkSync(path.join(ROOT, 'dist'), path.join(dir, 'dist'))
  const port = await freePort()
  const base = `http://127.0.0.1:${port}`
  const proc = spawn(path.join(ROOT, 'node_modules', '.bin', 'tsx'), [path.join(ROOT, 'server', 'index.ts')], {
    cwd: dir,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(port),
      BETTER_AUTH_URL: base,
      BETTER_AUTH_SECRET: randomBytes(32).toString('hex'),
      DATABASE_URL: '', // embedded Postgres in <dir>/data, never a developer's database
      POSTHOG_KEY: '',
      VITE_POSTHOG_KEY: '',
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  })
  let dead = false
  proc.once('exit', () => (dead = true))
  try {
    await waitHealthy(base, () => dead)
    console.error(`local doop on ${base} (data in ${dir})`)
    const res = await fetch(`${base}/api/auth/sign-up/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({
        email: 'measure@local.invalid',
        password: randomBytes(12).toString('hex'),
        name: 'measure',
      }),
    })
    if (!res.ok) throw new Error(`sign-up answered ${res.status}: ${(await res.text()).slice(0, 200)}`)
    return await fn(base, cookieHeader(res))
  } finally {
    proc.kill()
    rmSync(dir, { recursive: true, force: true })
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      export: { type: 'string' },
      runs: { type: 'string', default: '5' },
      // fit-all clamps at zoom 0.08; this file's opening page is 87,300 px wide, so a 1440 px stage mounts 41 of 67 frames
      viewport: { type: 'string', default: '2560x1440' },
    },
  })
  if (!values.export) throw new Error('usage: --export <canvas.json> [--runs 5]')
  const exported = JSON.parse(readFileSync(values.export, 'utf8')) as CanvasExport
  const viewport = parseViewport(values.viewport)
  const expected = summarizeCanvas(exported)
  const result = await withLocalDoop(async (base, cookie) => {
    const canvasId = await importCanvasExport(base, cookie, exported)
    // the import check: what the instance serves matches the file
    const served = await fetch(`${base}/api/canvases/${canvasId}`, { headers: { cookie } })
    const got = summarizeCanvas((await served.json()) as CanvasExport)
    for (const k of ['frames', 'firstPageFrames', 'htmlBytes', 'dataUriCount'] as const)
      if (got[k] !== expected[k]) throw new Error(`import check failed: ${k} is ${got[k]}, the file has ${expected[k]}`)
    console.error(`import check ok: ${JSON.stringify(got)}`)
    const measured = await measureCanvasLoad({
      baseUrl: base,
      canvasId,
      cookie,
      runs: Number(values.runs),
      viewport,
      onProgress: (m) => console.error(m),
    })
    return { importCheck: got, canvasId, ...measured }
  })
  console.log(
    JSON.stringify(
      { export: path.basename(values.export), viewport: `${viewport.width}x${viewport.height}`, ...result },
      null,
      2,
    ),
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
