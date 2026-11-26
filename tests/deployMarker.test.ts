import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  arm,
  fileStore,
  kindOf,
  lift,
  markerFile,
  readMarker,
  restore,
  suspend,
  writeMarker,
  // @ts-expect-error plain .mjs script, no type declarations
} from '../scripts/deploy-marker.mjs'

/* CHE-5545 (train S3a, plan CHE-5474 C-10.1 to C-10.5), moved to the C00 host by CHE-9877. One value on the C00
   host, the deploy marker, is the only thing that lets the train run. Every write is read, check, write, read
   back; a write that cannot be proven fails. A train run arms before its first change, only the same run restores,
   recovery and drill only ever write `suspended:*`. A fake store holds the value and records every write; the
   last block runs the same code on a real file. No GitHub variable and no token take part. */
const SHA = 'c'.repeat(40)
const CLEAR = 'clear:' + '0'.repeat(32) + ':restore'
const OTHER_ARMED = 'armed:' + '1'.repeat(32) + ':8:' + SHA
const SUSPENDED = 'suspended:' + '2'.repeat(32) + ':9:' + SHA + ':migrated'

/* `value` null = no marker. `failWrite` rejects every write; `stale` makes a write succeed without changing what a
   read returns (a lost update); `unreadable` makes every read fail. */
function fake(value: string | null, opts: { failWrite?: boolean; stale?: boolean; unreadable?: boolean } = {}) {
  const state = { value, writes: [] as string[] }
  const store = {
    read: async () => {
      if (opts.unreadable) throw new Error('EIO: cannot read the marker')
      return state.value
    },
    write: async (next: string) => {
      if (opts.failWrite) throw new Error('EIO: cannot write the marker')
      state.writes.push(next)
      if (!opts.stale) state.value = next
    },
  }
  return { state, store }
}

const statMode = (path: string) => statSync(path).mode & 0o777

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
    await writeMarker({ store: f.store, expected: CLEAR, next: OTHER_ARMED })
    expect(f.state.value).toBe(OTHER_ARMED)
    expect(f.state.writes).toEqual([OTHER_ARMED])
  })
  it('creates the marker when it is absent and absent was expected', async () => {
    const f = fake(null)
    await writeMarker({ store: f.store, expected: null, next: SUSPENDED })
    expect(f.state.writes).toEqual([SUSPENDED])
  })
  it('a marker that is not the expected one fails the job before any write', async () => {
    const f = fake(OTHER_ARMED)
    await expect(writeMarker({ store: f.store, expected: CLEAR, next: SUSPENDED })).rejects.toThrow(/changed/)
    expect(f.state.writes).toEqual([])
  })
  it('an unreadable marker fails the job before any write', async () => {
    const f = fake(CLEAR, { unreadable: true })
    await expect(writeMarker({ store: f.store, expected: CLEAR, next: OTHER_ARMED })).rejects.toThrow()
    expect(f.state.writes).toEqual([])
  })
  it('a failed write fails the job and leaves the marker as it was', async () => {
    const f = fake(CLEAR, { failWrite: true })
    await expect(writeMarker({ store: f.store, expected: CLEAR, next: OTHER_ARMED })).rejects.toThrow()
    expect(f.state.value).toBe(CLEAR)
  })
  it('a write that the read back does not show fails the job', async () => {
    const f = fake(CLEAR, { stale: true })
    await expect(writeMarker({ store: f.store, expected: CLEAR, next: OTHER_ARMED })).rejects.toThrow(/read back/)
  })
  it('never writes a value that is not a marker value', async () => {
    const f = fake(CLEAR)
    await expect(writeMarker({ store: f.store, expected: CLEAR, next: 'clear:oops' })).rejects.toThrow()
    expect(f.state.writes).toEqual([])
  })
})

describe('train: arm before change (C-10.2)', () => {
  it('arms from the exact clear value it read, with a fresh nonce, and reports the value', async () => {
    const f = fake(CLEAR)
    const value = await arm({ store: f.store, runId: '77', sha: SHA })
    expect(kindOf(value)).toBe('armed')
    expect(value).toMatch(new RegExp(`^armed:[0-9a-f]{32}:77:${SHA}$`))
    expect(f.state.value).toBe(value)
    const again = fake(CLEAR)
    expect(await arm({ store: again.store, runId: '77', sha: SHA })).not.toBe(value)
  })
  it.each([
    ['absent', null],
    ['armed by another run', OTHER_ARMED],
    ['suspended', SUSPENDED],
    ['unreadable shape', 'clear:n0:restore'],
  ])('a failed arm means no change: marker %s refuses and writes nothing', async (_n, marker) => {
    const f = fake(marker)
    await expect(arm({ store: f.store, runId: '77', sha: SHA })).rejects.toThrow()
    expect(f.state.writes).toEqual([])
  })
  it('a failed arm write throws, so no step after it runs', async () => {
    const f = fake(CLEAR, { failWrite: true })
    await expect(arm({ store: f.store, runId: '77', sha: SHA })).rejects.toThrow()
    expect(f.state.value).toBe(CLEAR)
  })
})

describe('train: only the arming run restores (C-10.2)', () => {
  const own = 'armed:' + '3'.repeat(32) + ':77:' + SHA
  it('restores its own arm to a new clear value', async () => {
    const f = fake(own)
    const value = await restore({ store: f.store, expected: own })
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
    await expect(restore({ store: f.store, expected: own })).rejects.toThrow()
    expect(f.state.writes).toEqual([])
  })
  it('refuses to restore anything that is not an armed value', async () => {
    for (const expected of [CLEAR, SUSPENDED, '', undefined]) {
      const f = fake(expected ?? null)
      await expect(restore({ store: f.store, expected })).rejects.toThrow()
      expect(f.state.writes).toEqual([])
    }
  })
  it('a failed restore write leaves the arm in place, which reads as suspended', async () => {
    const f = fake(own, { failWrite: true })
    await expect(restore({ store: f.store, expected: own })).rejects.toThrow()
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
    const value = await suspend({ store: f.store, runId: '5', sha: SHA, reason: 'recovery', any: true })
    expect(value).toMatch(new RegExp(`^suspended:[0-9a-f]{32}:5:${SHA}:recovery$`))
    expect(f.state.value).toBe(value)
    expect(f.state.writes.every((w: string) => kindOf(w) === 'suspended')).toBe(true)
  })
  it('a rollback suspends only over this run’s own arm', async () => {
    const own = 'armed:' + '3'.repeat(32) + ':77:' + SHA
    const f = fake(own)
    const value = await suspend({
      store: f.store,
      runId: '77',
      sha: SHA,
      reason: 'rollback-rollback',
      expected: own,
    })
    expect(kindOf(value)).toBe('suspended')
    for (const other of [OTHER_ARMED, SUSPENDED, CLEAR, null]) {
      const g = fake(other)
      await expect(
        suspend({ store: g.store, runId: '77', sha: SHA, reason: 'rollback-none', expected: own }),
      ).rejects.toThrow()
      expect(g.state.writes).toEqual([])
    }
  })
  it('a recovery or drill rollback suspends over this run’s own suspended value, and over no other', async () => {
    const own = 'suspended:' + '4'.repeat(32) + ':78:' + SHA + ':recovery'
    const f = fake(own)
    const value = await suspend({
      store: f.store,
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
        suspend({ store: g.store, runId: '78', sha: SHA, reason: 'rollback-none', expected: own }),
      ).rejects.toThrow()
      expect(g.state.writes).toEqual([])
    }
  })
  it('needs either an expected value or an explicit "any"', async () => {
    const f = fake(CLEAR)
    await expect(suspend({ store: f.store, runId: '5', sha: SHA, reason: 'x' })).rejects.toThrow()
    expect(f.state.writes).toEqual([])
  })
  it('refuses a reason that could break the value apart', async () => {
    const f = fake(CLEAR)
    for (const reason of ['', 'a:b', 'two words', 'x\ny']) {
      await expect(suspend({ store: f.store, runId: '5', sha: SHA, reason, any: true })).rejects.toThrow()
    }
    expect(f.state.writes).toEqual([])
  })
  it('adoption of the 11 Nov failure writes suspended with reason migrated', async () => {
    const f = fake(null)
    const value = await suspend({
      store: f.store,
      runId: '42955625332',
      sha: '612f86854a6020f45b90321302a79dae1214d13a',
      reason: 'migrated',
      any: true,
    })
    expect(value).toMatch(/^suspended:[0-9a-f]{32}:42955625332:612f86854a6020f45b90321302a79dae1214d13a:migrated$/)
  })
  it('a later recovery or drill after a passing train run does not restore clear', async () => {
    const f = fake(CLEAR)
    const armed = await arm({ store: f.store, runId: '1', sha: SHA })
    await restore({ store: f.store, expected: armed })
    await suspend({ store: f.store, runId: '2', sha: SHA, reason: 'recovery', any: true })
    expect(kindOf(f.state.value)).toBe('suspended')
    // nothing short of a lift (S3b) writes clear again
    expect(f.state.writes.filter((w: string) => kindOf(w) === 'clear')).toHaveLength(1)
  })
})

describe('the marker file on the C00 host', () => {
  const tmp = () => mkdtempSync(join(tmpdir(), 'marker-'))
  const withDir = async (fn: (dir: string, file: string) => Promise<void> | void) => {
    const dir = tmp()
    try {
      await fn(dir, join(dir, 'deploy-marker'))
    } finally {
      chmodSync(dir, 0o700)
      rmSync(dir, { recursive: true, force: true })
    }
  }

  it('defaults to a file in the host state dir, and C00_MARKER_FILE overrides it', () => {
    expect(markerFile({})).toBe('/var/lib/doop-deploy/deploy-marker')
    expect(markerFile({ C00_STATE_DIR: '/srv/state' })).toBe('/srv/state/deploy-marker')
    expect(markerFile({ C00_STATE_DIR: '/srv/state', C00_MARKER_FILE: '/x/m' })).toBe('/x/m')
  })

  it('reads null when the file does not exist, and the value without its newline when it does', () =>
    withDir(async (_d, file) => {
      expect(await fileStore(file).read()).toBeNull()
      writeFileSync(file, CLEAR + '\n')
      expect(await fileStore(file).read()).toBe(CLEAR)
    }))

  it('an unreadable marker is an error, never "clear" and never "absent"', () =>
    withDir(async (dir, file) => {
      mkdirSync(file) // a directory where the file should be
      await expect(fileStore(file).read()).rejects.toThrow()
      rmSync(file, { recursive: true })
      writeFileSync(file, CLEAR)
      chmodSync(file, 0o000)
      if (process.getuid?.() !== 0) await expect(fileStore(file).read()).rejects.toThrow()
      chmodSync(dir, 0o700)
    }))

  it('arm, restore and a recovery suspend run end to end on a real file, with no temp file left behind', () =>
    withDir(async (dir, file) => {
      const store = fileStore(file)
      await expect(arm({ store, runId: '1', sha: SHA })).rejects.toThrow(/absent/) // no file reads as suspended
      await suspend({ store, runId: '1', sha: SHA, reason: 'adopt', any: true })
      const suspended = readFileSync(file, 'utf8').trim()
      expect(kindOf(suspended)).toBe('suspended')
      await lift({ store, runId: '2', expected: suspended })
      const armed = await arm({ store, runId: '3', sha: SHA })
      expect(readFileSync(file, 'utf8')).toBe(armed + '\n')
      await restore({ store, expected: armed })
      expect(kindOf(readFileSync(file, 'utf8').trim())).toBe('clear')
      expect(readdirSync(dir)).toEqual(['deploy-marker'])
    }))

  it('the file is private to its owner (0600)', () =>
    withDir(async (_d, file) => {
      await suspend({ store: fileStore(file), runId: '1', sha: SHA, reason: 'x', any: true })
      expect(statMode(file)).toBe(0o600)
    }))

  it('a write that cannot be made leaves the old marker in place', () =>
    withDir(async (dir, file) => {
      writeFileSync(file, SUSPENDED + '\n')
      chmodSync(dir, 0o500) // no new files in the directory
      if (process.getuid?.() !== 0) {
        await expect(lift({ store: fileStore(file), runId: '2', expected: SUSPENDED })).rejects.toThrow()
        expect(readFileSync(file, 'utf8')).toBe(SUSPENDED + '\n')
      }
    }))
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
  it('needs no token and no repo: it works on the host file alone, and an absent file refuses an arm', () => {
    const dir = mkdtempSync(join(tmpdir(), 'marker-cli-'))
    try {
      const file = join(dir, 'm')
      const out = join(dir, 'out')
      const env = { C00_MARKER_FILE: file, RUN_ID: '5', SHA, GITHUB_OUTPUT: out }
      const arming = run(['arm'], env)
      expect(arming.status).not.toBe(0)
      expect(arming.stderr).toMatch(/absent/)
      const suspended = run(['suspend', '--reason', 'recovery', '--any'], env)
      expect(suspended.status, suspended.stderr).toBe(0)
      expect(readFileSync(file, 'utf8').trim()).toMatch(new RegExp(`^suspended:[0-9a-f]{32}:5:${SHA}:recovery$`))
      expect(readFileSync(out, 'utf8')).toMatch(/^marker=suspended:/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  it('never reads GH_TOKEN, REPO or the network', () => {
    const src = readFileSync('scripts/deploy-marker.mjs', 'utf8')
    expect(src).not.toMatch(/GH_TOKEN|fetch\(|api\.github|actions\/variables|create-github-app-token/)
  })
})

describe('lift (CHE-5551, C-10.7)', () => {
  it('writes clear:<nonce>:<lift run id> over exactly the expected suspended value, and reads it back', async () => {
    const { state, store } = fake(SUSPENDED)
    const value = await lift({ store, runId: '777', expected: SUSPENDED })
    expect(value).toMatch(/^clear:[0-9a-f]{32}:777$/)
    expect(kindOf(value)).toBe('clear')
    expect(state.value).toBe(value)
    expect(state.writes).toHaveLength(1)
  })

  it('lifts an armed value (a train run that died leaves one)', async () => {
    const { state, store } = fake(OTHER_ARMED)
    await lift({ store, runId: '777', expected: OTHER_ARMED })
    expect(kindOf(state.value)).toBe('clear')
  })

  it('refuses when the marker is not the expected value: nothing is written', async () => {
    const { state, store } = fake(OTHER_ARMED)
    await expect(lift({ store, runId: '777', expected: SUSPENDED })).rejects.toThrow(/changed/)
    expect(state.writes).toEqual([])
    expect(state.value).toBe(OTHER_ARMED)
  })

  it.each([CLEAR, null, 'junk'])('refuses to lift %j (nothing to lift)', async (expected) => {
    const { state, store } = fake(expected)
    await expect(lift({ store, runId: '777', expected })).rejects.toThrow(/lift needs/)
    expect(state.writes).toEqual([])
  })

  it.each(['', 'x y', '1;2', undefined])('refuses a lift run id of %j', async (runId) => {
    const { state, store } = fake(SUSPENDED)
    await expect(lift({ store, runId, expected: SUSPENDED })).rejects.toThrow(/run id/)
    expect(state.writes).toEqual([])
  })

  it('fails when the write cannot be read back', async () => {
    const { store } = fake(SUSPENDED, { stale: true })
    await expect(lift({ store, runId: '777', expected: SUSPENDED })).rejects.toThrow(/read back/)
  })

  it('readMarker returns the value, null when absent, and throws on anything else', async () => {
    expect(await readMarker(fake(SUSPENDED).store)).toBe(SUSPENDED)
    expect(await readMarker(fake(null).store)).toBeNull()
    await expect(readMarker(fake(SUSPENDED, { unreadable: true }).store)).rejects.toThrow()
  })
})
