import { generateKeyPairSync, sign } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/* CHE-7081 (S2 of CHE-7064): doop verifies the signed Multica task assertion (D1.6) and plugs the
   task identity verifier from it. The token format is pinned by the S7 vector (CHE-7086). */
vi.mock('../server/db/persist.ts', () => {
  const noop = () => undefined
  return {
    deleteCanvas: noop,
    deleteFrame: noop,
    deleteGuideline: noop,
    deleteMember: noop,
    deleteReference: noop,
    saveActivity: noop,
    saveCanvas: noop,
    saveCanvasCopy: noop,
    saveFeedback: noop,
    saveFrame: noop,
    appendPageAuthor: noop,
    saveFrameVersion: noop,
    saveGuideline: noop,
    saveMember: noop,
    savePageCopy: noop,
    saveReference: noop,
    saveTask: noop,
  }
})
vi.mock('../server/resident.ts', () => ({ onFeedback: () => {} }))

import * as actions from '../server/actions.ts'
import { store } from '../server/store.ts'
import {
  assertionIdentity,
  parseAssertionKeys,
  plugTaskAssertions,
  resolveRequestTask,
  setTaskAssertionKeys,
  taskAssertionsOn,
  verifyTaskAssertion,
  type AssertionClaims,
} from '../server/taskAssertion.ts'
import { PolicyRefused, setTaskIdentityVerifier, systemContext, writeContextFor } from '../server/writePolicy.ts'
import type { PageRun, RunsSource } from '../server/multicaRuns.ts'
import { canvasPages } from '../shared/pages.ts'

const vector = JSON.parse(readFileSync(new URL('./fixtures/taskAssertionVector.json', import.meta.url), 'utf8')) as {
  public_key_b64: string
  claims: AssertionClaims
  token: string
}
const vectorKeys = () => parseAssertionKeys(JSON.stringify({ k1: vector.public_key_b64 }))
/** a moment inside the vector's validity window */
const AT = (vector.claims.iat + 10) * 1000

const TASK = '01a21aa0-ea3b-7520-91b3-2baddf87460e'
const AGENT = '01a1eb58-065f-792c-8091-537562f55162'
const ISSUE_A = '01a1d642-a8dd-75cd-886c-97d80b9e0048'
const ISSUE_B = '01a1d675-5861-786e-8567-3a074a37c386'
const PROJECT = '01a1eb14-c85e-762d-b0a6-f2a6d4c91254'
const WORKSPACE = 'f2b734e0-b6de-4414-8a27-a2f69b0ef843'

/* a throwaway signing key for the cases the vector cannot express (expiry, aud, kid, skew) */
const pair = generateKeyPairSync('ed25519')
const rawPublic = pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)
const keysFor = (kid: string) => parseAssertionKeys(JSON.stringify({ [kid]: rawPublic.toString('base64') }))
const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url')

function mint(over: Partial<AssertionClaims> = {}, kid = 'kt') {
  const now = Math.floor(Date.now() / 1000)
  const claims: AssertionClaims = {
    v: 1,
    kid,
    aud: 'doop',
    wid: WORKSPACE,
    tid: TASK,
    aid: AGENT,
    iid: ISSUE_A,
    pid: PROJECT,
    prv: 'claude',
    mdl: 'claude-sonnet-5-5',
    iat: now,
    exp: now + 86400,
    ...over,
  }
  const p = b64u(JSON.stringify(claims))
  const signed = `mta1.${p}`
  return `${signed}.${b64u(sign(null, Buffer.from(signed), pair.privateKey))}`
}

const run = (over: Partial<PageRun> = {}): PageRun => ({
  id: TASK,
  kind: 'issue',
  status: 'running',
  agentId: AGENT,
  startedAt: null,
  completedAt: null,
  hopInUrl: '',
  ...over,
})
const source = (runs: PageRun[]): RunsSource => ({ issueRuns: async () => runs })

beforeEach(() => {
  for (const canvas of store.allCanvases()) store.deleteCanvas(systemContext(), canvas.id)
  setTaskIdentityVerifier(undefined)
  setTaskAssertionKeys(undefined)
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  setTaskIdentityVerifier(undefined)
  setTaskAssertionKeys(undefined)
})

describe('the S7 vector', () => {
  it('verifies and yields the claims the Multica side minted', () => {
    expect(verifyTaskAssertion(vector.token, vectorKeys(), AT)).toEqual(vector.claims)
  })

  it('fails when one byte of the payload or of the signature changes', () => {
    const [prefix, p, s] = vector.token.split('.') as [string, string, string]
    const flip = (str: string, at: number) => str.slice(0, at) + (str[at] === 'A' ? 'B' : 'A') + str.slice(at + 1)
    expect(() => verifyTaskAssertion(`${prefix}.${flip(p, 20)}.${s}`, vectorKeys(), AT)).toThrow()
    expect(() => verifyTaskAssertion(`${prefix}.${p}.${flip(s, 10)}`, vectorKeys(), AT)).toThrow()
  })

  it('fails once the token is past exp, or when its kid is not in the key list', () => {
    expect(() => verifyTaskAssertion(vector.token, vectorKeys(), (vector.claims.exp + 1) * 1000)).toThrow(/expired/)
    expect(() =>
      verifyTaskAssertion(vector.token, parseAssertionKeys(JSON.stringify({ other: vector.public_key_b64 })), AT),
    ).toThrow(/kid/)
  })
})

describe('D1.6 verification rules', () => {
  it('accepts a freshly minted token', () => {
    expect(verifyTaskAssertion(mint(), keysFor('kt'))).toMatchObject({ tid: TASK, aid: AGENT, iid: ISSUE_A })
  })
  it('refuses an unknown kid', () => {
    expect(() => verifyTaskAssertion(mint({}, 'kx'), keysFor('kt'))).toThrow(/kid/)
  })
  it('refuses a wrong aud', () => {
    expect(() => verifyTaskAssertion(mint({ aud: 'other' }), keysFor('kt'))).toThrow(/aud/)
  })
  it('refuses a wrong version', () => {
    expect(() => verifyTaskAssertion(mint({ v: 2 as 1 }), keysFor('kt'))).toThrow(/version/)
  })
  it('refuses an expired token', () => {
    const now = Math.floor(Date.now() / 1000)
    expect(() => verifyTaskAssertion(mint({ iat: now - 200, exp: now - 100 }), keysFor('kt'))).toThrow(/expired/)
  })
  it('refuses an iat more than 60 s ahead, and accepts one 30 s ahead', () => {
    const now = Math.floor(Date.now() / 1000)
    expect(() => verifyTaskAssertion(mint({ iat: now + 120 }), keysFor('kt'))).toThrow(/future/)
    expect(verifyTaskAssertion(mint({ iat: now + 30 }), keysFor('kt'))).toBeTruthy()
  })
  it('refuses a signature made by another key under a known kid', () => {
    const other = generateKeyPairSync('ed25519')
    const signed = `mta1.${b64u(JSON.stringify({ ...JSON.parse(Buffer.from(mint().split('.')[1]!, 'base64url').toString()) }))}`
    const forged = `${signed}.${b64u(sign(null, Buffer.from(signed), other.privateKey))}`
    expect(() => verifyTaskAssertion(forged, keysFor('kt'))).toThrow(/signature/)
  })
  it.each(['', 'mta1.', 'mta1.a', 'mta1.a.b.c', 'mta2.a.b', 'bearer x', 42, undefined])(
    'refuses a malformed token %j',
    (t) => {
      expect(() => verifyTaskAssertion(t, keysFor('kt'))).toThrow()
    },
  )
  it('refuses a token whose claim has the wrong type', () => {
    expect(() => verifyTaskAssertion(mint({ tid: 7 as unknown as string }), keysFor('kt'))).toThrow()
  })
})

describe('the key list', () => {
  it('holds at most 2 keys and only 32-byte public keys', () => {
    const k = rawPublic.toString('base64')
    expect(parseAssertionKeys(JSON.stringify({ a: k, b: k })).size).toBe(2)
    expect(() => parseAssertionKeys(JSON.stringify({ a: k, b: k, c: k }))).toThrow()
    expect(() => parseAssertionKeys(JSON.stringify({ a: 'AAAA' }))).toThrow()
    expect(() => parseAssertionKeys('not json')).toThrow()
    expect(() => parseAssertionKeys('{}')).toThrow()
  })
})

describe('liveness through the issue task-runs', () => {
  const claims = () => verifyTaskAssertion(mint(), keysFor('kt'))
  it.each(['running', 'dispatched'])(
    'a %s task of the asserted agent is live, with the claims as identity',
    async (status) => {
      expect(await assertionIdentity(claims(), source([run({ status })]))).toEqual({
        running: true,
        agentId: AGENT,
        issueId: ISSUE_A,
        projectId: PROJECT,
        provider: 'claude',
        model: 'claude-sonnet-5-5',
      })
    },
  )
  it.each(['completed', 'failed', 'cancelled', 'queued'])('a %s task fails', async (status) => {
    expect(await assertionIdentity(claims(), source([run({ status })]))).toBeUndefined()
  })
  it('a task row of another agent fails (agent_id mismatch)', async () => {
    expect(await assertionIdentity(claims(), source([run({ agentId: 'someone-else' })]))).toBeUndefined()
  })
  it('a task Multica does not list fails', async () => {
    expect(await assertionIdentity(claims(), source([run({ id: 'another-task' })]))).toBeUndefined()
  })
  it('a chat task (empty iid) has no issue runs to check and fails closed', async () => {
    const chat = verifyTaskAssertion(mint({ iid: '' }), keysFor('kt'))
    expect(await assertionIdentity(chat, source([run()]))).toBeUndefined()
  })
})

describe('plugging in at boot', () => {
  const settings = (over: Record<string, string | undefined> = {}) => ({
    DOOP_MULTICA_ASSERTION_KEYS: JSON.stringify({ kt: rawPublic.toString('base64') }),
    MULTICA_API_URL: 'https://multica.example',
    MULTICA_API_TOKEN: 'mul_x',
    ...over,
  })
  it.each(['DOOP_MULTICA_ASSERTION_KEYS', 'MULTICA_API_URL', 'MULTICA_API_TOKEN'])(
    'does not plug in without %s: behaviour is as before',
    async (name) => {
      expect(plugTaskAssertions(settings({ [name]: undefined }), source([run()]))).toBe(false)
      expect(taskAssertionsOn()).toBe(false)
      expect(await resolveRequestTask({ 'x-multica-task-id': TASK })).toBe(TASK)
    },
  )
  it('does not plug in when the key list is malformed', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(plugTaskAssertions(settings({ DOOP_MULTICA_ASSERTION_KEYS: '{"a":"AAAA"}' }), source([run()]))).toBe(false)
    expect(taskAssertionsOn()).toBe(false)
  })
  it('plugs in with the three envs', () => {
    expect(plugTaskAssertions(settings(), source([run()]))).toBe(true)
    expect(taskAssertionsOn()).toBe(true)
  })
})

/* a canvas bound to the project, with a page for ISSUE_A and a page for ISSUE_B */
function bound() {
  const sys = systemContext()
  const canvas = store.createCanvas('Multica', 'alice')
  const first = canvasPages(canvas)[0]!
  store.setPages(sys, canvas.id, [first, { id: 'pb', name: 'B' }])
  store.setPageIssue(canvas.id, first.id, ISSUE_A, 'member')
  store.setPageIssue(canvas.id, 'pb', ISSUE_B, 'member')
  store.bindProject(sys, canvas.id, PROJECT)
  const fa = store.createFrame(sys, canvas.id, { name: 'fa', pageId: first.id, html: '<p>a</p>' }, 'x')!
  const fb = store.createFrame(sys, canvas.id, { name: 'fb', pageId: 'pb', html: '<p>b</p>' }, 'x')!
  return { canvas, fa, fb }
}

describe('the /mcp request path: bare task ids and assertions on bound pages', () => {
  const plug = (runs: PageRun[] = [run()]) =>
    plugTaskAssertions(
      {
        DOOP_MULTICA_ASSERTION_KEYS: JSON.stringify({ kt: rawPublic.toString('base64') }),
        MULTICA_API_URL: 'https://multica.example',
        MULTICA_API_TOKEN: 'mul_x',
      },
      source(runs),
    )
  /** what handleMcpRequest does for one request: pick the task, then judge a write as that actor */
  const actorFrom = async (headers: Record<string, string>) => {
    const multicaTaskId = await resolveRequestTask(headers)
    return actions.resolveActor({ name: 'Designer', kind: 'agent', origin: 'mcp', multicaTaskId })
  }

  it('a valid assertion writes on its own bound page', async () => {
    plug()
    const f = bound()
    const actor = await actorFrom({ 'x-multica-task-assertion': mint() })
    expect(actor.multicaTaskId).toBe(TASK)
    const ctx = writeContextFor(actor)
    expect(ctx).toMatchObject({
      verified: true,
      taskId: TASK,
      agentId: AGENT,
      issueId: ISSUE_A,
      projectId: PROJECT,
      provider: 'claude',
      model: 'claude-sonnet-5-5',
    })
    expect(store.updateFrame(ctx, f.fa.id, { html: '<p>new</p>' }, 'Designer')).toBeDefined()
  })

  it("a valid assertion is refused on another issue's page", async () => {
    plug()
    const f = bound()
    const ctx = writeContextFor(await actorFrom({ 'x-multica-task-assertion': mint() }))
    expect(() => store.updateFrame(ctx, f.fb.id, { html: '<p>x</p>' }, 'Designer')).toThrow(PolicyRefused)
    expect(store.getFrame(f.fb.id)?.html).toBe('<p>b</p>')
  })

  it('a bare task id is refused on a bound page when the keys are set', async () => {
    plug()
    const f = bound()
    const ctx = writeContextFor(await actorFrom({ 'x-multica-task-id': TASK }))
    expect(ctx.verified).toBeFalsy()
    expect(() => store.updateFrame(ctx, f.fa.id, { html: '<p>new</p>' }, 'Designer')).toThrow(PolicyRefused)
  })

  it('a bare id cannot borrow the cache a valid assertion filled a moment before', async () => {
    plug()
    const f = bound()
    await actorFrom({ 'x-multica-task-assertion': mint() })
    const ctx = writeContextFor(await actorFrom({ 'x-multica-task-id': TASK }))
    expect(ctx.verified).toBeFalsy()
    expect(() => store.updateFrame(ctx, f.fa.id, { html: '<p>new</p>' }, 'Designer')).toThrow(PolicyRefused)
  })

  it('a bare id next to an assertion of another task does not win: the assertion decides', async () => {
    plug()
    const f = bound()
    const ctx = writeContextFor(
      await actorFrom({ 'x-multica-task-assertion': mint({ iid: ISSUE_B }), 'x-multica-task-id': TASK }),
    )
    expect(ctx.issueId).toBe(ISSUE_B)
    expect(() => store.updateFrame(ctx, f.fa.id, { html: '<p>new</p>' }, 'Designer')).toThrow(PolicyRefused)
  })

  it.each([
    ['an expired token', () => mint({ iat: 1, exp: 2 })],
    ['a wrong aud', () => mint({ aud: 'x' })],
    ['an unknown kid', () => mint({}, 'kx')],
    ['garbage', () => 'mta1.x.y'],
  ])('%s leaves the actor unverified', async (_name, token) => {
    plug()
    const f = bound()
    const ctx = writeContextFor(await actorFrom({ 'x-multica-task-assertion': token() }))
    expect(ctx.verified).toBeFalsy()
    expect(() => store.updateFrame(ctx, f.fa.id, { html: '<p>new</p>' }, 'Designer')).toThrow(PolicyRefused)
  })

  it('an assertion whose task ended is refused', async () => {
    plug([run({ status: 'completed' })])
    const f = bound()
    const ctx = writeContextFor(await actorFrom({ 'x-multica-task-assertion': mint() }))
    expect(ctx.verified).toBeFalsy()
    expect(() => store.updateFrame(ctx, f.fa.id, { html: '<p>new</p>' }, 'Designer')).toThrow(PolicyRefused)
  })

  it('an assertion for a task of another agent (agent_id mismatch) is refused', async () => {
    plug([run({ agentId: 'someone-else' })])
    const f = bound()
    const ctx = writeContextFor(await actorFrom({ 'x-multica-task-assertion': mint() }))
    expect(ctx.verified).toBeFalsy()
    expect(() => store.updateFrame(ctx, f.fa.id, { html: '<p>new</p>' }, 'Designer')).toThrow(PolicyRefused)
  })

  it('Multica not answering leaves the actor unverified', async () => {
    plugTaskAssertions(
      {
        DOOP_MULTICA_ASSERTION_KEYS: JSON.stringify({ kt: rawPublic.toString('base64') }),
        MULTICA_API_URL: 'https://multica.example',
        MULTICA_API_TOKEN: 'mul_x',
      },
      {
        issueRuns: async () => {
          throw new Error('down')
        },
      },
    )
    const ctx = writeContextFor(await actorFrom({ 'x-multica-task-assertion': mint() }))
    expect(ctx.verified).toBeFalsy()
  })

  it('with no keys the header path is as before: the id passes through and nothing is verified', async () => {
    const f = bound()
    const actor = await actorFrom({ 'x-multica-task-id': TASK, 'x-multica-task-assertion': mint() })
    expect(actor.multicaTaskId).toBe(TASK)
    const ctx = writeContextFor(actor)
    expect(ctx).toEqual({ kind: 'agent', taskId: TASK })
    expect(() => store.updateFrame(ctx, f.fa.id, { html: '<p>new</p>' }, 'Designer')).toThrow(PolicyRefused)
  })

  it('with no keys and no header an MCP agent keeps the unbound canvases', async () => {
    const canvas = store.createCanvas('Scratch', 'alice')
    const frame = store.createFrame(systemContext(), canvas.id, { name: 'f', html: '<p>x</p>' }, 'x')!
    const ctx = writeContextFor(await actorFrom({}))
    expect(store.updateFrame(ctx, frame.id, { html: '<p>y</p>' }, 'Designer')).toBeDefined()
  })
})
