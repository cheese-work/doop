import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import packageJson from '../package.json' with { type: 'json' }
import { buildInfo } from '../shared/buildInfo.ts'
import { startServer, type Server } from './harness.ts'

/* CHE-9772 (parent CHE-9323): the Settings footer shows `<version>-<build> · <commit>`, the format of the multica
   fork (CHE-1307, CHE-1910). `build` is the COMMIT time in ICT (Asia/Ho_Chi_Minh, UTC+7, no DST). */
const SHA = '24f6c700' + 'a'.repeat(32)

describe('buildInfo', () => {
  it('formats version, build (commit time in ICT) and short commit', () => {
    expect(buildInfo({ version: '0.15.0', revision: SHA, commitTime: '2026-11-25T09:12:00+07:00' })).toEqual({
      version: '0.15.0',
      build: '20261125-0912',
      commit: '24f6c700',
      label: '0.15.0-20261125-0912 · 24f6c700',
    })
  })

  it('converts a UTC commit time across midnight into the next ICT day', () => {
    expect(buildInfo({ version: '0.15.0', revision: SHA, commitTime: '2026-11-23T17:30:00Z' }).build).toBe(
      '20261124-0030',
    )
    expect(buildInfo({ version: '0.15.0', revision: SHA, commitTime: '2026-12-31T17:00:00Z' }).build).toBe(
      '20270101-0000',
    )
  })

  it('keeps the same instant whatever offset the commit time was written in', () => {
    const a = buildInfo({ version: '1.0.0', revision: SHA, commitTime: '2026-11-25T02:12:00Z' })
    const b = buildInfo({ version: '1.0.0', revision: SHA, commitTime: '2026-11-24T21:12:00-05:00' })
    expect(a.build).toBe('20261125-0912')
    expect(b.build).toBe(a.build)
  })

  it('takes the first 8 characters of the revision, lower case', () => {
    expect(buildInfo({ version: '1', revision: SHA.toUpperCase(), commitTime: '2026-11-25T02:12:00Z' }).commit).toBe(
      '24f6c700',
    )
  })

  it('says dev when nothing was stamped (a dev run or a local image)', () => {
    const dev = { version: '0.15.0', build: 'dev', commit: 'dev', label: '0.15.0-dev' }
    expect(buildInfo({ version: '0.15.0' })).toEqual(dev)
    expect(buildInfo({ version: '0.15.0', revision: '', commitTime: '' })).toEqual(dev)
    expect(buildInfo({ version: '0.15.0', revision: 'unknown', commitTime: 'not a date' })).toEqual(dev)
  })

  it('labels a half-stamped image by what is known, never throws', () => {
    expect(buildInfo({ version: '0.15.0', revision: SHA }).label).toBe('0.15.0-dev · 24f6c700')
    expect(buildInfo({ version: '0.15.0', commitTime: '2026-11-25T02:12:00Z' }).label).toBe('0.15.0-20261125-0912')
  })
})

describe('GET /api/version', () => {
  let stamped: Server
  let bare: Server
  beforeAll(async () => {
    stamped = await startServer({ DOOP_REVISION: SHA, DOOP_COMMIT_TIME: '2026-11-23T17:30:00Z' })
    bare = await startServer({ DOOP_REVISION: '', DOOP_COMMIT_TIME: '' })
  }, 120_000)
  afterAll(() => {
    stamped?.stop()
    bare?.stop()
  })

  it('is public and returns { version, build, commit, label }', async () => {
    const res = await fetch(`${stamped.base}/api/version`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      version: packageJson.version,
      build: '20261124-0030',
      commit: '24f6c700',
      label: `${packageJson.version}-20261124-0030 · 24f6c700`,
    })
  })

  it('answers dev when the process was not stamped', async () => {
    const res = await fetch(`${bare.base}/api/version`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      version: packageJson.version,
      build: 'dev',
      commit: 'dev',
      label: `${packageJson.version}-dev`,
    })
  })
})

describe('the image carries the build stamp', () => {
  const dockerfile = readFileSync('Dockerfile', 'utf8')
  const image = readFileSync('.github/workflows/image.yml', 'utf8')

  it('image.yml passes the commit time (%cI) next to the revision', () => {
    expect(image).toMatch(/DOOP_REVISION=\$\{\{ github\.sha \}\}/)
    expect(image).toMatch(/DOOP_COMMIT_TIME=\$\{\{ steps\.stamp\.outputs\.commit_time \}\}/)
    expect(image).toMatch(/git show -s --format=%cI/)
  })

  it('the runtime stage turns both args into ENV for the server', () => {
    const runtime = dockerfile.slice(dockerfile.lastIndexOf('FROM node:'))
    expect(runtime).toMatch(/ARG DOOP_COMMIT_TIME=\n?/)
    expect(runtime).toMatch(/ENV DOOP_REVISION=\$DOOP_REVISION DOOP_COMMIT_TIME=\$DOOP_COMMIT_TIME/)
  })
})
