import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readRevision } from '../server/revision.ts'
import { startServer, type Server } from './harness.ts'

/* CHE-5550 (train S7, plan CHE-5474 C-7.2): /healthz tells which commit the image was built from, so the
   live-revision watcher can compare C00 with the last successful D2 SHA. The revision is the DOOP_REVISION build
   arg of image.yml, baked into the image as /app/REVISION. */
const SHA = 'd'.repeat(40)
const dir = mkdtempSync(path.join(tmpdir(), 'doop-revision-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('readRevision', () => {
  const file = (name: string, body: string) => {
    const p = path.join(dir, name)
    writeFileSync(p, body)
    return p
  }

  it('reads the commit the image was built from, trimmed', () => {
    expect(readRevision(file('ok', `${SHA}\n`))).toBe(SHA)
  })

  it('says unknown when there is no file (a dev run) or the file is not a full SHA', () => {
    expect(readRevision(path.join(dir, 'missing'))).toBe('unknown')
    expect(readRevision(file('empty', ''))).toBe('unknown')
    expect(readRevision(file('default', 'unknown\n'))).toBe('unknown')
    expect(readRevision(file('short', SHA.slice(0, 7)))).toBe('unknown')
    expect(readRevision(file('upper', SHA.toUpperCase()))).toBe('unknown')
  })
})

describe('GET /healthz', () => {
  let server: Server
  beforeAll(async () => {
    server = await startServer()
  }, 120_000)
  afterAll(() => server?.stop())

  it('answers { ok, revision }', async () => {
    const res = await fetch(`${server.base}/healthz`)
    expect(res.status).toBe(200)
    // no REVISION file outside an image
    expect(await res.json()).toEqual({ ok: true, revision: 'unknown' })
  })
})

describe('the image carries its revision', () => {
  const dockerfile = readFileSync('Dockerfile', 'utf8')
  const image = readFileSync('.github/workflows/image.yml', 'utf8')

  it('image.yml passes the commit as the DOOP_REVISION build arg', () => {
    expect(image).toMatch(/build-args: \|?\s*\n?\s*DOOP_REVISION=\$\{\{ github\.sha \}\}/)
  })

  it('the runtime stage declares the arg late (cache) and writes it to /app/REVISION', () => {
    const runtime = dockerfile.slice(dockerfile.lastIndexOf('FROM node:'))
    expect(runtime).toMatch(/^ARG DOOP_REVISION=unknown$/m)
    expect(runtime).toMatch(/RUN .*"\$DOOP_REVISION".*> \/app\/REVISION/)
    // after the COPYs that change on every commit would be wrong: before them it would bust no cache either way,
    // but the arg must not sit in the build stages, where it would bust the dependency layers
    expect(dockerfile.slice(0, dockerfile.lastIndexOf('FROM node:'))).not.toContain('DOOP_REVISION')
  })
})
