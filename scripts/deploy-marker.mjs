// Writes the deploy suspension marker, the repo variable DOOP_DEPLOY_SUSPENDED (CHE-5545, plan CHE-5474 C-10).
// It is the one switch that lets the train run, so every write is: read it, check it is the value this
// writer expects, write, read it back. A write that cannot be proven throws and fails the job.
//
//   clear:<nonce>:<lift run id|restore>                  the train may run
//   armed:<nonce>:<run id>:<sha>                         a train run is changing C00
//   suspended:<nonce>:<run id>:<sha>:<reason>            nobody runs until a lift (S3b) writes clear
//
// arm       train, before the first change: clear -> armed (this run's own value)
// restore   train, after a passing confirm only: this run's own armed -> a new clear
// suspend   recovery, drill, rollback, adoption: -> suspended. Never clear. Over this run's own armed
//           (--expect from MARKER_EXPECT) or over whatever stands (--any).
// Absent or unreadable reads as suspended everywhere else, so every failure here leaves the train stopped.
//
// CLI: node scripts/deploy-marker.mjs arm | restore | suspend --reason <word> (--any)
// Inputs come from env (GH_TOKEN of the marker GitHub App, REPO, RUN_ID, SHA, MARKER_EXPECT); the value
// written goes to $GITHUB_OUTPUT as `marker`. `GITHUB_TOKEN` cannot write variables, hence the App token.
import { randomBytes } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const NAME = 'DOOP_DEPLOY_SUSPENDED'
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

// The variable's value, or null when it does not exist. Anything else that goes wrong throws.
async function read(ghApi, repo) {
  try {
    return String((await ghApi(`repos/${repo}/actions/variables/${NAME}`)).value ?? '')
  } catch (err) {
    if (err?.status === 404) return null
    throw err
  }
}

/** Read, check, write, read back. `expected` is the exact value that must stand now (null: absent). */
export async function writeMarker({ ghApi, repo, expected, next }) {
  if (!kindOf(next)) throw new Error('refusing to write a value that is not a marker value')
  const now = await read(ghApi, repo)
  if (now !== expected) throw new Error('the suspension marker changed since it was read; nothing was written')
  if (now === null)
    await ghApi(`repos/${repo}/actions/variables`, { method: 'POST', body: { name: NAME, value: next } })
  else await ghApi(`repos/${repo}/actions/variables/${NAME}`, { method: 'PATCH', body: { name: NAME, value: next } })
  if ((await read(ghApi, repo)) !== next) throw new Error('the suspension marker write could not be read back')
  return next
}

/** A train run, before its first change: clear -> this run's armed value. Anything but clear refuses. */
export async function arm({ ghApi, repo, runId, sha }) {
  if (!/^\d+$/.test(String(runId)) || !SHA40.test(sha ?? '')) throw new Error('arm needs a run id and a full SHA')
  const now = await read(ghApi, repo)
  if (kindOf(now) !== 'clear') throw new Error(`cannot arm: the marker is ${now === null ? 'absent' : 'not clear'}`)
  return writeMarker({ ghApi, repo, expected: now, next: `armed:${nonce()}:${runId}:${sha}` })
}

/** The arming run, after a passing confirm: its own armed value -> a new clear. Nobody else restores. */
export async function restore({ ghApi, repo, expected }) {
  if (kindOf(expected) !== 'armed') throw new Error('restore needs this run’s own armed value')
  return writeMarker({ ghApi, repo, expected, next: `clear:${nonce()}:restore` })
}

/** -> suspended, over this run's own armed value (`expected`) or, with `any`, over whatever stands. */
export async function suspend({ ghApi, repo, runId, sha, reason, expected, any = false }) {
  if (!/^\d+$/.test(String(runId)) || !SHA40.test(sha ?? '')) throw new Error('suspend needs a run id and a full SHA')
  if (!WORD.test(reason ?? '')) throw new Error('the suspension reason must be one word of letters, digits, _ or -')
  let over = expected
  if (any) over = await read(ghApi, repo)
  else if (kindOf(expected) !== 'armed') throw new Error('suspend needs this run’s own armed value, or any')
  return writeMarker({ ghApi, repo, expected: over, next: `suspended:${nonce()}:${runId}:${sha}:${reason}` })
}

// ---------------------------------------------------------------------------------------------
const api =
  (token) =>
  async (path, init = {}) => {
    const res = await fetch(`${process.env.GITHUB_API_URL || 'https://api.github.com'}/${path}`, {
      method: init.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
    })
    if (!res.ok)
      throw Object.assign(new Error(`GitHub ${res.status} for ${init.method ?? 'GET'} ${path}`), { status: res.status })
    const text = await res.text()
    return text ? JSON.parse(text) : {}
  }

async function cli(argv, env) {
  const [command, ...rest] = argv
  if (!['arm', 'restore', 'suspend'].includes(command ?? '')) throw new Error(`unknown command '${command}'`)
  if (!env.GH_TOKEN || !env.REPO) throw new Error('GH_TOKEN and REPO are required')
  const common = { ghApi: api(env.GH_TOKEN), repo: env.REPO, runId: env.RUN_ID, sha: env.SHA }
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
