import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error plain .mjs script, no type declarations
import { admitDispatcher, ictTime, lift, parseList, readDecision, refusalFor } from '../scripts/deploy-lift.mjs'
// @ts-expect-error plain .mjs script, no type declarations
import { kindOf } from '../scripts/deploy-marker.mjs'

/* CHE-5551 (train S3b, plan CHE-5474 C-10.6 and C-10.7). The lift is the only way back from a suspension. It
   writes `clear:*` only when one approved Multica decision of type doop.deploy_lift, answered by Cheese, names the
   exact marker that stands now, and C00 is quiescent and healthy. The decision and the marker are read again
   right before the write. A refused lift leaves the marker exactly as it was. A fake GitHub holds the variable and
   a fake Multica serves the decision; both record every call. */
const REPO = 'cheese-work/doop'
const SHA = 'c'.repeat(40)
const SUSPENDED = 'suspended:' + '2'.repeat(32) + ':9:' + SHA + ':migrated'
const ARMED = 'armed:' + '1'.repeat(32) + ':8:' + SHA
const CLEAR = 'clear:' + '0'.repeat(32) + ':restore'
const DECISION_ID = '7a1f0f3e-5d2e-4b6a-9c11-0b0f7d3a2c10'
const CHEESE = 'user-cheese-0001'
const SERVER = 'https://multica.tailnet.example'
const WORKSPACE = 'ws-0001'
const TOKEN = 'mdt_secret_read_token'
const HEALTHZ = 'http://127.0.0.1:4400/healthz'
const DIGEST = 'sha256:' + 'a'.repeat(64)
const RUN_ID = '4242'
const NOW = new Date('2026-11-20T03:00:00Z') // 10:00:00 ICT

type Decision = Record<string, unknown>
const decisionOf = (over: Decision = {}): Decision => ({
  decision_id: DECISION_ID,
  action_id: 'act-1',
  action_type: 'doop.deploy_lift',
  action_version: 1,
  state: 'approved',
  approver_id: CHEESE,
  answered_at: '2026-11-20T02:00:00Z',
  withdrawn_at: null,
  revoked_at: null,
  expires_at: '2026-11-21T02:00:00Z',
  params: { marker_value: SUSPENDED, repo: REPO },
  ...over,
})

/** A well-formed decision with one API field left out of the body (not null: absent). */
const withoutField = (field: string): Decision => {
  const { [field]: _omitted, ...rest } = decisionOf()
  return rest
}

type World = {
  marker: string | null
  /** What the decision API answers on read n (1-based); a function may change the world first. */
  decision?: (n: number) => { status: number; body?: unknown; text?: string } | 'throw'
  health?: number | 'throw'
  unreadableMarker?: boolean
  /** Runs after the n-th marker read; used to change the marker mid-lift. */
  afterMarkerRead?: (n: number, w: World) => void
}

function world(w: World) {
  const calls = { decision: 0, marker: 0, health: 0, headers: [] as Record<string, string>[], writes: [] as string[] }
  // The marker is a file on the C00 host; this store stands in for it.
  const store = {
    read: async () => {
      calls.marker++
      if (w.unreadableMarker) throw new Error('EIO: cannot read the marker')
      const n = calls.marker
      const value = w.marker
      w.afterMarkerRead?.(n, w)
      return value
    },
    write: async (next: string) => {
      calls.writes.push(next)
      w.marker = next
    },
  }
  const fetchImpl = async (url: string, init: { headers?: Record<string, string> } = {}) => {
    if (url === HEALTHZ) {
      calls.health++
      if (w.health === 'throw') throw new Error('connect ECONNREFUSED')
      return { ok: (w.health ?? 200) === 200, status: w.health ?? 200, text: async () => '{"ok":true}' }
    }
    if (url !== `${SERVER}/api/decisions/${DECISION_ID}/state`) throw new Error(`unexpected fetch ${url}`)
    calls.decision++
    calls.headers.push(init.headers ?? {})
    const r = (
      w.decision ?? ((): { status: number; body?: unknown; text?: string } => ({ status: 200, body: decisionOf() }))
    )(calls.decision)
    if (r === 'throw') throw new Error('getaddrinfo ENOTFOUND multica.tailnet.example')
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      text: async () => r.text ?? JSON.stringify(r.body ?? {}),
    }
  }
  return { w, calls, store, fetchImpl }
}

const goodFacts = { quiescent: true, digest: DIGEST, revision: SHA, containerHealth: 'healthy' }

function run(
  env: ReturnType<typeof world>,
  over: { facts?: Record<string, unknown>; approverId?: string; lifter?: string } = {},
) {
  return lift({
    store: env.store,
    fetchImpl: env.fetchImpl,
    repo: REPO,
    runId: RUN_ID,
    lifter: over.lifter ?? 'congvc-dev',
    decisionId: DECISION_ID,
    approverId: over.approverId ?? CHEESE,
    server: SERVER,
    workspace: WORKSPACE,
    token: TOKEN,
    healthzUrl: HEALTHZ,
    facts: over.facts ?? goodFacts,
    now: () => NOW,
  })
}

describe('the accepted lift (C-10.7)', () => {
  it('writes a new clear:<nonce>:<lift run id>, reads it back, and records the evidence', async () => {
    const env = world({ marker: SUSPENDED })
    const ev = await run(env)
    expect(ev.outcome).toBe('lifted')
    expect(env.calls.writes).toHaveLength(1)
    const written = env.calls.writes[0] ?? ''
    expect(written).toMatch(new RegExp(`^clear:[0-9a-f]{32}:${RUN_ID}$`))
    expect(kindOf(written)).toBe('clear')
    expect(env.w.marker).toBe(written)
    expect(ev).toMatchObject({
      outcome: 'lifted',
      lifter: 'congvc-dev',
      decision_id: DECISION_ID,
      approver_id: CHEESE,
      lift_run_id: RUN_ID,
      marker_before: SUSPENDED,
      marker_after: written,
      health: { status: 200, url: HEALTHZ },
      quiescence: 'proven',
      digest: DIGEST,
      revision: SHA,
    })
    expect(ev.started_ict).toBe('2026-11-20 10:00:00 ICT')
    expect(ev.finished_ict).toBe('2026-11-20 10:00:00 ICT')
  })

  it('lifts an armed marker too (a train run that died leaves one)', async () => {
    const env = world({
      marker: ARMED,
      decision: () => ({ status: 200, body: decisionOf({ params: { marker_value: ARMED, repo: REPO } }) }),
    })
    expect((await run(env)).outcome).toBe('lifted')
  })

  it('reads the decision with the scoped token and the workspace header, twice, and never writes the token down', async () => {
    const env = world({ marker: SUSPENDED })
    const ev = await run(env)
    expect(env.calls.decision).toBe(2)
    for (const h of env.calls.headers) {
      expect(h.Authorization).toBe(`Bearer ${TOKEN}`)
      expect(h['X-Workspace-ID']).toBe(WORKSPACE)
    }
    expect(JSON.stringify(ev)).not.toContain(TOKEN)
  })

  it('reads the decision again, then the marker again, right before the write', async () => {
    const order: string[] = []
    const env = world({
      marker: SUSPENDED,
      decision: (n) => {
        order.push(`decision${n}`)
        return { status: 200, body: decisionOf() }
      },
      afterMarkerRead: (n) => order.push(`marker${n}`),
    })
    const base = env.store.write
    env.store.write = async (next: string) => {
      order.push('write')
      return base(next)
    }
    await run(env)
    // decision 1 and marker 1 decide; decision 2 and marker 2 are the re-read; marker 3 is writeMarker's own check.
    expect(order.slice(0, 2).sort()).toEqual(['decision1', 'marker1'])
    expect(order.indexOf('decision2')).toBeLessThan(order.indexOf('write'))
    expect(order.indexOf('marker2')).toBeLessThan(order.indexOf('write'))
    expect(order.indexOf('decision2')).toBeLessThan(order.indexOf('marker2'))
    expect(order.filter((x) => x === 'write')).toHaveLength(1)
  })
})

/* Every refusal: nothing was written, and the marker is exactly as it was (or as another run left it). */
async function refused(
  env: ReturnType<typeof world>,
  over?: Parameters<typeof run>[1],
  reason?: RegExp,
  /** The marker that stands after: the one it was, unless another run changed it meanwhile. */
  standing?: string,
) {
  const before = standing ?? env.w.marker
  const ev = await run(env, over)
  expect(ev.outcome).toBe('refused')
  if (reason) expect(ev.reason).toMatch(reason)
  expect(env.calls.writes).toEqual([])
  expect(env.w.marker).toBe(before)
  return ev
}

describe('refused: the decision (C-10.6, C-10.7)', () => {
  it('no decision (404)', async () => {
    await refused(world({ marker: SUSPENDED, decision: () => ({ status: 404 }) }), undefined, /no such decision/)
  })

  it.each([
    ['server error', () => ({ status: 500, text: 'boom' })],
    ['forbidden (bad scope or not the owner)', () => ({ status: 403 })],
    ['unauthorized', () => ({ status: 401 })],
    ['not JSON', () => ({ status: 200, text: '<html>' })],
    ['a JSON array', () => ({ status: 200, body: [] })],
    ['the network fails', () => 'throw' as const],
    ['no state', () => ({ status: 200, body: { ...decisionOf(), state: undefined } })],
    ['no approver', () => ({ status: 200, body: { ...decisionOf(), approver_id: undefined } })],
    ['no params', () => ({ status: 200, body: { ...decisionOf(), params: undefined } })],
    ['no marker_value', () => ({ status: 200, body: decisionOf({ params: { repo: REPO } }) })],
    ['no repo', () => ({ status: 200, body: decisionOf({ params: { marker_value: SUSPENDED } }) })],
    ['no answered_at', () => ({ status: 200, body: decisionOf({ answered_at: null }) })],
    ['another decision id', () => ({ status: 200, body: decisionOf({ decision_id: 'someone-else' }) })],
    ['an unparsable deadline', () => ({ status: 200, body: decisionOf({ expires_at: 'soon' }) })],
    ['no withdrawn_at field', () => ({ status: 200, body: withoutField('withdrawn_at') })],
    ['no revoked_at field', () => ({ status: 200, body: withoutField('revoked_at') })],
    ['no expires_at field', () => ({ status: 200, body: withoutField('expires_at') })],
  ])('unreadable decision: %s', async (_name, decision) => {
    await refused(world({ marker: SUSPENDED, decision }), undefined, /unreadable|no such decision/)
  })

  it.each(['doop.deploy', 'doop.deploy_lift2', '', 'multica.issue.close'])('wrong action type %j', async (type) => {
    await refused(
      world({ marker: SUSPENDED, decision: () => ({ status: 200, body: decisionOf({ action_type: type }) }) }),
      undefined,
      /action type/,
    )
  })

  it('wrong action version', async () => {
    await refused(
      world({ marker: SUSPENDED, decision: () => ({ status: 200, body: decisionOf({ action_version: 2 }) }) }),
      undefined,
      /action version/,
    )
  })

  it.each(['pending', 'rejected', 'withdrawn', 'revoked', 'expired', 'cancelled', 'failed', 'APPROVED', ''])(
    'state %j is not approved',
    async (state) => {
      await refused(
        world({ marker: SUSPENDED, decision: () => ({ status: 200, body: decisionOf({ state }) }) }),
        undefined,
        /not approved|unreadable/,
      )
    },
  )

  it.each([
    ['withdrawn_at', '2026-11-20T02:30:00Z'],
    ['revoked_at', '2026-11-20T02:30:00Z'],
  ])('approved but %s is set', async (field, at) => {
    await refused(
      world({ marker: SUSPENDED, decision: () => ({ status: 200, body: decisionOf({ [field]: at }) }) }),
      undefined,
      /withdrawn|revoked/,
    )
  })

  it('approved but past its deadline', async () => {
    await refused(
      world({
        marker: SUSPENDED,
        decision: () => ({ status: 200, body: decisionOf({ expires_at: '2026-11-20T02:59:59Z' }) }),
      }),
      undefined,
      /expired/,
    )
  })

  it('approver is not Cheese', async () => {
    await refused(
      world({
        marker: SUSPENDED,
        decision: () => ({ status: 200, body: decisionOf({ approver_id: 'user-agent-1' }) }),
      }),
      undefined,
      /approver/,
    )
  })

  it('no configured approver id refuses everything', async () => {
    await refused(world({ marker: SUSPENDED }), { approverId: '' }, /approver/)
  })
})

describe('refused: the marker (C-10.7)', () => {
  it('marker_value is not the marker that stands now', async () => {
    const other = 'suspended:' + '3'.repeat(32) + ':9:' + SHA + ':migrated'
    await refused(
      world({
        marker: SUSPENDED,
        decision: () => ({ status: 200, body: decisionOf({ params: { marker_value: other, repo: REPO } }) }),
      }),
      undefined,
      /marker_value/,
    )
  })

  it('marker_value differs by one byte (no prefix or case folding)', async () => {
    await refused(
      world({
        marker: SUSPENDED,
        decision: () => ({
          status: 200,
          body: decisionOf({ params: { marker_value: SUSPENDED + ' ', repo: REPO } }),
        }),
      }),
      undefined,
      /marker_value/,
    )
  })

  it('repo param is another repository', async () => {
    await refused(
      world({
        marker: SUSPENDED,
        decision: () => ({
          status: 200,
          body: decisionOf({ params: { marker_value: SUSPENDED, repo: 'other/doop' } }),
        }),
      }),
      undefined,
      /repo/,
    )
  })

  it('the marker is already clear: nothing to lift', async () => {
    await refused(
      world({
        marker: CLEAR,
        decision: () => ({ status: 200, body: decisionOf({ params: { marker_value: CLEAR, repo: REPO } }) }),
      }),
      undefined,
      /clear/,
    )
  })

  it('the marker is absent', async () => {
    await refused(world({ marker: null }), undefined, /absent/)
  })

  it('the marker is unreadable', async () => {
    await refused(world({ marker: SUSPENDED, unreadableMarker: true }), undefined, /marker/)
  })

  it('the marker is not a marker value', async () => {
    await refused(
      world({
        marker: 'whatever',
        decision: () => ({ status: 200, body: decisionOf({ params: { marker_value: 'whatever', repo: REPO } }) }),
      }),
      undefined,
      /marker/,
    )
  })
})

describe('refused: a change during the lift (C-10.7, the re-read under the lock)', () => {
  it('the marker changes after the decision was read: refused, and the new marker stands', async () => {
    const other = 'suspended:' + '3'.repeat(32) + ':10:' + SHA + ':readback'
    const env = world({
      marker: SUSPENDED,
      decision: (n) => {
        if (n === 2) env.w.marker = other // a recovery run suspends again while the lift runs
        return { status: 200, body: decisionOf() }
      },
    })
    const ev = await refused(env, undefined, /marker/, other)
    expect(ev.reason).toMatch(/changed|marker_value/)
  })

  it('the marker changes between the re-read and the write: writeMarker still refuses', async () => {
    const other = 'suspended:' + '3'.repeat(32) + ':10:' + SHA + ':readback'
    const env = world({
      marker: SUSPENDED,
      afterMarkerRead: (n, w) => {
        if (n === 2) w.marker = other // the second marker read passes; the next one sees the change
      },
    })
    const ev = await refused(env, undefined, /changed/, other)
    expect(ev.outcome).toBe('refused')
  })

  it.each(['revoked', 'withdrawn', 'expired', 'rejected'])('the decision becomes %s during the lift', async (state) => {
    const env = world({
      marker: SUSPENDED,
      decision: (n) => ({ status: 200, body: decisionOf(n === 1 ? {} : { state }) }),
    })
    await refused(env, undefined, /not approved/)
    expect(env.calls.decision).toBe(2)
  })

  it('revoked_at appears during the lift', async () => {
    const env = world({
      marker: SUSPENDED,
      decision: (n) => ({ status: 200, body: decisionOf(n === 1 ? {} : { revoked_at: '2026-11-20T02:59:00Z' }) }),
    })
    await refused(env, undefined, /revoked/)
  })

  it('the decision cannot be read the second time', async () => {
    const env = world({
      marker: SUSPENDED,
      decision: (n) => (n === 1 ? { status: 200, body: decisionOf() } : { status: 503 }),
    })
    await refused(env, undefined, /unreadable/)
  })

  it('a write that cannot be read back is a failure, not a refusal, and says so', async () => {
    const env = world({ marker: SUSPENDED })
    env.store.write = async (next: string) => {
      env.calls.writes.push(next) // a lost update: the write says ok, a read still returns the old value
    }
    const ev = await run(env)
    expect(ev.outcome).toBe('failed')
    expect(ev.reason).toMatch(/read back/)
  })
})

describe('refused: C00 (C-10.7)', () => {
  it.each([404, 500, 503, 302])('/healthz answers %i', async (status) => {
    await refused(world({ marker: SUSPENDED, health: status }), undefined, /health/)
  })

  it('/healthz does not answer', async () => {
    await refused(world({ marker: SUSPENDED, health: 'throw' }), undefined, /health/)
  })

  it('unproven migration quiescence', async () => {
    await refused(world({ marker: SUSPENDED }), { facts: { ...goodFacts, quiescent: false } }, /quiescence/)
  })

  it.each([undefined, 'true', 1])('quiescence must be the boolean true, not %j', async (quiescent) => {
    await refused(world({ marker: SUSPENDED }), { facts: { ...goodFacts, quiescent } }, /quiescence/)
  })

  it('the container itself is not healthy', async () => {
    await refused(world({ marker: SUSPENDED }), { facts: { ...goodFacts, containerHealth: 'unhealthy' } }, /health/)
  })

  it.each([
    ['digest', 'latest'],
    ['digest', ''],
    ['revision', 'abc'],
    ['revision', ''],
  ])('no readable %s (%j)', async (field, value) => {
    await refused(world({ marker: SUSPENDED }), { facts: { ...goodFacts, [field]: value } }, new RegExp(field))
  })

  it('a refusal never reaches the marker at all for a bad run id', async () => {
    const env = world({ marker: SUSPENDED })
    const ev = await lift({
      store: env.store,
      fetchImpl: env.fetchImpl,
      repo: REPO,
      runId: 'x; rm -rf',
      lifter: 'congvc-dev',
      decisionId: DECISION_ID,
      approverId: CHEESE,
      server: SERVER,
      workspace: WORKSPACE,
      token: TOKEN,
      healthzUrl: HEALTHZ,
      facts: goodFacts,
      now: () => NOW,
    })
    expect(ev.outcome).toBe('refused')
    expect(env.calls.writes).toEqual([])
  })
})

describe('two lifts of the same decision serialize, and the second is refused (marker changed)', () => {
  it('the second sees the first one’s clear and refuses', async () => {
    const env = world({ marker: SUSPENDED })
    const first = await run(env)
    expect(first.outcome).toBe('lifted')
    const afterFirst = env.w.marker
    const second = await run(env)
    expect(second.outcome).toBe('refused')
    expect(second.reason).toMatch(/marker/)
    expect(env.calls.writes).toHaveLength(1)
    expect(env.w.marker).toBe(afterFirst)
  })
})

describe('the decision read', () => {
  const base = { server: SERVER, workspace: WORKSPACE, token: TOKEN, id: DECISION_ID }

  it('refuses a decision id that is not a plain token, before any request', async () => {
    const env = world({ marker: SUSPENDED })
    await expect(readDecision({ ...base, id: '../x?y', fetchImpl: env.fetchImpl })).rejects.toThrow(/decision id/)
    expect(env.calls.decision).toBe(0)
  })

  it.each(['', 'ftp://x', 'multica.tailnet.example'])(
    'refuses a server URL that is not http(s): %j',
    async (server) => {
      const env = world({ marker: SUSPENDED })
      await expect(readDecision({ ...base, server, fetchImpl: env.fetchImpl })).rejects.toThrow(/server/)
    },
  )

  it('refuses a missing token or workspace', async () => {
    const env = world({ marker: SUSPENDED })
    await expect(readDecision({ ...base, token: '', fetchImpl: env.fetchImpl })).rejects.toThrow(/token/)
    await expect(readDecision({ ...base, workspace: '', fetchImpl: env.fetchImpl })).rejects.toThrow(/workspace/)
  })

  it('does not put the token in an error', async () => {
    const env = world({ marker: SUSPENDED, decision: () => ({ status: 500, text: TOKEN }) })
    const err = await readDecision({ ...base, fetchImpl: env.fetchImpl }).catch((e: Error) => e)
    expect(String((err as Error).message)).not.toContain(TOKEN)
  })
})

describe('refusalFor (pure)', () => {
  const ctx = { marker: SUSPENDED, repo: REPO, approverId: CHEESE, now: NOW }
  it('is null for the good decision and names the reason otherwise', () => {
    expect(refusalFor(decisionOf(), ctx)).toBeNull()
    expect(refusalFor(decisionOf({ state: 'revoked' }), ctx)).toMatch(/not approved/)
    expect(refusalFor(decisionOf({ approver_id: 'x' }), ctx)).toMatch(/approver/)
  })
})

describe('the dispatcher allowlist (C-10.7)', () => {
  it('parses a comma or space separated list', () => {
    expect(parseList('congvc-dev, congvc-bot-x99\ncheese')).toEqual(['congvc-dev', 'congvc-bot-x99', 'cheese'])
    expect(parseList(undefined)).toEqual([])
    expect(parseList('')).toEqual([])
  })

  it('admits a dispatcher on the list, whose own login also triggered the run', () => {
    expect(() =>
      admitDispatcher({ actor: 'congvc-dev', triggering: 'congvc-dev', allowed: 'congvc-dev,congvc-bot-x99' }),
    ).not.toThrow()
  })

  it.each([
    ['not on the list', 'mallory', 'mallory'],
    ['actor on the list but the rerun was triggered by another login', 'congvc-dev', 'mallory'],
    ['triggering login on the list but the actor is not', 'mallory', 'congvc-dev'],
    ['empty actor', '', ''],
  ])('refuses: %s', (_n, actor, triggering) => {
    expect(() => admitDispatcher({ actor, triggering, allowed: 'congvc-dev,congvc-bot-x99' })).toThrow(/dispatcher/)
  })

  it('refuses everyone when the list is unset or empty', () => {
    expect(() => admitDispatcher({ actor: 'congvc-dev', triggering: 'congvc-dev', allowed: '' })).toThrow(/dispatcher/)
    expect(() => admitDispatcher({ actor: 'congvc-dev', triggering: 'congvc-dev', allowed: undefined })).toThrow(
      /dispatcher/,
    )
  })

  it('matches whole logins, case-insensitively, never a prefix', () => {
    expect(() => admitDispatcher({ actor: 'congvc', triggering: 'congvc', allowed: 'congvc-dev' })).toThrow()
    expect(() =>
      admitDispatcher({ actor: 'CongVC-Dev', triggering: 'CONGVC-DEV', allowed: 'congvc-dev' }),
    ).not.toThrow()
  })
})

describe('time in ICT', () => {
  it('writes UTC+7 with the ICT suffix', () => {
    expect(ictTime(new Date('2026-11-20T17:30:05Z'))).toBe('2026-11-21 00:30:05 ICT')
  })
})

describe('the CLI', () => {
  const dir = () => mkdtempSync(join(tmpdir(), 'lift-'))

  it('refuses when the inputs are missing, writes lift-evidence.json, exits 1', async () => {
    const { spawnSync } = await import('node:child_process')
    const d = dir()
    try {
      const r = spawnSync('node', [join(process.cwd(), 'scripts/deploy-lift.mjs'), 'lift'], {
        cwd: d,
        encoding: 'utf8',
        env: { PATH: process.env.PATH ?? '', GITHUB_STEP_SUMMARY: join(d, 'summary.md') },
      })
      expect(r.status).toBe(1)
      const ev = JSON.parse(readFileSync(join(d, 'lift-evidence.json'), 'utf8'))
      expect(ev.outcome).toBe('refused')
      expect(readFileSync(join(d, 'summary.md'), 'utf8')).toContain('refused')
    } finally {
      rmSync(d, { recursive: true, force: true })
    }
  })

  it('admit exits 1 for a login that is not allowlisted', async () => {
    const { spawnSync } = await import('node:child_process')
    const r = spawnSync('node', [join(process.cwd(), 'scripts/deploy-lift.mjs'), 'admit'], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '', ACTOR: 'mallory', TRIGGER: 'mallory', DISPATCHERS: 'congvc-dev' },
    })
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/dispatcher/)
  })

  it('admit exits 0 for an allowlisted login', async () => {
    const { spawnSync } = await import('node:child_process')
    const r = spawnSync('node', [join(process.cwd(), 'scripts/deploy-lift.mjs'), 'admit'], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '', ACTOR: 'congvc-dev', TRIGGER: 'congvc-dev', DISPATCHERS: 'congvc-dev' },
    })
    expect(r.status).toBe(0)
  })
})

/* The real script, as the workflow runs it, against one local HTTP server standing in for Multica and the app, and a real marker file. */
describe('the CLI end to end (a real process, real HTTP)', () => {
  async function cli(over: { decision?: Decision; marker?: string; health?: number }) {
    const markerDir = mkdtempSync(join(tmpdir(), 'lift-marker-'))
    const markerPath = join(markerDir, 'deploy-marker')
    writeFileSync(markerPath, `${over.marker ?? SUSPENDED}\n`)
    const seen: string[] = []
    const server = createServer((req, res) => {
      const url = req.url ?? ''
      seen.push(`${req.method} ${url}`)
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        const send = (status: number, json: unknown) => {
          res.writeHead(status, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(json))
        }
        if (url === `/api/decisions/${DECISION_ID}/state`) {
          if (req.headers.authorization !== `Bearer ${TOKEN}` || req.headers['x-workspace-id'] !== WORKSPACE)
            return send(403, {})
          return send(200, over.decision ?? decisionOf({ expires_at: new Date(Date.now() + 86_400_000).toISOString() }))
        }
        if (url === '/healthz') return send(over.health ?? 200, { ok: true })
        send(404, {})
      })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as { port: number }).port
    const base = `http://127.0.0.1:${port}`
    const d = mkdtempSync(join(tmpdir(), 'lift-e2e-'))
    try {
      const child = spawn('node', [join(process.cwd(), 'scripts/deploy-lift.mjs'), 'lift'], {
        cwd: d,
        env: {
          PATH: process.env.PATH ?? '',
          C00_MARKER_FILE: markerPath,
          GITHUB_STEP_SUMMARY: join(d, 'summary.md'),
          REPO,
          RUN_ID,
          LIFTER: 'congvc-dev',
          DECISION_ID,
          APPROVER_ID: CHEESE,
          MULTICA_SERVER_URL: base,
          MULTICA_WORKSPACE_ID: WORKSPACE,
          DECISION_READ_TOKEN: TOKEN,
          HEALTHZ_URL: `${base}/healthz`,
          LIFT_QUIESCENT: 'true',
          LIFT_DIGEST: DIGEST,
          LIFT_REVISION: SHA,
          LIFT_CONTAINER_HEALTH: 'healthy',
        },
      })
      let out = ''
      child.stdout.on('data', (c) => (out += c))
      child.stderr.on('data', (c) => (out += c))
      const code = await new Promise<number | null>((r) => child.on('close', r))
      return {
        code,
        out,
        marker: readFileSync(markerPath, 'utf8').trim(),
        seen,
        evidence: JSON.parse(readFileSync(join(d, 'lift-evidence.json'), 'utf8')),
        summary: readFileSync(join(d, 'summary.md'), 'utf8'),
      }
    } finally {
      server.close()
      rmSync(d, { recursive: true, force: true })
      rmSync(markerDir, { recursive: true, force: true })
    }
  }

  it('accepted: exit 0, the marker is a new clear, lift-evidence.json and the run summary say who, what and when', async () => {
    const r = await cli({})
    expect(r.code, r.out).toBe(0)
    expect(r.marker).toMatch(new RegExp(`^clear:[0-9a-f]{32}:${RUN_ID}$`))
    expect(r.evidence).toMatchObject({
      outcome: 'lifted',
      lifter: 'congvc-dev',
      decision_id: DECISION_ID,
      approver_id: CHEESE,
      digest: DIGEST,
      revision: SHA,
      marker_before: SUSPENDED,
      marker_after: r.marker,
      health: { status: 200 },
    })
    expect(r.evidence.started_ict).toMatch(/ ICT$/)
    expect(r.evidence.finished_ict).toMatch(/ ICT$/)
    for (const word of ['congvc-dev', DECISION_ID, CHEESE, DIGEST, SHA, 'ICT']) expect(r.summary).toContain(word)
    expect(r.out).not.toContain(TOKEN)
    expect(r.summary).not.toContain(TOKEN)
  })

  it('refused (decision rejected): exit 1, the marker is untouched, no write was sent, the evidence says why', async () => {
    const r = await cli({ decision: decisionOf({ state: 'rejected' }) })
    expect(r.code).toBe(1)
    expect(r.marker).toBe(SUSPENDED)
    expect(r.seen.filter((s) => s.includes('actions/variables'))).toEqual([])
    expect(r.evidence).toMatchObject({ outcome: 'refused', marker_before: SUSPENDED, marker_after: null })
    expect(r.evidence.reason).toMatch(/not approved/)
  })

  it('accepted: no GitHub token, no variable API call, the evidence names the file, not a repo variable', async () => {
    const r = await cli({})
    expect(r.code, r.out).toBe(0)
    expect(r.seen.some((s) => s.includes('actions/variables'))).toBe(false)
  })

  it('refused (/healthz 503): exit 1, the marker is untouched', async () => {
    const r = await cli({ health: 503 })
    expect(r.code).toBe(1)
    expect(r.marker).toBe(SUSPENDED)
    expect(r.evidence.reason).toMatch(/health/)
  })
})
