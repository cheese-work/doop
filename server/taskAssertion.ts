import { createPublicKey, verify, type KeyObject } from 'node:crypto'
import { httpRunsSource, type RunsSource } from './multicaRuns.ts'
import { parseMulticaTaskId, MULTICA_TASK_ASSERTION_HEADER, MULTICA_TASK_HEADER } from '../shared/pageIssue.ts'
import { setTaskIdentityVerifier, warmTaskIdentity, type TaskIdentity } from './writePolicy.ts'

/**
 * G1 identity from a signed Multica task assertion (CHE-7064 plan D1.6, CHE-7081).
 *
 * Token `mta1.<p>.<s>`: `p` is base64url (unpadded) JSON claims, `s` the base64url Ed25519 signature
 * over the ASCII bytes `mta1.` + `p`. The format is pinned by the Multica test vector
 * (`tests/fixtures/taskAssertionVector.json`, CHE-7086). The agent and task come from Multica's task
 * row, signed by its server; an agent can hold only the assertion of its own task.
 */
export type AssertionClaims = {
  v: 1
  kid: string
  aud: string
  /** workspace */
  wid: string
  /** task (run) */
  tid: string
  /** agent */
  aid: string
  /** the task's issue; empty for a chat task */
  iid: string
  /** that issue's project at mint time */
  pid: string
  /** runtime provider */
  prv: string
  /** claimed model */
  mdl: string
  iat: number
  exp: number
}

const PREFIX = 'mta1.'
const AUDIENCE = 'doop'
const MAX_SKEW_S = 60
const MAX_KEYS = 2
/** the fixed DER header of an Ed25519 SPKI public key; the 32 raw bytes follow */
const ED25519_SPKI = Buffer.from('302a300506032b6570032100', 'hex')
const B64URL = /^[A-Za-z0-9_-]+$/
const STRING_CLAIMS = ['kid', 'aud', 'wid', 'tid', 'aid', 'iid', 'pid', 'prv', 'mdl'] as const

/** `DOOP_MULTICA_ASSERTION_KEYS`: JSON `{"<kid>": "<base64 Ed25519 public key>"}`, 1 or 2 keys. Throws on anything else. */
export function parseAssertionKeys(raw: string): Map<string, KeyObject> {
  const parsed: unknown = JSON.parse(raw)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('keys must be a JSON object')
  const entries = Object.entries(parsed)
  if (entries.length === 0 || entries.length > MAX_KEYS) throw new Error(`keys must hold 1 to ${MAX_KEYS} entries`)
  const keys = new Map<string, KeyObject>()
  for (const [kid, value] of entries) {
    const bytes = typeof value === 'string' ? Buffer.from(value, 'base64') : undefined
    if (!kid || !bytes || bytes.length !== 32) throw new Error(`key ${kid || '(empty)'} is not a 32-byte base64 key`)
    keys.set(kid, createPublicKey({ key: Buffer.concat([ED25519_SPKI, bytes]), format: 'der', type: 'spki' }))
  }
  return keys
}

/** strict, unpadded base64url: refuses what a lenient decoder would shrug off */
function decodeB64Url(value: string): Buffer {
  if (!B64URL.test(value)) throw new Error('bad encoding')
  const bytes = Buffer.from(value, 'base64url')
  if (bytes.toString('base64url') !== value) throw new Error('bad encoding')
  return bytes
}

/**
 * The claims of `token`, or a throw naming why it does not count. A token counts only when its `kid` is known,
 * the signature is valid, `v` is 1, `aud` is `doop`, `exp` is in the future and `iat` is at most 60 s ahead.
 */
export function verifyTaskAssertion(
  token: unknown,
  keys: ReadonlyMap<string, KeyObject>,
  nowMs: number = Date.now(),
): AssertionClaims {
  if (typeof token !== 'string' || !token.startsWith(PREFIX)) throw new Error('bad prefix')
  const parts = token.slice(PREFIX.length).split('.')
  if (parts.length !== 2) throw new Error('bad shape')
  const [p, s] = parts as [string, string]
  let claims: Record<string, unknown>
  let signature: Buffer
  try {
    const parsed: unknown = JSON.parse(decodeB64Url(p).toString('utf8'))
    signature = decodeB64Url(s)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
    claims = parsed as Record<string, unknown>
  } catch {
    throw new Error('bad token encoding')
  }
  for (const name of STRING_CLAIMS) if (typeof claims[name] !== 'string') throw new Error(`bad claim ${name}`)
  if (!Number.isInteger(claims.iat) || !Number.isInteger(claims.exp)) throw new Error('bad claim iat or exp')
  const key = keys.get(claims.kid as string)
  if (!key) throw new Error('unknown kid')
  if (!verify(null, Buffer.from(PREFIX + p), key, signature)) throw new Error('bad signature')
  if (claims.v !== 1) throw new Error('unsupported version')
  if (claims.aud !== AUDIENCE) throw new Error('wrong aud')
  if ((claims.exp as number) * 1000 <= nowMs) throw new Error('expired')
  if ((claims.iat as number) > nowMs / 1000 + MAX_SKEW_S) throw new Error('issued in the future')
  return claims as unknown as AssertionClaims
}

const LIVE = new Set(['dispatched', 'running'])

/**
 * Liveness of a verified assertion: Multica's `GET /api/issues/{iid}/task-runs` must list the task as
 * `dispatched` or `running`, with `agent_id` = `aid`. A chat task (empty `iid`) has no such list and
 * fails closed. Throws when Multica cannot be asked (the caller leaves the task unverified).
 */
export async function assertionIdentity(
  claims: AssertionClaims,
  source: RunsSource,
): Promise<TaskIdentity | undefined> {
  if (!claims.iid) return undefined
  const runs = await source.issueRuns(claims.iid)
  const row = runs.find((r) => r.id.toLowerCase() === claims.tid.toLowerCase())
  if (!row || !LIVE.has(row.status) || row.agentId !== claims.aid) return undefined
  return {
    running: true,
    agentId: claims.aid,
    issueId: claims.iid,
    projectId: claims.pid,
    provider: claims.prv,
    model: claims.mdl,
  }
}

let activeKeys: ReadonlyMap<string, KeyObject> | undefined

export function setTaskAssertionKeys(keys: ReadonlyMap<string, KeyObject> | undefined): void {
  activeKeys = keys
}

/** True once the keys are plugged in: from then on only a signed assertion vouches for a task. */
export const taskAssertionsOn = (): boolean => activeKeys !== undefined

type PlugSettings = {
  DOOP_MULTICA_ASSERTION_KEYS?: string
  MULTICA_API_URL?: string
  MULTICA_API_TOKEN?: string
  MULTICA_WORKSPACE_ID?: string
}

/**
 * Boot: plug the task identity verifier in, only when `DOOP_MULTICA_ASSERTION_KEYS`, `MULTICA_API_URL` and
 * `MULTICA_API_TOKEN` are all set and the key list parses. Without them nothing changes. `source` is a test seam;
 * the real one asks Multica in the assertion's own workspace (`wid`, which must equal `MULTICA_WORKSPACE_ID` when that is set).
 */
export function plugTaskAssertions(settings: PlugSettings, source?: RunsSource): boolean {
  const { DOOP_MULTICA_ASSERTION_KEYS: rawKeys, MULTICA_API_URL: apiUrl, MULTICA_API_TOKEN: token } = settings
  if (!rawKeys || !apiUrl || !token) return false
  let keys: Map<string, KeyObject>
  try {
    keys = parseAssertionKeys(rawKeys)
  } catch (e) {
    console.error('DOOP_MULTICA_ASSERTION_KEYS is not usable; task assertions stay off:', (e as Error).message)
    return false
  }
  setTaskAssertionKeys(keys)
  setTaskIdentityVerifier(async (taskId, claims) => {
    /* the bare task id vouches for nothing; a verified assertion for this very task is the only way in */
    if (!claims || claims.tid.toLowerCase() !== taskId.toLowerCase()) return undefined
    if (settings.MULTICA_WORKSPACE_ID && claims.wid !== settings.MULTICA_WORKSPACE_ID) return undefined
    const runs =
      source ?? httpRunsSource({ apiUrl: apiUrl.replace(/\/$/, ''), token, workspaceId: claims.wid, webUrl: '' })
    return assertionIdentity(claims, runs)
  })
  return true
}

/**
 * The Multica task an `/mcp` request acts for, with its identity warmed for the synchronous store.
 * Keys not plugged in: the `X-Multica-Task-Id` header passes through as before. Keys plugged in: only a valid
 * `X-Multica-Task-Assertion` yields a task (its `tid`); a bare id, an invalid or expired token yields none, so
 * the agent is held as a task-less MCP agent (refused everywhere while a verifier is plugged in).
 */
export async function resolveRequestTask(headers: Record<string, unknown>): Promise<string | undefined> {
  if (!activeKeys) {
    const bare = parseMulticaTaskId(headers[MULTICA_TASK_HEADER])
    if (bare) await warmTaskIdentity(bare)
    return bare
  }
  let claims: AssertionClaims
  try {
    claims = verifyTaskAssertion(headers[MULTICA_TASK_ASSERTION_HEADER], activeKeys)
  } catch {
    return undefined
  }
  const taskId = parseMulticaTaskId(claims.tid)
  if (!taskId) return undefined
  await warmTaskIdentity(taskId, claims)
  return taskId
}
