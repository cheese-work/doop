import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
// @ts-expect-error plain .mjs script, no type declarations
import { api, arm, kindOf, lift, readMarker, restore, suspend, writeMarker } from '../scripts/deploy-marker.mjs'

/* CHE-5545 (train S3a, plan CHE-5474 C-10.1 to C-10.5). One repo variable, DOOP_DEPLOY_SUSPENDED, is the only
   thing that lets the train run. Every write is read, check, write, read back; a write that cannot be proven
   fails. A train run arms before its first change, only the same run restores, recovery and drill only ever
   write `suspended:*`. A fake GitHub holds the variable and records every call. */
const REPO = 'cheese-work/doop'
const SHA = 'c'.repeat(40)
const CLEAR = 'clear:' + '0'.repeat(32) + ':restore'
const OTHER_ARMED = 'armed:' + '1'.repeat(32) + ':8:' + SHA
const SUSPENDED = 'suspended:' + '2'.repeat(32) + ':9:' + SHA + ':migrated'
const URL = `repos/${REPO}/actions/variables/DOOP_DEPLOY_SUSPENDED`

type Init = { method?: string; body?: { name: string; value: string } }
const httpError = (status: number) => Object.assign(new Error(`GitHub ${status}`), { status })

/* `value` null = the variable does not exist. `failWrite` rejects every write; `stale` makes a write succeed
   on GitHub's side without changing what a read returns (a lost update). */
function fake(value: string | null, opts: { failWrite?: boolean; stale?: boolean; unreadable?: boolean } = {}) {
  const state = { value, writes: [] as { method: string; path: string; value: string }[] }
  const ghApi = async (path: string, init: Init = {}) => {
    const method = init.method ?? 'GET'
    if (method === 'GET') {
      if (opts.unreadable) throw httpError(500)
      if (path !== URL) throw new Error(`unexpected read ${path}`)
      if (state.value === null) throw httpError(404)
      return { value: state.value }
    }
    if (opts.failWrite) throw httpError(500)
    const expectCreate = method === 'POST' && path === `repos/${REPO}/actions/variables`
    const expectUpdate = method === 'PATCH' && path === URL
    if (!expectCreate && !expectUpdate) throw new Error(`unexpected write ${method} ${path}`)
    // The variable exists exactly when it is updated, and does not when it is created.
    if (expectCreate === (state.value !== null)) throw httpError(expectCreate ? 422 : 404)
    state.writes.push({ method, path, value: init.body?.value ?? '' })
    if (!opts.stale) state.value = init.body?.value ?? ''
    return {}
  }
  return { state, ghApi }
}

describe('marker values (C-10 table)', () => {
  it('classifies each value by its shape, and everything else as nothing', () => {
    expect(kindOf(CLEAR)).toBe('clear')
    expect(kindOf('clear:' + 'a'.repeat(32) + ':12345')).toBe('clear')
    expect(kindOf(OTHER_ARMED)).toBe('armed')
    expect(kindOf(SUSPENDED)).toBe('suspended')
    for (const bad of [
      null,
      undefined,
      '',
      'clear',
      'clear:n0:restore',
      'armed:' + '1'.repeat(32),
      SUSPENDED + ' x',
      'x' + CLEAR,
    ]) {
      expect(kindOf(bad), String(bad)).toBeNull()
    }
  })
})

describe('writeMarker: read, check, write, read back', () => {
  it('writes when the current value is the expected one, and reads it back', async () => {
    const f = fake(CLEAR)
    await writeMarker({ ghApi: f.ghApi, repo: REPO, expected: CLEAR, next: OTHER_ARMED })
    expect(f.state.value).toBe(OTHER_ARMED)
    expect(f.state.writes).toEqual([{ method: 'PATCH', path: URL, value: OTHER_ARMED }])
  })
  it('creates the variable when it is absent and absent was expected', async () => {
    const f = fake(null)
    await writeMarker({ ghApi: f.ghApi, repo: REPO, expected: null, next: SUSPENDED })
    expect(f.state.writes).toEqual([{ method: 'POST', path: `repos/${REPO}/actions/variables`, value: SUSPENDED }])
  })
  it('a marker that is not the expected one fails the job before any write', async () => {
    const f = fake(OTHER_ARMED)
    await expect(writeMarker({ ghApi: f.ghApi, repo: REPO, expected: CLEAR, next: SUSPENDED })).rejects.toThrow(
      /changed/,
    )
    expect(f.state.writes).toEqual([])
  })
  it('an unreadable marker fails the job before any write', async () => {
    const f = fake(CLEAR, { unreadable: true })
    await expect(writeMarker({ ghApi: f.ghApi, repo: REPO, expected: CLEAR, next: OTHER_ARMED })).rejects.toThrow()
    expect(f.state.writes).toEqual([])
  })
  it('a failed write fails the job and leaves the marker as it was', async () => {
    const f = fake(CLEAR, { failWrite: true })
    await expect(writeMarker({ ghApi: f.ghApi, repo: REPO, expected: CLEAR, next: OTHER_ARMED })).rejects.toThrow()
    expect(f.state.value).toBe(CLEAR)
  })
  it('a write that the read back does not show fails the job', async () => {
    const f = fake(CLEAR, { stale: true })
    await expect(writeMarker({ ghApi: f.ghApi, repo: REPO, expected: CLEAR, next: OTHER_ARMED })).rejects.toThrow(
      /read back/,
    )
  })
  it('never writes a value that is not a marker value', async () => {
    const f = fake(CLEAR)
    await expect(writeMarker({ ghApi: f.ghApi, repo: REPO, expected: CLEAR, next: 'clear:oops' })).rejects.toThrow()
    expect(f.state.writes).toEqual([])
  })
})

describe('train: arm before change (C-10.2)', () => {
  it('arms from the exact clear value it read, with a fresh nonce, and reports the value', async () => {
    const f = fake(CLEAR)
    const value = await arm({ ghApi: f.ghApi, repo: REPO, runId: '77', sha: SHA })
    expect(kindOf(value)).toBe('armed')
    expect(value).toMatch(new RegExp(`^armed:[0-9a-f]{32}:77:${SHA}$`))
    expect(f.state.value).toBe(value)
    const again = fake(CLEAR)
    expect(await arm({ ghApi: again.ghApi, repo: REPO, runId: '77', sha: SHA })).not.toBe(value)
  })
  it.each([
    ['absent', null],
    ['armed by another run', OTHER_ARMED],
    ['suspended', SUSPENDED],
    ['unreadable shape', 'clear:n0:restore'],
  ])('a failed arm means no change: marker %s refuses and writes nothing', async (_n, marker) => {
    const f = fake(marker)
    await expect(arm({ ghApi: f.ghApi, repo: REPO, runId: '77', sha: SHA })).rejects.toThrow()
    expect(f.state.writes).toEqual([])
  })
  it('a failed arm write throws, so no step after it runs', async () => {
    const f = fake(CLEAR, { failWrite: true })
    await expect(arm({ ghApi: f.ghApi, repo: REPO, runId: '77', sha: SHA })).rejects.toThrow()
    expect(f.state.value).toBe(CLEAR)
  })
})

describe('train: only the arming run restores (C-10.2)', () => {
  const own = 'armed:' + '3'.repeat(32) + ':77:' + SHA
  it('restores its own arm to a new clear value', async () => {
    const f = fake(own)
    const value = await restore({ ghApi: f.ghApi, repo: REPO, expected: own })
    expect(value).toMatch(/^clear:[0-9a-f]{32}:restore$/)
    expect(f.state.value).toBe(value)
  })
  it.each([
    ['another run armed', OTHER_ARMED],
    ['a suspension was written', SUSPENDED],
    ['a lift cleared it', CLEAR],
    ['it vanished', null],
  ])('refuses when %s', async (_n, marker) => {
    const f = fake(marker)
    await expect(restore({ ghApi: f.ghApi, repo: REPO, expected: own })).rejects.toThrow()
    expect(f.state.writes).toEqual([])
  })
  it('refuses to restore anything that is not an armed value', async () => {
    for (const expected of [CLEAR, SUSPENDED, '', undefined]) {
      const f = fake(expected ?? null)
      await expect(restore({ ghApi: f.ghApi, repo: REPO, expected })).rejects.toThrow()
      expect(f.state.writes).toEqual([])
    }
  })
  it('a failed restore write leaves the arm in place, which reads as suspended', async () => {
    const f = fake(own, { failWrite: true })
    await expect(restore({ ghApi: f.ghApi, repo: REPO, expected: own })).rejects.toThrow()
    expect(f.state.value).toBe(own)
    expect(kindOf(f.state.value)).toBe('armed')
  })
})

describe('suspend: recovery, drill, rollback, adoption (C-10.3, C-10.5)', () => {
  it.each([
    ['clear', CLEAR],
    ['armed', OTHER_ARMED],
    ['suspended', SUSPENDED],
    ['an odd value', 'whatever'],
    ['absent', null],
  ])('recovery or drill writes suspended over %s, before change, and never clear', async (_n, marker) => {
    const f = fake(marker)
    const value = await suspend({ ghApi: f.ghApi, repo: REPO, runId: '5', sha: SHA, reason: 'recovery', any: true })
    expect(value).toMatch(new RegExp(`^suspended:[0-9a-f]{32}:5:${SHA}:recovery$`))
    expect(f.state.value).toBe(value)
    expect(f.state.writes.every((w) => kindOf(w.value) === 'suspended')).toBe(true)
  })
  it('a rollback suspends only over this run’s own arm', async () => {
    const own = 'armed:' + '3'.repeat(32) + ':77:' + SHA
    const f = fake(own)
    const value = await suspend({
      ghApi: f.ghApi,
      repo: REPO,
      runId: '77',
      sha: SHA,
      reason: 'rollback-rollback',
      expected: own,
    })
    expect(kindOf(value)).toBe('suspended')
    for (const other of [OTHER_ARMED, SUSPENDED, CLEAR, null]) {
      const g = fake(other)
      await expect(
        suspend({ ghApi: g.ghApi, repo: REPO, runId: '77', sha: SHA, reason: 'rollback-none', expected: own }),
      ).rejects.toThrow()
      expect(g.state.writes).toEqual([])
    }
  })
  it('a recovery or drill rollback suspends over this run’s own suspended value, and over no other', async () => {
    const own = 'suspended:' + '4'.repeat(32) + ':78:' + SHA + ':recovery'
    const f = fake(own)
    const value = await suspend({
      ghApi: f.ghApi,
      repo: REPO,
      runId: '78',
      sha: SHA,
      reason: 'rollback-rollback',
      expected: own,
    })
    expect(kindOf(value)).toBe('suspended')
    expect(f.state.value).toBe(value)
    const elsewhere = 'suspended:' + '5'.repeat(32) + ':79:' + SHA + ':recovery'
    for (const other of [OTHER_ARMED, elsewhere, CLEAR, null]) {
      const g = fake(other)
      await expect(
        suspend({ ghApi: g.ghApi, repo: REPO, runId: '78', sha: SHA, reason: 'rollback-none', expected: own }),
      ).rejects.toThrow()
      expect(g.state.writes).toEqual([])
    }
  })
  it('needs either an expected value or an explicit "any"', async () => {
    const f = fake(CLEAR)
    await expect(suspend({ ghApi: f.ghApi, repo: REPO, runId: '5', sha: SHA, reason: 'x' })).rejects.toThrow()
    expect(f.state.writes).toEqual([])
  })
  it('refuses a reason that could break the value apart', async () => {
    const f = fake(CLEAR)
    for (const reason of ['', 'a:b', 'two words', 'x\ny']) {
      await expect(suspend({ ghApi: f.ghApi, repo: REPO, runId: '5', sha: SHA, reason, any: true })).rejects.toThrow()
    }
    expect(f.state.writes).toEqual([])
  })
  it('adoption of the 11 Nov failure writes suspended with reason migrated', async () => {
    const f = fake(null)
    const value = await suspend({
      ghApi: f.ghApi,
      repo: REPO,
      runId: '42955625332',
      sha: '612f86854a6020f45b90321302a79dae1214d13a',
      reason: 'migrated',
      any: true,
    })
    expect(value).toMatch(/^suspended:[0-9a-f]{32}:42955625332:612f86854a6020f45b90321302a79dae1214d13a:migrated$/)
  })
  it('a later recovery or drill after a passing train run does not restore clear', async () => {
    const f = fake(CLEAR)
    const armed = await arm({ ghApi: f.ghApi, repo: REPO, runId: '1', sha: SHA })
    await restore({ ghApi: f.ghApi, repo: REPO, expected: armed })
    await suspend({ ghApi: f.ghApi, repo: REPO, runId: '2', sha: SHA, reason: 'recovery', any: true })
    expect(kindOf(f.state.value)).toBe('suspended')
    // nothing short of a lift (S3b) writes clear again
    expect(f.state.writes.filter((w) => kindOf(w.value) === 'clear')).toHaveLength(1)
  })
})

describe('deploy-marker CLI', () => {
  const run = (args: string[], env: Record<string, string> = {}) =>
    spawnSync('node', ['scripts/deploy-marker.mjs', ...args], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, ...env },
    })
  it('exits non-zero on an unknown command', () => {
    expect(run(['explode']).status).not.toBe(0)
  })
  it('exits non-zero without a token or a repo, before any network call', () => {
    expect(run(['arm'], { RUN_ID: '1', SHA }).status).not.toBe(0)
  })
})

describe('lift (CHE-5551, C-10.7)', () => {
  it('writes clear:<nonce>:<lift run id> over exactly the expected suspended value, and reads it back', async () => {
    const { state, ghApi } = fake(SUSPENDED)
    const value = await lift({ ghApi, repo: REPO, runId: '777', expected: SUSPENDED })
    expect(value).toMatch(/^clear:[0-9a-f]{32}:777$/)
    expect(kindOf(value)).toBe('clear')
    expect(state.value).toBe(value)
    expect(state.writes).toHaveLength(1)
  })

  it('lifts an armed value (a train run that died leaves one)', async () => {
    const { state, ghApi } = fake(OTHER_ARMED)
    await lift({ ghApi, repo: REPO, runId: '777', expected: OTHER_ARMED })
    expect(kindOf(state.value)).toBe('clear')
  })

  it('refuses when the marker is not the expected value: nothing is written', async () => {
    const { state, ghApi } = fake(OTHER_ARMED)
    await expect(lift({ ghApi, repo: REPO, runId: '777', expected: SUSPENDED })).rejects.toThrow(/changed/)
    expect(state.writes).toEqual([])
    expect(state.value).toBe(OTHER_ARMED)
  })

  it.each([CLEAR, null, 'junk'])('refuses to lift %j (nothing to lift)', async (expected) => {
    const { state, ghApi } = fake(expected)
    await expect(lift({ ghApi, repo: REPO, runId: '777', expected })).rejects.toThrow(/lift needs/)
    expect(state.writes).toEqual([])
  })

  it.each(['', 'x y', '1;2', undefined])('refuses a lift run id of %j', async (runId) => {
    const { state, ghApi } = fake(SUSPENDED)
    await expect(lift({ ghApi, repo: REPO, runId, expected: SUSPENDED })).rejects.toThrow(/run id/)
    expect(state.writes).toEqual([])
  })

  it('fails when the write cannot be read back', async () => {
    const { ghApi } = fake(SUSPENDED, { stale: true })
    await expect(lift({ ghApi, repo: REPO, runId: '777', expected: SUSPENDED })).rejects.toThrow(/read back/)
  })

  it('readMarker returns the value, null when absent, and throws on anything else', async () => {
    expect(await readMarker(fake(SUSPENDED).ghApi, REPO)).toBe(SUSPENDED)
    expect(await readMarker(fake(null).ghApi, REPO)).toBeNull()
    await expect(readMarker(fake(SUSPENDED, { unreadable: true }).ghApi, REPO)).rejects.toThrow()
  })
})

describe('marker API errors (CHE-9889)', () => {
  afterEach(() => vi.unstubAllGlobals())
  it('puts GitHub’s reason in the error, so a rate limit reads differently from a missing permission', async () => {
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(JSON.stringify({ message: 'API rate limit exceeded for installation ID 1.' }), { status: 403 }),
    )
    await expect(api('t')(URL)).rejects.toMatchObject({
      status: 403,
      message: `GitHub 403 for GET ${URL}: API rate limit exceeded for installation ID 1.`,
    })
  })
  it('caps GitHub’s reason at 200 characters and keeps the HTTP status', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ message: 'x'.repeat(500) }), { status: 422 }))
    await expect(api('t')(URL)).rejects.toMatchObject({
      status: 422,
      message: `GitHub 422 for GET ${URL}: ${'x'.repeat(200)}`,
    })
  })
  it('keeps the plain message when the body is not JSON', async () => {
    vi.stubGlobal('fetch', async () => new Response('nope', { status: 500 }))
    await expect(api('t')(URL)).rejects.toMatchObject({ status: 500, message: `GitHub 500 for GET ${URL}` })
  })
})
