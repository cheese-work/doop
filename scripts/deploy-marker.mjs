// Writes the deploy suspension marker, one file on the C00 host (CHE-5545, plan CHE-5474 C-10; moved off the GitHub
// repo variable DOOP_DEPLOY_SUSPENDED by CHE-9877). It is the one switch that lets the train run, so every write is:
// read it, check it is the value this writer expects, write, read it back. A write that cannot be proven throws and
// fails the job. Only jobs on the C00 runner touch it: no GitHub token, App or repo variable takes part.
//
//   clear:<nonce>:<lift run id|restore>                  the train may run (a lift is written by scripts/deploy-lift.mjs)
//   armed:<nonce>:<run id>:<sha>                         a train run is changing C00
//   suspended:<nonce>:<run id>:<sha>:<reason>            nobody runs until a lift (S3b) writes clear
//
// arm       train, before the first change: clear -> armed (this run's own value)
// restore   train, after a passing confirm only: this run's own armed -> a new clear
// suspend   recovery, drill, rollback, adoption: -> suspended. Never clear. Over this run's own value
//           (armed for a train run, suspended for recovery and drill; MARKER_EXPECT) or over whatever stands (--any).
// Absent or unreadable reads as suspended everywhere else, so every failure here leaves the train stopped. A
// host with no marker file therefore starts suspended; a recovery run writes the first value and a lift clears it.
//
// The file is `$C00_MARKER_FILE`, default `$C00_STATE_DIR/deploy-marker` (C00_STATE_DIR defaults to
// /var/lib/doop-deploy, where c00.sh already keeps its compat guard). One line, written to a temp file in the same
// directory (0600) and renamed over it, so a reader sees the old value or the new one, never half of one.
//
// CLI: node scripts/deploy-marker.mjs arm | restore | suspend --reason <word> (--any)
// Inputs come from env (C00_MARKER_FILE or C00_STATE_DIR, RUN_ID, SHA, MARKER_EXPECT); the value written goes to
// $GITHUB_OUTPUT as `marker`.
import { randomBytes } from 'node:crypto'
import { appendFileSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const NONCE = '[0-9a-f]{32}'
const KINDS = {
  clear: new RegExp(`^clear:${NONCE}:[A-Za-z0-9_-]+$`),
  armed: new RegExp(`^armed:${NONCE}:\\d+:[0-9a-f]{40}$`),
  suspended: new RegExp(`^suspended:${NONCE}:\\d+:[0-9a-f]{40}:[A-Za-z0-9_-]+$`),
}
const SHA40 = /^[0-9a-f]{40}$/
const WORD = /^[A-Za-z0-9_-]+$/

// The kind of a marker value by its exact shape, or null for anything else (never a prefix match).
export const kindOf = (value) =>
  typeof value === 'string' ? (Object.keys(KINDS).find((k) => KINDS[k].test(value)) ?? null) : null

const nonce = () => randomBytes(16).toString('hex')

/** Where the marker lives on the C00 host. */
export const markerFile = (env) =>
  env.C00_MARKER_FILE || join(env.C00_STATE_DIR || '/var/lib/doop-deploy', 'deploy-marker')

/**
 * The marker as a store: `read()` gives the value, null when there is no file, and throws on anything else (a
 * directory, no permission, an I/O error); `write(next)` replaces it atomically.
 */
export function fileStore(path) {
  return {
    async read() {
      try {
        return readFileSync(path, 'utf8').replace(/\n$/, '')
      } catch (err) {
        if (err?.code === 'ENOENT') return null
        throw err
      }
    },
    async write(next) {
      const tmp = `${path}.${process.pid}.tmp`
      try {
        writeFileSync(tmp, `${next}\n`, { mode: 0o600, flag: 'wx' })
        renameSync(tmp, path)
      } catch (err) {
        rmSync(tmp, { force: true })
        throw err
      }
    },
  }
}

/** The marker's value, or null when it does not exist. Anything else that goes wrong throws. */
export const readMarker = (store) => store.read()

/** Read, check, write, read back. `expected` is the exact value that must stand now (null: absent). */
export async function writeMarker({ store, expected, next }) {
  if (!kindOf(next)) throw new Error('refusing to write a value that is not a marker value')
  const now = await readMarker(store)
  if (now !== expected) throw new Error('the suspension marker changed since it was read; nothing was written')
  await store.write(next)
  if ((await readMarker(store)) !== next) throw new Error('the suspension marker write could not be read back')
  return next
}

/** A train run, before its first change: clear -> this run's armed value. Anything but clear refuses. */
export async function arm({ store, runId, sha }) {
  if (!/^\d+$/.test(String(runId)) || !SHA40.test(sha ?? '')) throw new Error('arm needs a run id and a full SHA')
  const now = await readMarker(store)
  if (kindOf(now) !== 'clear') throw new Error(`cannot arm: the marker is ${now === null ? 'absent' : 'not clear'}`)
  return writeMarker({ store, expected: now, next: `armed:${nonce()}:${runId}:${sha}` })
}

/** The arming run, after a passing confirm: its own armed value -> a new clear. Nobody else restores. */
export async function restore({ store, expected }) {
  if (kindOf(expected) !== 'armed') throw new Error('restore needs this run’s own armed value')
  return writeMarker({ store, expected, next: `clear:${nonce()}:restore` })
}

/** An approved lift (CHE-5551, C-10.7): exactly the stated armed or suspended value -> a new clear. Nothing else lifts. */
export async function lift({ store, runId, expected }) {
  if (!/^\d+$/.test(String(runId ?? ''))) throw new Error('lift needs the lift run id')
  if (!['armed', 'suspended'].includes(kindOf(expected) ?? ''))
    throw new Error('lift needs the armed or suspended value it lifts')
  return writeMarker({ store, expected, next: `clear:${nonce()}:${runId}` })
}

/** -> suspended, over this run's own armed value (`expected`) or, with `any`, over whatever stands. */
export async function suspend({ store, runId, sha, reason, expected, any = false }) {
  if (!/^\d+$/.test(String(runId)) || !SHA40.test(sha ?? '')) throw new Error('suspend needs a run id and a full SHA')
  if (!WORD.test(reason ?? '')) throw new Error('the suspension reason must be one word of letters, digits, _ or -')
  let over = expected
  if (any) over = await readMarker(store)
  else if (!['armed', 'suspended'].includes(kindOf(expected) ?? ''))
    throw new Error('suspend needs this run’s own armed or suspended value, or any')
  return writeMarker({ store, expected: over, next: `suspended:${nonce()}:${runId}:${sha}:${reason}` })
}

// ---------------------------------------------------------------------------------------------
async function cli(argv, env) {
  const [command, ...rest] = argv
  if (!['arm', 'restore', 'suspend'].includes(command ?? '')) throw new Error(`unknown command '${command}'`)
  const common = { store: fileStore(markerFile(env)), runId: env.RUN_ID, sha: env.SHA }
  let value
  if (command === 'arm') value = await arm(common)
  else if (command === 'restore') value = await restore({ ...common, expected: env.MARKER_EXPECT })
  else {
    const i = rest.indexOf('--reason')
    value = await suspend({
      ...common,
      reason: i < 0 ? undefined : rest[i + 1],
      any: rest.includes('--any'),
      expected: env.MARKER_EXPECT,
    })
  }
  console.log(`deploy marker: ${command} wrote ${value.split(':')[0]}`)
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `marker=${value}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  cli(process.argv.slice(2), process.env).catch((err) => {
    console.error(`deploy marker failed closed: ${err.message}`)
    process.exit(1)
  })
}
