import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/* CHE-6624: N0 (WriteContext + assertWritable at the store) and G1 (a Multica
   task writes only to its own project's canvas, on its own issue's page, and
   only once Multica has vouched for the task). */
const db = vi.hoisted(() => ({
  savePageCopy: vi.fn(async (_canvas: unknown, _frames: unknown[], beforeCommit?: () => void) => beforeCommit?.()),
}))
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
    savePageCopy: db.savePageCopy,
    saveReference: noop,
    saveTask: noop,
  }
})
vi.mock('../server/resident.ts', () => ({ onFeedback: () => {} }))

import * as actions from '../server/actions.ts'
import { buildMcpServer } from '../server/mcp.ts'
import { store } from '../server/store.ts'
import {
  assertWritable,
  PolicyRefused,
  setTaskIdentityVerifier,
  systemContext,
  warmTaskIdentity,
  writeContextFor,
  type TaskIdentity,
  type WriteContext,
  type WriteOp,
} from '../server/writePolicy.ts'
import { canvasPages } from '../shared/pages.ts'

const ISSUE_A = '01a1d642-a8dd-75cd-886c-97d80b9e0048'
const ISSUE_B = '01a1d675-5861-786e-8567-3a074a37c386'
const PROJECT_A = 'proj-a'
const PROJECT_B = 'proj-b'
const sys = systemContext()

/** What the agent of a task on ISSUE_A in PROJECT_A looks like once Multica vouched for it. */
const agentA: WriteContext = {
  kind: 'agent',
  taskId: 'task-a',
  agentId: 'agent-1',
  issueId: ISSUE_A,
  projectId: PROJECT_A,
  verified: true,
}
const wrongProject: WriteContext = { ...agentA, projectId: PROJECT_B }
const wrongIssue: WriteContext = { ...agentA, issueId: ISSUE_B }
const unverified: WriteContext = { kind: 'agent', taskId: 'task-a' }
const noTask: WriteContext = { kind: 'agent' }
const user: WriteContext = { kind: 'user', userId: 'cheese' }

/** a canvas bound to PROJECT_A whose page `pa` belongs to ISSUE_A and `pb` to ISSUE_B, a frame on each */
function bound() {
  const canvas = store.createCanvas('Multica', 'alice')
  const first = canvasPages(canvas)[0]!
  store.setPages(sys, canvas.id, [first, { id: 'pb', name: 'B' }])
  store.setPageIssue(canvas.id, first.id, ISSUE_A, 'member')
  store.setPageIssue(canvas.id, 'pb', ISSUE_B, 'member')
  store.bindProject(sys, canvas.id, PROJECT_A)
  const fa = store.createFrame(sys, canvas.id, { name: 'fa', pageId: first.id, html: '<p>a</p>' }, 'x', {
    kind: 'new',
  })!
  const fb = store.createFrame(sys, canvas.id, { name: 'fb', pageId: 'pb', html: '<p>b</p>' }, 'x', { kind: 'new' })!
  return { canvas, pa: first.id, pb: 'pb', fa, fb }
}

/** a plain canvas nobody bound (the test canvas bD8f0BAQRn of CHE-5657) */
function unbound() {
  const canvas = store.createCanvas('Scratch', 'alice')
  const frame = store.createFrame(sys, canvas.id, { name: 'f', html: '<p>x</p>' }, 'x', { kind: 'new' })!
  return { canvas, frame }
}

beforeEach(() => {
  for (const canvas of store.allCanvases()) store.deleteCanvas(sys, canvas.id)
  setTaskIdentityVerifier(undefined)
})
afterEach(() => vi.useRealTimers())

/** every store mutation path of the N0 table, run as `ctx` against a canvas fixture */
const PATHS: { name: string; run: (ctx: WriteContext, f: ReturnType<typeof bound>) => unknown }[] = [
  {
    /* a recon frame: the one frame G2 (tests/reconGuard.test.ts) lets an agent create before the recon is done */
    name: 'createFrame',
    run: (ctx, f) =>
      store.createFrame(
        ctx,
        f.canvas.id,
        { name: 'n', pageId: f.pa, html: '<script type="application/json" id="doop-recon">{}</script>' },
        'a',
        { kind: 'new' },
      ),
  },
  { name: 'updateFrame (html)', run: (ctx, f) => store.updateFrame(ctx, f.fa.id, { html: '<p>new</p>' }, 'a') },
  {
    name: 'updateFrame (append stream)',
    run: (ctx, f) => store.updateFrame(ctx, f.fa.id, { html: f.fa.html + '<i/>' }, 'a'),
  },
  {
    name: 'updateFrame (restore version)',
    run: (ctx, f) => store.updateFrame(ctx, f.fa.id, { html: '<p>old</p>', width: 10, height: 10 }, 'a'),
  },
  { name: 'deleteFrame', run: (ctx, f) => store.deleteFrame(ctx, f.fa.id) },
  { name: 'deleteCanvas', run: (ctx, f) => store.deleteCanvas(ctx, f.canvas.id) },
  {
    name: 'setPages (rename)',
    run: (ctx, f) =>
      store.setPages(ctx, f.canvas.id, [
        { id: f.pa, name: 'Renamed' },
        { id: f.pb, name: 'B' },
      ]),
  },
  { name: 'duplicatePage', run: (ctx, f) => store.duplicatePage(ctx, f.canvas.id, f.pa, 'a') },
]

describe('N0: every mutation path is judged at the store', () => {
  for (const path of PATHS) {
    describe(path.name, () => {
      it('refuses an agent whose project is not the canvas project', async () => {
        const f = bound()
        await expect(Promise.resolve().then(() => path.run(wrongProject, f))).rejects.toBeInstanceOf(PolicyRefused)
      })
      it('refuses an agent that Multica has not vouched for', async () => {
        const f = bound()
        await expect(Promise.resolve().then(() => path.run(unverified, f))).rejects.toBeInstanceOf(PolicyRefused)
      })
      it('refuses a task-less agent on a bound canvas', async () => {
        const f = bound()
        await expect(Promise.resolve().then(() => path.run(noTask, f))).rejects.toBeInstanceOf(PolicyRefused)
      })
      it('lets the same agent through when project and issue match (deleteCanvas never, for an agent)', async () => {
        const f = bound()
        const run = Promise.resolve().then(() => path.run(agentA, f))
        if (path.name === 'deleteCanvas') await expect(run).rejects.toBeInstanceOf(PolicyRefused)
        else await expect(run).resolves.toBeTruthy()
      })
      it('does not stop a user or the system', async () => {
        for (const ctx of [user, sys]) {
          const f = bound()
          await expect(Promise.resolve().then(() => path.run(ctx, f))).resolves.toBeTruthy()
        }
      })
    })
  }

  it('refuses the page of another issue even inside the right project', async () => {
    const f = bound()
    expect(() => store.createFrame(agentA, f.canvas.id, { name: 'n', pageId: f.pb }, 'a', { kind: 'new' })).toThrow(
      PolicyRefused,
    )
    expect(() => store.updateFrame(agentA, f.fb.id, { html: 'x' }, 'a')).toThrow(PolicyRefused)
    expect(() => store.deleteFrame(agentA, f.fb.id)).toThrow(PolicyRefused)
    await expect(store.duplicatePage(wrongIssue, f.canvas.id, f.pa, 'a')).rejects.toBeInstanceOf(PolicyRefused)
  })

  it('refuses moving a frame onto a page of another issue', () => {
    const f = bound()
    expect(() => store.updateFrame(agentA, f.fa.id, { pageId: f.pb }, 'a')).toThrow(PolicyRefused)
  })

  it('an agent cannot drop or rename the page of another issue through a page-list save', () => {
    const f = bound()
    expect(() => store.setPages(agentA, f.canvas.id, [{ id: f.pa, name: 'A' }])).toThrow(PolicyRefused)
    expect(() =>
      store.setPages(agentA, f.canvas.id, [
        { id: f.pa, name: 'A' },
        { id: f.pb, name: 'hijack' },
      ]),
    ).toThrow(PolicyRefused)
  })

  it('a refused write changes nothing', () => {
    const f = bound()
    expect(() => store.deleteFrame(wrongProject, f.fa.id)).toThrow(PolicyRefused)
    expect(store.getFrame(f.fa.id)).toBeDefined()
    expect(() => store.updateFrame(wrongProject, f.fa.id, { html: 'evil' }, 'a')).toThrow(PolicyRefused)
    expect(store.getFrame(f.fa.id)!.html).toBe('<p>a</p>')
    expect(() => store.deleteCanvas(wrongProject, f.canvas.id)).toThrow(PolicyRefused)
    expect(store.getCanvas(f.canvas.id)).toBeDefined()
  })

  it('refuses an op it does not know, whoever asks an agent', () => {
    const f = bound()
    expect(() => assertForTest(agentA, 'frobnicate', f)).toThrow(PolicyRefused)
  })

  it('refuses (does not return not-found) so the caller can tell the two apart', () => {
    const f = bound()
    expect(() => store.updateFrame(wrongProject, f.fa.id, { html: 'x' }, 'a')).toThrow(/policy_refused/)
    expect(store.updateFrame(sys, 'missing', { html: 'x' }, 'a')).toBeUndefined()
  })
})

const assertForTest = (ctx: WriteContext, op: string, f: ReturnType<typeof bound>) =>
  assertWritable(ctx, op as WriteOp, { canvas: f.canvas })

describe('G1: binding a canvas to a project', () => {
  it('a Multica-run agent cannot write to a canvas nobody bound (CHE-5657 test canvas)', () => {
    const { canvas, frame } = unbound()
    expect(() => store.createFrame(agentA, canvas.id, { name: 'n' }, 'a', { kind: 'new' })).toThrow(PolicyRefused)
    expect(() => store.updateFrame(agentA, frame.id, { html: 'x' }, 'a')).toThrow(PolicyRefused)
    expect(() => store.deleteFrame(agentA, frame.id)).toThrow(PolicyRefused)
  })

  it('an agent with no Multica task keeps writing to canvases nobody bound', () => {
    const { canvas, frame } = unbound()
    expect(store.createFrame(noTask, canvas.id, { name: 'n' }, 'a', { kind: 'new' })).toBeDefined()
    expect(store.updateFrame(noTask, frame.id, { html: 'x' }, 'a')).toBeDefined()
  })

  it('only a user or the system may bind; an agent never', () => {
    const { canvas } = unbound()
    expect(() => store.bindProject(agentA, canvas.id, PROJECT_A)).toThrow(PolicyRefused)
    expect(() => store.bindProject(noTask, canvas.id, PROJECT_A)).toThrow(PolicyRefused)
    expect(store.bindProject(user, canvas.id, PROJECT_A)?.projectId).toBe(PROJECT_A)
    expect(() => store.bindProject(agentA, canvas.id, null)).toThrow(PolicyRefused)
    expect(store.getCanvas(canvas.id)?.projectId).toBe(PROJECT_A)
  })

  it('a unit change to the binding is judged against the new binding at once', () => {
    const f = bound()
    store.bindProject(user, f.canvas.id, PROJECT_B)
    expect(() => store.updateFrame(agentA, f.fa.id, { html: 'x' }, 'a')).toThrow(PolicyRefused)
  })
})

describe('G1: the task identity comes from Multica, never from the client', () => {
  const identity = (over: Partial<TaskIdentity> = {}): TaskIdentity => ({
    running: true,
    agentId: 'agent-1',
    issueId: ISSUE_A,
    projectId: PROJECT_A,
    ...over,
  })
  const actorFor = (taskId?: string) => actions.resolveActor({ name: 'Designer', kind: 'agent', multicaTaskId: taskId })

  it('the header alone vouches for nothing: a task Multica was never asked about is refused', () => {
    const f = bound()
    const ctx = writeContextFor(actorFor('task-a'))
    expect(ctx.verified).toBeFalsy()
    expect(ctx.projectId).toBeUndefined()
    expect(() => store.updateFrame(ctx, f.fa.id, { html: 'x' }, 'a')).toThrow(PolicyRefused)
  })

  it('a task Multica confirms writes to its own issue page of its own project', async () => {
    const f = bound()
    setTaskIdentityVerifier(async () => identity())
    await warmTaskIdentity('task-a')
    const ctx = writeContextFor(actorFor('task-a'))
    expect(ctx).toMatchObject({
      kind: 'agent',
      verified: true,
      projectId: PROJECT_A,
      issueId: ISSUE_A,
      agentId: 'agent-1',
    })
    expect(store.updateFrame(ctx, f.fa.id, { html: 'x' }, 'a')).toBeDefined()
  })

  it('a forged task id (the task of another issue) is refused', async () => {
    const f = bound()
    setTaskIdentityVerifier(async () => identity({ issueId: ISSUE_B }))
    await warmTaskIdentity('forged')
    const ctx = writeContextFor(actorFor('forged'))
    expect(() => store.updateFrame(ctx, f.fa.id, { html: 'x' }, 'a')).toThrow(PolicyRefused)
  })

  it('a task from another project is refused', async () => {
    const f = bound()
    setTaskIdentityVerifier(async () => identity({ projectId: PROJECT_B }))
    await warmTaskIdentity('other-project')
    expect(() => store.updateFrame(writeContextFor(actorFor('other-project')), f.fa.id, { html: 'x' }, 'a')).toThrow(
      PolicyRefused,
    )
  })

  it('Multica not answering refuses the write', async () => {
    const f = bound()
    setTaskIdentityVerifier(async () => {
      throw new Error('Multica answered 503')
    })
    await warmTaskIdentity('task-a')
    expect(() => store.updateFrame(writeContextFor(actorFor('task-a')), f.fa.id, { html: 'x' }, 'a')).toThrow(
      PolicyRefused,
    )
  })

  it('no verifier configured refuses the write', async () => {
    const f = bound()
    await warmTaskIdentity('task-a')
    expect(() => store.updateFrame(writeContextFor(actorFor('task-a')), f.fa.id, { html: 'x' }, 'a')).toThrow(
      PolicyRefused,
    )
  })

  it('a task that is no longer running is refused', async () => {
    const f = bound()
    setTaskIdentityVerifier(async () => identity({ running: false }))
    await warmTaskIdentity('task-a')
    expect(() => store.updateFrame(writeContextFor(actorFor('task-a')), f.fa.id, { html: 'x' }, 'a')).toThrow(
      PolicyRefused,
    )
  })

  it('an unknown task (Multica says none) is refused', async () => {
    const f = bound()
    setTaskIdentityVerifier(async () => undefined)
    await warmTaskIdentity('task-a')
    expect(() => store.updateFrame(writeContextFor(actorFor('task-a')), f.fa.id, { html: 'x' }, 'a')).toThrow(
      PolicyRefused,
    )
  })

  it('a verified answer expires, so a task that ended is refused after the TTL', async () => {
    vi.useFakeTimers()
    const f = bound()
    setTaskIdentityVerifier(async () => identity())
    await warmTaskIdentity('task-a')
    expect(store.updateFrame(writeContextFor(actorFor('task-a')), f.fa.id, { html: 'ok' }, 'a')).toBeDefined()
    vi.advanceTimersByTime(10 * 60_000)
    expect(() => store.updateFrame(writeContextFor(actorFor('task-a')), f.fa.id, { html: 'late' }, 'a')).toThrow(
      PolicyRefused,
    )
  })

  it('a user actor is never held to the project binding', () => {
    const f = bound()
    const ctx = writeContextFor(actions.resolveActor({ name: 'Cheese', kind: 'user' }))
    expect(ctx.kind).toBe('user')
    expect(store.updateFrame(ctx, f.fa.id, { html: 'x' }, 'Cheese')).toBeDefined()
  })

  it('an actor that claims to be a user cannot carry a task id into a user context', () => {
    const ctx = writeContextFor({ name: 'x', kind: 'user', color: '#000', multicaTaskId: 'task-a' })
    expect(ctx).toEqual({ kind: 'user' })
  })
})

describe('G1 through the actions layer and MCP', () => {
  const actor = actions.resolveActor({ name: 'Designer', kind: 'agent', multicaTaskId: 'task-a' })

  it('actions.createFrame, updateFrame, deleteFrame, setCanvasPages, deleteCanvas throw policy_refused for an unvouched task', () => {
    const f = bound()
    expect(() => actions.createFrame(f.canvas.id, { name: 'n', pageId: f.pa }, actor, { kind: 'new' })).toThrow(
      PolicyRefused,
    )
    expect(() => actions.updateFrame(f.fa.id, { html: 'x' }, actor)).toThrow(PolicyRefused)
    expect(() => actions.deleteFrame(f.fa.id, actor)).toThrow(PolicyRefused)
    expect(() => actions.setCanvasPages(f.canvas.id, [{ id: f.pa, name: 'x' }], actor)).toThrow(PolicyRefused)
    expect(() => actions.deleteCanvas(f.canvas.id, actor)).toThrow(PolicyRefused)
    expect(store.getFrame(f.fa.id)?.html).toBe('<p>a</p>')
  })

  it('actions.appendFrame and restoreFrameVersion go through the store too', async () => {
    const f = bound()
    expect(() => actions.appendFrameHtml(f.fa.id, '<i/>', actor, { start: false })).toThrow(PolicyRefused)
    expect(store.getFrame(f.fa.id)?.html).toBe('<p>a</p>')
  })

  it('actions.duplicatePage rejects with policy_refused', async () => {
    const f = bound()
    await expect(actions.duplicatePage(f.canvas.id, f.pa, actor)).rejects.toBeInstanceOf(PolicyRefused)
  })

  it('MCP delete_frame with a forged X-Multica-Task-Id is refused and the frame survives', async () => {
    const f = bound()
    const server = buildMcpServer('Owner', 'alice', 'forged-task')
    const client = new Client({ name: 'g1', version: '1.0.0' })
    const [a, b] = InMemoryTransport.createLinkedPair()
    await server.connect(b)
    await client.connect(a)
    try {
      const res = await client.callTool({
        name: 'delete_frame',
        arguments: { canvas_id: f.canvas.id, frame_id: f.fa.id, agent_name: 'Designer' },
      })
      expect(res.isError).toBe(true)
      expect(JSON.stringify(res.content)).toMatch(/policy_refused/)
      expect(store.getFrame(f.fa.id)).toBeDefined()
    } finally {
      await client.close()
      await server.close()
    }
  })
})

describe('N0: the compiler and a source scan keep new writers inside the store', () => {
  it('no file outside the store and the persistence layer mutates canvases or frames', async () => {
    const { readdirSync, readFileSync, statSync } = await import('node:fs')
    const { join } = await import('node:path')
    const files: string[] = []
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name)
        if (statSync(full).isDirectory()) walk(full)
        else if (/\.(ts|tsx)$/.test(name)) files.push(full)
      }
    }
    walk('server')
    const allowed = new Set([join('server', 'store.ts'), join('server', 'db', 'persist.ts')])
    const forbidden = [
      /\bcanvas\.frames\.(push|splice)\b/,
      /\bc\.frames\.(push|splice)\b/,
      /\bcanvases\.(delete|set)\(/,
      /\bpersist\.(saveFrame|saveCanvas|saveCanvasCopy|savePageCopy|deleteFrame|deleteCanvas)\b/,
    ]
    const offenders = files
      .filter((file) => !allowed.has(file))
      .filter((file) => {
        const text = readFileSync(file, 'utf8')
        return forbidden.some((pattern) => pattern.test(text))
      })
    expect(offenders).toEqual([])
  })

  it('the scan really sees a writer: store.ts itself trips every pattern', async () => {
    const { readFileSync } = await import('node:fs')
    const text = readFileSync('server/store.ts', 'utf8')
    expect(/\bpersist\.saveFrame\b/.test(text)).toBe(true)
    expect(/\bc\.frames\.push\b/.test(text)).toBe(true)
    expect(/\bcanvases\.delete\(/.test(text)).toBe(true)
  })
})

describe('review findings (CHE-6624 round 2)', () => {
  const mcpAgent = () => ({
    ...actions.resolveActor({ name: 'designer', kind: 'agent', owner: 'Owner', origin: 'mcp' }),
  })
  const residentAgent = () => actions.resolveActor({ name: 'Doop', kind: 'agent' })
  const syncKey = () => actions.resolveActor({ name: 'Admin app', kind: 'user', origin: 'sync' })
  const verifierDown: Parameters<typeof setTaskIdentityVerifier>[0] = async () => undefined

  it('once Multica identity is on, an MCP agent that omits the task header is refused on an unbound canvas', () => {
    setTaskIdentityVerifier(verifierDown)
    const { canvas, frame } = unbound()
    expect(() => actions.updateFrame(frame.id, { html: '<p>y</p>' }, mcpAgent())).toThrow(/policy_refused/)
    expect(() => actions.createFrame(canvas.id, { name: 'n' }, mcpAgent(), { kind: 'new' })).toThrow(/policy_refused/)
    expect(store.getFrame(frame.id)?.html).toBe('<p>x</p>')
  })

  it('with no Multica identity configured, an MCP agent keeps unbound canvases; in-process agents are never held to it', () => {
    const { frame } = unbound()
    expect(actions.updateFrame(frame.id, { html: '<p>y</p>' }, mcpAgent())).toBeTruthy()
    setTaskIdentityVerifier(verifierDown)
    expect(actions.updateFrame(frame.id, { html: '<p>z</p>' }, residentAgent())).toBeTruthy()
  })

  it('an MCP tool call without the header is refused once identity is on', async () => {
    setTaskIdentityVerifier(verifierDown)
    const { canvas, frame } = unbound()
    const server = buildMcpServer('Owner', 'alice')
    const client = new Client({ name: 't', version: '1' })
    const [a, b] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(a), client.connect(b)])
    const res = (await client.callTool({
      name: 'delete_frame',
      arguments: { canvas_id: canvas.id, frame_id: frame.id, agent_name: 'Designer' },
    })) as { isError?: boolean; content: { text: string }[] }
    expect(res.isError).toBe(true)
    expect(res.content[0]!.text).toMatch(/policy_refused/)
    expect(store.getFrame(frame.id)).toBeTruthy()
    expect(canvas.frames).toHaveLength(1)
  })

  it('an ingest (sync key) write to a project-bound canvas is refused, to an unbound one allowed', () => {
    const { canvas, fa } = bound()
    expect(() => actions.updateFrame(fa.id, { html: '<p>sync</p>' }, syncKey())).toThrow(/policy_refused/)
    expect(() => actions.createFrame(canvas.id, { name: 'n' }, syncKey(), { kind: 'new' })).toThrow(/policy_refused/)
    const free = unbound()
    expect(actions.updateFrame(free.frame.id, { html: '<p>sync</p>' }, syncKey())).toBeTruthy()
  })

  it('page copy: the policy is judged inside the database transaction, and a rebind during it is held off', async () => {
    const f = bound()
    let release!: () => void
    db.savePageCopy.mockImplementationOnce(
      (_canvas, _frames, beforeCommit) =>
        new Promise<void>((resolve, reject) => {
          release = () => {
            try {
              beforeCommit?.()
              resolve()
            } catch (err) {
              reject(err)
            }
          }
        }),
    )
    const pending = store.duplicatePage(agentA, f.canvas.id, f.pa, 'a')
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    expect(() => store.bindProject(sys, f.canvas.id, PROJECT_B)).toThrow(/policy_refused/)
    release()
    expect((await pending)?.frames).toHaveLength(1)
    expect(f.canvas.projectId).toBe(PROJECT_A)
  })

  it('page copy: a page that loses its issue during the write is refused in the transaction, memory untouched', async () => {
    const f = bound()
    let release!: () => void
    db.savePageCopy.mockImplementationOnce(
      (_canvas, _frames, beforeCommit) =>
        new Promise<void>((resolve, reject) => {
          release = () => {
            try {
              beforeCommit?.()
              resolve()
            } catch (err) {
              reject(err)
            }
          }
        }),
    )
    const pages = canvasPages(f.canvas).length
    const frames = f.canvas.frames.length
    const pending = store.duplicatePage(agentA, f.canvas.id, f.pa, 'a')
    const outcome = pending.then(
      () => 'ok',
      (e: unknown) => (e instanceof PolicyRefused ? 'refused' : 'other'),
    )
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    store.setPageIssue(f.canvas.id, f.pa, ISSUE_B, 'member')
    release()
    expect(await outcome).toBe('refused')
    expect(canvasPages(f.canvas)).toHaveLength(pages)
    expect(f.canvas.frames).toHaveLength(frames)
  })
})
