import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
// @ts-expect-error plain .mjs script, no types
import { ALLOWED_KEYS, buildPredecessorEnv, checkEnvKeys } from '../scripts/compat-env.mjs'
import {
  LABEL,
  MIGRATE_TIMEOUT_MS,
  checkAppInspect,
  checkNetworkInspect,
  diskOk,
  ledgerHash,
  names,
  networkCreateArgs,
  parseProbeOutput,
  probeScript,
  probeTargets,
  proveQuiescence,
  runCompat,
  sandboxAddress,
  sandboxGateway,
  sandboxTargets,
  verifyEvidence,
  // @ts-expect-error plain .mjs script, no types
} from '../scripts/compat-sandbox.mjs'

/* CHE-5474 S4c, C-8.5b to C-8.5d. The orchestrator runs against a scripted docker, so each test says
   exactly what C00 would answer. The real isolation is proven by tests/compatIsolationDocker.test.ts. */

const SHA = 'c'.repeat(40)
const DIGEST = 'sha256:' + 'a'.repeat(64)
const RUN = 'r1'
const N = names(RUN)
const LEDGER = [{ hash: 'f'.repeat(64), created_at: 1 }]
const SEVEN = [
  'NODE_ENV',
  'PORT',
  'DATABASE_URL',
  'BETTER_AUTH_SECRET',
  'BETTER_AUTH_URL',
  'CHATGPT_CONNECT_DISABLED',
  'DOOP_GEMINI_CLOUD_WORKERS',
]

type Call = { args: string[]; input?: string; timeoutMs?: number }
type Reply = { code: number; stdout?: string; stderr?: string }

const TARGETS = probeTargets({ hostGateway: '10.0.0.1', livePgAddress: '172.20.0.5' })
const SUBNET = '172.30.0.0/24'
const GATEWAY = '172.30.0.1'
const netOf = (over: Record<string, unknown> = {}) => ({
  Name: N.network,
  Internal: true,
  Options: { 'com.docker.network.bridge.inhibit_ipv4': 'true' },
  IPAM: { Config: [{ Subnet: SUBNET }] },
  Containers: { a: { Name: N.db }, b: { Name: N.probe } },
  ...over,
})
const goodNetwork = JSON.stringify([netOf()])
/** The targets the orchestrator put in the probe script: what the sandbox was really asked to reach. */
const scriptTargets = (args: string[]): { id: string; control?: boolean }[] =>
  JSON.parse(/const T=(\[.*?\]);const one/.exec(args.at(-1) ?? '')![1]!)
const answer = (args: string[], reached: (t: { id: string; control?: boolean }) => boolean = (t) => !!t.control) => ({
  code: 0,
  stdout: JSON.stringify(scriptTargets(args).map((t) => ({ id: t.id, reached: reached(t) }))) + '\n',
})
const goodApp = (extra: Record<string, unknown> = {}) =>
  JSON.stringify([
    {
      Name: '/' + N.app,
      Config: { Env: [...SEVEN.map((k) => `${k}=x`), 'PATH=/usr/bin', 'NODE_VERSION=22'] },
      Mounts: [],
      HostConfig: { Privileged: false, ReadonlyRootfs: true, CapDrop: ['ALL'], PortBindings: {} },
      NetworkSettings: { Ports: { '4400/tcp': null }, Networks: { [N.network]: {} } },
      ...extra,
    },
  ])

function rig(
  over: (args: string[], calls: Call[]) => Reply | undefined = () => undefined,
  opts: { sweep?: boolean[] } = {},
) {
  const calls: Call[] = []
  const sweeps = [...(opts.sweep ?? [])]
  const events: string[] = []
  const runner = {
    docker: async (args: string[], o: { input?: string; timeoutMs?: number } = {}): Promise<Reply> => {
      calls.push({ args, input: o.input, timeoutMs: o.timeoutMs })
      events.push('docker ' + args.slice(0, 3).join(' '))
      const hit = over(args, calls)
      if (hit) return hit
      const j = args.join(' ')
      if (j.startsWith('inspect --format {{.Image}}')) return { code: 0, stdout: 'sha256:pgimageid\n' }
      if (j.includes('pg_database_size')) return { code: 0, stdout: '1000\n' }
      if (j.includes('pg_isready')) return { code: 0 }
      if (j.startsWith('inspect --format {{.State.Running}}')) return { code: 0, stdout: 'false\n' }
      if (j.includes('pg_stat_activity') && j.includes('psql')) return { code: 0, stdout: '0 0\n' }
      if (j.startsWith('image inspect'))
        return { code: 0, stdout: JSON.stringify(['PATH=/usr/bin', 'NODE_VERSION=22']) }
      if (j.startsWith('network inspect')) return { code: 0, stdout: goodNetwork }
      if (j.startsWith('inspect') && j.includes(N.app)) return { code: 0, stdout: goodApp() }
      if (j.startsWith('run') && j.includes(N.probe)) return answer(args)
      if (j.startsWith('run') && j.includes(N.smoke))
        return { code: 0, stdout: JSON.stringify({ ok: true, results: [{ group: '/healthz', status: 200 }] }) + '\n' }
      return { code: 0, stdout: '' }
    },
    pipe: async (a: string[], b: string[]) => {
      calls.push({ args: ['PIPE', ...a, '|', ...b] })
      events.push('pipe')
      const hit = over(['PIPE'], calls)
      return hit ?? { code: 0 }
    },
    canary: async () => {
      events.push('canary open')
      return {
        port: 45678,
        close: async () => {
          events.push('canary close')
        },
      }
    },
    freeBytes: async () => 10_000,
    sweep: async () => {
      events.push('sweep')
      const ok = sweeps.length ? sweeps.shift()! : true
      return { ok, message: ok ? 'sweep ok' : 'sweep failed' }
    },
    sleep: async () => {},
    now: () => new Date('2026-11-17T00:00:00Z'),
    randomSecret: () => 'rnd',
  }
  return { runner, calls, events }
}

const input = (runner: unknown, over: Record<string, unknown> = {}) => ({
  runner,
  runId: RUN,
  candidate: { sha: SHA, image: 'ghcr.io/cheese-work/doop@sha256:' + 'b'.repeat(64) },
  predecessor: { digest: DIGEST, image: 'ghcr.io/cheese-work/doop@' + DIGEST },
  liveDb: { container: 'doop-db', user: 'doop', db: 'doop' },
  staticResult: { ok: true },
  ledgerRows: LEDGER,
  probeTargets: TARGETS,
  ...over,
})

const text = (calls: Call[]) => calls.map((c) => c.args.join(' '))
const has = (calls: Call[], re: RegExp) => text(calls).some((l) => re.test(l))

describe('compat sandbox, happy path', () => {
  it('writes evidence naming the candidate, predecessor digest, ledger hash and the three results', async () => {
    const { runner } = rig()
    const ev = await runCompat(input(runner))
    expect(ev).toEqual(
      expect.objectContaining({
        ok: true,
        candidateSha: SHA,
        predecessorDigest: DIGEST,
        ledgerHash: ledgerHash(LEDGER),
        runId: RUN,
      }),
    )
    expect(ev.results.static.ok).toBe(true)
    expect(ev.results.clone.ok).toBe(true)
    expect(ev.results.behavior.ok).toBe(true)
    expect(ev.startedAtIct).toMatch(/ICT$/)
  })

  it('runs in order: sweep, disk guard, internal network, clone, migrate, probes, inspect, boot, smoke, sweep', async () => {
    const { runner, events } = rig()
    await runCompat(input(runner))
    const at = (re: RegExp) => events.findIndex((e) => re.test(e))
    const order = [
      at(/^sweep$/),
      at(/network create/),
      at(/run -d/),
      at(/^pipe$/),
      at(new RegExp('run .*' + N.migrate)) >= 0 ? at(new RegExp('run .*' + N.migrate)) : at(/run --name/),
    ]
    expect(order.every((n) => n >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    expect(events[0]).toBe('sweep')
    expect(events[events.length - 1]).toBe('sweep')
    expect(events.indexOf('docker start doop-compat-app-r1')).toBeGreaterThan(
      events.findIndex((e) => /network inspect/.test(e)),
    )
  })

  it('creates an --internal network and puts the clone database on it alone, from the live image id, with a labelled volume', async () => {
    const { runner, calls } = rig()
    await runCompat(input(runner))
    const net = text(calls).find((l) => l.startsWith('network create'))!
    expect(net).toContain('--internal')
    expect(net).toContain('com.docker.network.bridge.inhibit_ipv4=true')
    expect(net).toContain(`--label ${LABEL}=${RUN}`)
    const db = text(calls).find((l) => l.startsWith('run') && l.includes(N.db))!
    expect(db).toContain('sha256:pgimageid')
    expect(db).toContain(`--network ${N.network}`)
    expect(db).toContain(`--label ${LABEL}=${RUN}`)
    expect(db).toMatch(new RegExp(`-v ${N.volume}:`))
    expect(text(calls).some((l) => l.startsWith('volume create') && l.includes(`${LABEL}=${RUN}`))).toBe(true)
    expect(text(calls).every((l) => !/\bpull\b|\bbuild\b/.test(l))).toBe(true)
  })

  it('never publishes a port, mounts the docker socket or the host, or runs privileged', async () => {
    const { runner, calls } = rig()
    await runCompat(input(runner))
    for (const l of text(calls).filter((x) => x.startsWith('run') || x.startsWith('create'))) {
      expect(l).not.toMatch(/(^| )(-p|--publish|-P)( |$)/)
      expect(l).not.toContain('docker.sock')
      expect(l).not.toContain('--privileged')
      expect(l).not.toMatch(/--network host|--network bridge/)
      expect(l).toContain(`--label ${LABEL}=${RUN}`)
    }
  })

  it('starts the predecessor with only the allowlisted env, no mounts, cap-drop ALL, read-only, tmpfs /tmp', async () => {
    const { runner, calls } = rig()
    await runCompat(input(runner))
    const create = calls.find((c) => c.args[0] === 'create' && c.args.includes(N.app))!
    const j = create.args.join(' ')
    expect(j).toContain('--cap-drop ALL')
    expect(j).toContain('--read-only')
    expect(j).toContain('--tmpfs /tmp')
    expect(j).toContain(`--network ${N.network}`)
    expect(j).not.toMatch(/ -v |--mount/)
    const keys = create.args.flatMap((a, i) => (create.args[i - 1] === '-e' ? [a.split('=')[0]] : []))
    expect(keys.sort()).toEqual([...SEVEN].sort())
    expect(j).toContain('CHATGPT_CONNECT_DISABLED=1')
    expect(j).toContain('DOOP_GEMINI_CLOUD_WORKERS=0')
    expect(j).toContain('BETTER_AUTH_URL=http://localhost')
    expect(j).toContain('NODE_ENV=production')
    expect(j).toContain(`@${N.db}:5432`) // the sandbox database, never the live one
    expect(j).not.toContain('doop-db')
  })

  it('runs the contract smoke suite from the candidate image on the sandbox network against the predecessor', async () => {
    const { runner, calls } = rig()
    await runCompat(input(runner))
    const smoke = text(calls).find((l) => l.startsWith('run') && l.includes(N.smoke))!
    expect(smoke).toContain('ghcr.io/cheese-work/doop@sha256:' + 'b'.repeat(64))
    expect(smoke).toContain(`--network ${N.network}`)
    expect(smoke).toContain('scripts/deploy-smoke.mjs')
    expect(smoke).toContain(`SMOKE_BASE_URL=http://${N.app}:4400`)
  })

  it('probes TCP to 1.1.1.1:443, the host gateway, the live Postgres and DNS for api.github.com', () => {
    const ids = probeTargets({ hostGateway: '10.0.0.1', livePgAddress: '172.20.0.5' }).map((t: { id: string }) => t.id)
    expect(ids).toEqual(['tcp:1.1.1.1:443', 'tcp:10.0.0.1:443', 'tcp:172.20.0.5:5432', 'dns:api.github.com'])
    expect(probeScript(TARGETS)).toContain('1.1.1.1')
  })
})

describe('compat sandbox, the sandbox network gateway is probed with a positive control', () => {
  const probeCall = (calls: Call[]) => calls.find((c) => c.args[0] === 'run' && c.args.includes(N.probe))!

  it('aims at the sandbox gateway on several ports and at a host canary, with the clone database as control', async () => {
    const { runner, calls } = rig()
    await runCompat(input(runner))
    const ids = scriptTargets(probeCall(calls).args).map((t) => t.id)
    for (const port of [22, 53, 80, 443, 2375, 5432]) expect(ids).toContain(`tcp:${GATEWAY}:${port}`)
    expect(ids).toContain(`tcp:${GATEWAY}:45678`)
    expect(ids).toContain(`control:${N.db}:5432`)
    expect(ids).toEqual(expect.arrayContaining(['tcp:1.1.1.1:443', 'tcp:10.0.0.1:443', 'dns:api.github.com']))
    expect(scriptTargets(probeCall(calls).args).filter((t) => t.control)).toHaveLength(1)
  })

  it('opens the canary for the probe only, and closes it before anything else runs', async () => {
    const { runner, events } = rig()
    await runCompat(input(runner))
    const open = events.indexOf('canary open')
    const close = events.indexOf('canary close')
    expect(open).toBeGreaterThan(-1)
    expect(events.slice(open + 1, close).filter((e) => e.startsWith('docker'))).toEqual([
      'docker run --name doop-compat-probe-r1',
    ])
  })

  it('closes the canary when the probe cannot run', async () => {
    const { runner, events } = rig((a) =>
      a[0] === 'run' && a.includes(N.probe) ? { code: 125, stderr: 'no image' } : undefined,
    )
    await runCompat(input(runner))
    expect(events).toContain('canary close')
  })

  it.each([22, 53, 80, 443, 2375, 5432, 45678])(
    'a sandbox gateway that answers on port %s blocks boot',
    async (port) => {
      const { runner, calls } = rig((a) =>
        a[0] === 'run' && a.includes(N.probe)
          ? answer(a, (t) => !!t.control || t.id === `tcp:${GATEWAY}:${port}`)
          : undefined,
      )
      const ev = await runCompat(input(runner))
      expect(ev.ok).toBe(false)
      expect(ev.failed.part).toBe('behavior')
      expect(ev.failed.reason).toContain(`tcp:${GATEWAY}:${port}`)
      expect(has(calls, /^start /)).toBe(false)
    },
  )

  it('a probe that cannot reach its control fails closed, even when nothing else answered', async () => {
    const { runner, calls } = rig((a) => (a[0] === 'run' && a.includes(N.probe) ? answer(a, () => false) : undefined))
    const ev = await runCompat(input(runner))
    expect(ev.ok).toBe(false)
    expect(ev.failed.reason).toMatch(/control/)
    expect(has(calls, /^start /)).toBe(false)
  })

  it('a network with no readable subnet cannot be probed, so nothing starts on it', async () => {
    const { runner, calls } = rig((a) =>
      a.join(' ').startsWith('network inspect')
        ? { code: 0, stdout: JSON.stringify([netOf({ IPAM: { Config: [] } })]) }
        : undefined,
    )
    const ev = await runCompat(input(runner))
    expect(ev.ok).toBe(false)
    expect(ev.failed.reason).toMatch(/subnet/)
    expect(has(calls, /^run /)).toBe(false)
  })

  it('gives every container on the sandbox an explicit address, so none takes the would-be gateway', async () => {
    const { runner, calls } = rig()
    await runCompat(input(runner))
    const mine = calls.filter((c) => ['run', 'create'].includes(c.args[0]!) && c.args.includes('--network'))
    expect(mine).toHaveLength(5)
    const ips = mine.map((c) => c.args[c.args.indexOf('--ip') + 1])
    expect(ips.every((x) => /^172\.30\.0\.\d+$/.test(String(x)))).toBe(true)
    expect(new Set(ips).size).toBe(5)
    expect(ips).not.toContain(GATEWAY)
  })

  it('a container found on the gateway address blocks boot, whatever put it there', async () => {
    const holder = netOf({ Containers: { a: { Name: N.db, IPv4Address: `${GATEWAY}/24` } } })
    expect(checkNetworkInspect([holder], [N.db]).reason).toMatch(/holds the gateway address/)
    const { runner, calls } = rig((a, seen) =>
      a.join(' ').startsWith('network inspect') && has(seen, /run --name doop-compat-probe/)
        ? { code: 0, stdout: JSON.stringify([holder]) }
        : undefined,
    )
    const ev = await runCompat(input(runner))
    expect(ev.ok).toBe(false)
    expect(ev.failed.reason).toMatch(/holds the gateway address/)
    expect(has(calls, /^start /)).toBe(false)
  })

  it('uses the gateway Docker reports, else the first host of the subnet', () => {
    expect(sandboxGateway([netOf()])).toBe('172.30.0.1')
    expect(sandboxGateway([netOf({ IPAM: { Config: [{ Subnet: '10.5.7.9/16' }] } })])).toBe('10.5.0.1')
    expect(sandboxGateway([netOf({ IPAM: { Config: [{ Subnet: '172.18.0.0/16', Gateway: '172.18.0.254' }] } })])).toBe(
      '172.18.0.254',
    )
    expect(sandboxGateway([netOf({ IPAM: { Config: [{ Subnet: 'fd00::/64' }] } })])).toBeUndefined()
    expect(sandboxGateway(undefined)).toBeUndefined()
    expect(sandboxAddress([netOf()], 0)).toBe('172.30.0.10')
    expect(sandboxAddress([netOf()], 4)).toBe('172.30.0.14')
    expect(sandboxAddress([netOf({ IPAM: { Config: [{ Subnet: '10.0.0.0/28' }] } })], 0)).toBeUndefined()
  })

  it('builds sandbox targets: the base list, the gateway ports, the canary, one control', () => {
    const t = sandboxTargets({ base: TARGETS, gateway: GATEWAY, canaryPort: 1234, controlHost: 'db' })
    expect(t.map((x: { id: string }) => x.id)).toEqual([
      ...TARGETS.map((x: { id: string }) => x.id),
      ...[22, 53, 80, 443, 2375, 5432].map((p) => `tcp:${GATEWAY}:${p}`),
      `tcp:${GATEWAY}:1234`,
      'control:db:5432',
    ])
    expect(t.filter((x: { control?: boolean }) => x.control)).toHaveLength(1)
  })

  it('creates the network with inhibit_ipv4, which is what removes the host-side gateway', () => {
    const args = networkCreateArgs(N.network, ['--label', `${LABEL}=${RUN}`])
    expect(args.slice(0, 2)).toEqual(['network', 'create'])
    expect(args).toEqual(expect.arrayContaining(['--internal', '-o', 'com.docker.network.bridge.inhibit_ipv4=true']))
    expect(args.at(-1)).toBe(N.network)
  })
})

describe('compat sandbox, the clone migration is supervised and proven quiescent (C-8.8)', () => {
  const isMigrate = (a: string[]) => a[0] === 'run' && a.includes(N.migrate)
  const isQuiesceSql = (a: string[]) =>
    a.join(' ').includes('pg_stat_activity') && !a.join(' ').includes('pg_terminate_backend')
  const noStart = (calls: Call[]) => !has(calls, /^start /)

  it('runs the migration under a 120 s external timeout, with the runner deadline inside it', async () => {
    const { runner, calls } = rig()
    await runCompat(input(runner))
    const mig = calls.find((c) => isMigrate(c.args))!
    expect(MIGRATE_TIMEOUT_MS).toBe(120_000)
    expect(mig.timeoutMs).toBe(120_000)
    const deadline = Number(/DOOP_MIGRATE_DEADLINE_SECONDS=(\d+)/.exec(mig.args.join(' '))![1])
    expect(deadline).toBeGreaterThan(0)
    expect(deadline).toBeLessThan(120)
  })

  it('proves quiescence on success and records it in the evidence', async () => {
    const { runner, calls } = rig()
    const ev = await runCompat(input(runner))
    expect(ev.results.clone).toEqual({
      ok: true,
      quiescence: { ok: true, containerExited: true, sessions: 0, advisoryLocks: 0 },
    })
    const sql = text(calls).find((l) => l.includes('pg_stat_activity'))!
    expect(sql).toContain(`application_name='${N.migrate}'`)
    expect(sql).toContain('pg_locks')
    expect(sql).toContain('1685025648')
    expect(sql).toContain(`exec ${N.db} psql`)
  })

  it('a hung migration is killed, waited on and proven quiescent, then stops the run before boot', async () => {
    const { runner, calls } = rig((a) => (isMigrate(a) ? ({ code: 124, timedOut: true } as never) : undefined))
    const ev = await runCompat(input(runner))
    expect(ev.ok).toBe(false)
    expect(ev.failed.part).toBe('clone')
    expect(ev.failed.reason).toMatch(/exceeded 120 s and was killed/)
    expect(ev.failed.reason).toMatch(/quiescence proven/)
    const l = text(calls)
    const killAt = l.indexOf(`kill ${N.migrate}`)
    expect(killAt).toBeGreaterThan(-1)
    expect(l.findIndex((x) => x.startsWith('inspect --format {{.State.Running}}'))).toBeGreaterThan(killAt)
    expect(l.findIndex((x) => x.includes('pg_stat_activity'))).toBeGreaterThan(killAt)
    expect(ev.results.clone.quiescence.ok).toBe(true)
    expect(noStart(calls)).toBe(true)
    expect(has(calls, /run --name doop-compat-probe/)).toBe(false)
  })

  it('a hung migration whose session lingers is terminated, and quiescence is re-checked', async () => {
    let reads = 0
    const { runner, calls } = rig((a) => {
      if (isMigrate(a)) return { code: 124, timedOut: true } as never
      if (isQuiesceSql(a)) return { code: 0, stdout: ++reads === 1 ? '1 1\n' : '0 0\n' }
      return undefined
    })
    const ev = await runCompat(input(runner))
    expect(has(calls, /pg_terminate_backend/)).toBe(true)
    expect(reads).toBe(2)
    expect(ev.ok).toBe(false)
    expect(ev.failed.reason).toMatch(/quiescence proven/)
    expect(ev.results.clone.quiescence).toEqual(expect.objectContaining({ ok: true, sessions: 0, advisoryLocks: 0 }))
  })

  it.each([
    [
      'a session of the run is still open',
      (a: string[]) => (isQuiesceSql(a) ? { code: 0, stdout: '2 0\n' } : undefined),
    ],
    ['the advisory lock is still held', (a: string[]) => (isQuiesceSql(a) ? { code: 0, stdout: '0 1\n' } : undefined)],
    [
      'the container is still running',
      (a: string[]) =>
        a.join(' ').startsWith('inspect --format {{.State.Running}}') ? { code: 0, stdout: 'true\n' } : undefined,
    ],
    [
      'the quiescence query fails',
      (a: string[]) => (isQuiesceSql(a) ? { code: 1, stderr: 'connection refused' } : undefined),
    ],
    [
      'the quiescence query answers nonsense',
      (a: string[]) => (isQuiesceSql(a) ? { code: 0, stdout: 'maybe\n' } : undefined),
    ],
  ])('failed quiescence (%s) after a hung migration is needs_operator', async (_name, extra) => {
    const { runner, calls } = rig((a) => (isMigrate(a) ? ({ code: 124, timedOut: true } as never) : extra(a)))
    const ev = await runCompat(input(runner))
    expect(ev.ok).toBe(false)
    expect(ev.failed.part).toBe('clone')
    expect(ev.failed.reason).toContain('needs_operator')
    expect(ev.results.clone.quiescence.ok).toBe(false)
    expect(noStart(calls)).toBe(true)
  })

  it('a migration that exits 0 but leaves the lock held is needs_operator, not a pass', async () => {
    const { runner, calls } = rig((a) => (isQuiesceSql(a) ? { code: 0, stdout: '0 1\n' } : undefined))
    const ev = await runCompat(input(runner))
    expect(ev.ok).toBe(false)
    expect(ev.failed.reason).toContain('needs_operator')
    expect(ev.results.clone.ok).toBe(false)
    expect(noStart(calls)).toBe(true)
  })

  it('a migration that fails fast is killed by name and proven quiescent before the run stops', async () => {
    const { runner, calls } = rig((a) => (isMigrate(a) ? { code: 1, stderr: 'deadline exceeded' } : undefined))
    const ev = await runCompat(input(runner))
    expect(ev.ok).toBe(false)
    expect(ev.failed.reason).toMatch(/migration on the cloned data failed/)
    expect(has(calls, new RegExp(`^kill ${N.migrate}`))).toBe(true)
    expect(ev.results.clone.quiescence).toEqual(expect.objectContaining({ ok: true }))
  })

  it('proveQuiescence reports each fact it read', async () => {
    const { runner } = rig((a) => (isQuiesceSql(a) ? { code: 0, stdout: '3 1\n' } : undefined))
    const q = await proveQuiescence({
      runner,
      containerName: N.migrate,
      dbName: N.db,
      liveDb: { user: 'doop', db: 'doop' },
    })
    expect(q).toEqual(expect.objectContaining({ ok: false, containerExited: true, sessions: 3, advisoryLocks: 1 }))
  })
})

describe('compat sandbox, insufficient evidence takes the forward-only path', () => {
  it('a static diff that is insufficient stops before any sandbox exists', async () => {
    const { runner, calls } = rig()
    const ev = await runCompat(input(runner, { staticResult: { ok: false, reason: 'column type changed' } }))
    expect(ev.ok).toBe(false)
    expect(ev.failed).toEqual(expect.objectContaining({ part: 'static' }))
    expect(has(calls, /network create/)).toBe(false)
  })

  it('a missing static result is insufficient', async () => {
    const { runner } = rig()
    const ev = await runCompat(input(runner, { staticResult: undefined }))
    expect(ev.ok).toBe(false)
    expect(ev.failed.part).toBe('static')
  })

  it('low disk (free < 3x the live database) is insufficient and nothing is cloned', async () => {
    const { runner, calls } = rig((a) =>
      a.join(' ').includes('pg_database_size') ? { code: 0, stdout: '4000\n' } : undefined,
    )
    const ev = await runCompat(input(runner))
    expect(ev.ok).toBe(false)
    expect(ev.failed).toEqual(expect.objectContaining({ part: 'clone' }))
    expect(ev.failed.reason).toMatch(/disk/)
    expect(has(calls, /network create/)).toBe(false)
    expect(diskOk({ freeBytes: 3000, dbBytes: 1000 }).ok).toBe(true)
    expect(diskOk({ freeBytes: 2999, dbBytes: 1000 }).ok).toBe(false)
    expect(diskOk({ freeBytes: Number.NaN, dbBytes: 1000 }).ok).toBe(false)
    expect(diskOk({ freeBytes: 9, dbBytes: Number.NaN }).ok).toBe(false)
  })

  it('records df before and after in the evidence', async () => {
    const { runner } = rig()
    const ev = await runCompat(input(runner))
    expect(ev.disk).toEqual({ beforeBytes: 10_000, afterBytes: 10_000 })
  })

  it('a pg_dump to pg_restore stream that fails is insufficient', async () => {
    const { runner } = rig((a) => (a[0] === 'PIPE' ? { code: 1, stderr: 'pg_restore: error' } : undefined))
    const ev = await runCompat(input(runner))
    expect(ev.ok).toBe(false)
    expect(ev.failed.part).toBe('clone')
    expect(ev.results.behavior.ok).toBe(false)
  })

  it('a migration that fails on the existing data is insufficient, and the predecessor never starts', async () => {
    const { runner, calls } = rig((a) =>
      a[0] === 'run' && a.includes(N.migrate) ? { code: 1, stderr: 'migrate failed: null value in column' } : undefined,
    )
    const ev = await runCompat(input(runner))
    expect(ev.ok).toBe(false)
    expect(ev.failed).toEqual(expect.objectContaining({ part: 'clone' }))
    expect(has(calls, /^start /)).toBe(false)
  })

  it('runs the migration once, in a one-shot candidate container, connected to the sandbox only', async () => {
    const { runner, calls } = rig()
    await runCompat(input(runner))
    const mig = text(calls).find((l) => l.startsWith('run') && l.includes(N.migrate))!
    expect(mig).toContain('server/db/migrate.ts')
    expect(mig).toContain('DOOP_MIGRATE_APP_NAME=' + N.migrate)
    expect(mig).toContain(`@${N.db}:5432`)
    expect(mig).toContain(`--network ${N.network}`)
    expect(mig).not.toContain('doop-db')
  })

  it('predecessor health or a smoke call failing on the clone is insufficient', async () => {
    const { runner } = rig((a) =>
      a[0] === 'run' && a.includes(N.smoke)
        ? {
            code: 1,
            stdout: JSON.stringify({ ok: false, failed: [{ group: '/api/canvases', kind: 'write', status: 500 }] }),
          }
        : undefined,
    )
    const ev = await runCompat(input(runner))
    expect(ev.ok).toBe(false)
    expect(ev.failed.part).toBe('behavior')
    expect(ev.failed.reason).toMatch(/smoke/)
  })

  it('smoke output that cannot be read is insufficient', async () => {
    const { runner } = rig((a) => (a[0] === 'run' && a.includes(N.smoke) ? { code: 0, stdout: 'not json' } : undefined))
    const ev = await runCompat(input(runner))
    expect(ev.ok).toBe(false)
    expect(ev.failed.part).toBe('behavior')
  })
})

describe('compat sandbox, isolation probes block startup', () => {
  const noStart = (calls: Call[]) => !has(calls, /^start /)

  it('a probe that reaches an external address blocks startup', async () => {
    const { runner, calls } = rig((a) =>
      a[0] === 'run' && a.includes(N.probe) ? answer(a, (t) => !!t.control || t.id === 'tcp:1.1.1.1:443') : undefined,
    )
    const ev = await runCompat(input(runner))
    expect(ev.ok).toBe(false)
    expect(ev.failed.part).toBe('behavior')
    expect(ev.failed.reason).toContain('tcp:1.1.1.1:443')
    expect(noStart(calls)).toBe(true)
  })

  it.each(['tcp:10.0.0.1:443', 'tcp:172.20.0.5:5432', 'dns:api.github.com'])(
    'reaching %s blocks startup',
    async (id) => {
      const { runner, calls } = rig((a) =>
        a[0] === 'run' && a.includes(N.probe) ? answer(a, (t) => !!t.control || t.id === id) : undefined,
      )
      const ev = await runCompat(input(runner))
      expect(ev.ok).toBe(false)
      expect(noStart(calls)).toBe(true)
    },
  )

  it('a probe that cannot run blocks startup', async () => {
    const { runner, calls } = rig((a) =>
      a[0] === 'run' && a.includes(N.probe) ? { code: 125, stderr: 'no such image' } : undefined,
    )
    const ev = await runCompat(input(runner))
    expect(ev.ok).toBe(false)
    expect(noStart(calls)).toBe(true)
  })

  it('a probe that leaves a target unanswered blocks startup', async () => {
    const { runner, calls } = rig((a) =>
      a[0] === 'run' && a.includes(N.probe)
        ? { code: 0, stdout: JSON.stringify([{ id: 'tcp:1.1.1.1:443', reached: false }]) }
        : undefined,
    )
    const ev = await runCompat(input(runner))
    expect(ev.ok).toBe(false)
    expect(noStart(calls)).toBe(true)
  })

  it('a network that is not Internal, or holds a foreign container, blocks startup', async () => {
    for (const net of [
      [netOf({ Internal: false })],
      [netOf({ Containers: { a: { Name: N.db }, b: { Name: 'doop' } } })],
      [netOf({ Options: {} })],
      [netOf({ IPAM: { Config: [{ Subnet: SUBNET, Gateway: GATEWAY }] } })],
    ]) {
      const { runner, calls } = rig((a) =>
        a.join(' ').startsWith('network inspect') ? { code: 0, stdout: JSON.stringify(net) } : undefined,
      )
      const ev = await runCompat(input(runner))
      expect(ev.ok).toBe(false)
      expect(noStart(calls)).toBe(true)
    }
  })

  it('a predecessor whose inspect shows a foreign env key, a mount or a published port blocks startup', async () => {
    const bad = [
      { Config: { Env: [...SEVEN.map((k) => `${k}=x`), 'STRIPE_SECRET_KEY=sk'] } },
      { Mounts: [{ Source: '/srv/doop/.env', Destination: '/app/.env' }] },
      {
        HostConfig: {
          Privileged: false,
          ReadonlyRootfs: true,
          CapDrop: ['ALL'],
          PortBindings: { '4400/tcp': [{ HostPort: '4400' }] },
        },
      },
      { NetworkSettings: { Ports: {}, Networks: { [N.network]: {}, bridge: {} } } },
    ]
    for (const extra of bad) {
      const { runner, calls } = rig((a) =>
        a[0] === 'inspect' && a.includes(N.app) ? { code: 0, stdout: goodApp(extra) } : undefined,
      )
      const ev = await runCompat(input(runner))
      expect(ev.ok, JSON.stringify(extra)).toBe(false)
      expect(noStart(calls)).toBe(true)
    }
  })
})

describe('compat sandbox, sweep and cleanup', () => {
  it('sweeps first and again at the end, after success', async () => {
    const { runner, events } = rig()
    await runCompat(input(runner))
    expect(events.filter((e) => e === 'sweep')).toHaveLength(2)
    expect(events[0]).toBe('sweep')
    expect(events.at(-1)).toBe('sweep')
  })

  it('sweeps at the end after a failure too, so the scratch database is dropped', async () => {
    const { runner, events } = rig((a) =>
      a[0] === 'run' && a.includes(N.smoke) ? { code: 1, stdout: '{}' } : undefined,
    )
    const ev = await runCompat(input(runner))
    expect(ev.ok).toBe(false)
    expect(events.at(-1)).toBe('sweep')
  })

  it('sweeps at the end when an unexpected error escapes, and rethrows it', async () => {
    const { runner, events } = rig((a) => {
      if (a.join(' ').startsWith('network create')) throw new Error('daemon gone')
      return undefined
    })
    await expect(runCompat(input(runner))).rejects.toThrow(/daemon gone/)
    expect(events.at(-1)).toBe('sweep')
  })

  it('a failed first sweep fails the job before any other step', async () => {
    const { runner, calls } = rig(undefined, { sweep: [false] })
    await expect(runCompat(input(runner))).rejects.toThrow(/sweep/)
    expect(calls).toHaveLength(0)
  })

  it('a failed final sweep makes the evidence not ok', async () => {
    const { runner } = rig(undefined, { sweep: [true, false] })
    const ev = await runCompat(input(runner))
    expect(ev.ok).toBe(false)
    expect(ev.failed.part).toBe('cleanup')
  })

  it('refuses a run id that is not a plain token', async () => {
    const { runner, calls } = rig()
    await expect(runCompat(input(runner, { runId: 'x; rm -rf /' }))).rejects.toThrow(/run id/)
    expect(calls).toHaveLength(0)
  })
})

describe('evidence at deploy step 1', () => {
  const good = async () => runCompat(input(rig().runner))
  const expected = { candidateSha: SHA, predecessorDigest: DIGEST, ledgerHash: ledgerHash(LEDGER) }

  it('accepts evidence for the current candidate, predecessor digest and ledger hash', async () => {
    expect(verifyEvidence(await good(), expected)).toEqual({ ok: true })
  })

  it('refuses evidence for another predecessor digest', async () => {
    const r = verifyEvidence(await good(), { ...expected, predecessorDigest: 'sha256:' + 'd'.repeat(64) })
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/predecessor/)
  })

  it('refuses evidence for another ledger hash', async () => {
    const r = verifyEvidence(await good(), {
      ...expected,
      ledgerHash: ledgerHash([{ hash: 'e'.repeat(64), created_at: 2 }]),
    })
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/ledger/)
  })

  it('refuses evidence for another candidate sha', async () => {
    expect(verifyEvidence(await good(), { ...expected, candidateSha: 'd'.repeat(40) }).ok).toBe(false)
  })

  it('refuses failed, partial, missing and unreadable evidence', async () => {
    const ev = await good()
    expect(verifyEvidence({ ...ev, ok: false }, expected).ok).toBe(false)
    expect(verifyEvidence({ ...ev, results: { ...ev.results, behavior: { ok: false } } }, expected).ok).toBe(false)
    expect(
      verifyEvidence({ ...ev, results: { static: ev.results.static, clone: ev.results.clone } }, expected).ok,
    ).toBe(false)
    expect(verifyEvidence({ ...ev, cleanup: { ok: false } }, expected).ok).toBe(false)
    expect(verifyEvidence(undefined, expected).ok).toBe(false)
    expect(verifyEvidence('{bad', expected).ok).toBe(false)
    expect(verifyEvidence(ev, { ...expected, ledgerHash: undefined }).ok).toBe(false)
  })

  it('hashes the ledger by content, so a changed or reordered ledger changes the hash', () => {
    const a = { hash: '1'.repeat(64), created_at: 1 }
    const b = { hash: '2'.repeat(64), created_at: 2 }
    expect(ledgerHash([a, b])).toMatch(/^[0-9a-f]{64}$/)
    expect(ledgerHash([a, b])).toBe(ledgerHash([{ created_at: 1, hash: a.hash }, b]))
    expect(ledgerHash([a, b])).not.toBe(ledgerHash([a]))
    expect(ledgerHash([a, b])).not.toBe(ledgerHash([a, { ...b, created_at: 3 }]))
  })
})

describe('inspect and probe checks', () => {
  it('accepts a sandbox network and predecessor as built', () => {
    expect(checkNetworkInspect(JSON.parse(goodNetwork), [N.db, N.probe, N.app]).ok).toBe(true)
    expect(checkAppInspect(JSON.parse(goodApp()), N.network, ['PATH', 'NODE_VERSION']).ok).toBe(true)
  })

  it('reads a probe result only when every target answers', () => {
    const ok = JSON.stringify(TARGETS.map((t: { id: string }) => ({ id: t.id, reached: false })))
    expect(parseProbeOutput(ok, TARGETS).ok).toBe(true)
    const withControl = [...TARGETS, { id: 'control:db:5432', kind: 'tcp', host: 'db', port: 5432, control: true }]
    const rows = (control: boolean) =>
      JSON.stringify(withControl.map((t) => ({ id: t.id, reached: t.id.startsWith('control') && control })))
    expect(parseProbeOutput(rows(true), withControl).ok).toBe(true)
    expect(parseProbeOutput(rows(false), withControl).reason).toMatch(/control/)
    expect(parseProbeOutput('', TARGETS).ok).toBe(false)
    expect(parseProbeOutput('{}', TARGETS).ok).toBe(false)
  })
})

describe('predecessor env allowlist', () => {
  it('holds exactly the seven keys the plan lists', () => {
    expect([...ALLOWED_KEYS].sort()).toEqual([...SEVEN].sort())
  })

  it('builds the predecessor env from the allowlist with a random auth secret each time', () => {
    const a = buildPredecessorEnv({ databaseUrl: 'postgres://u:p@db:5432/d' })
    const b = buildPredecessorEnv({ databaseUrl: 'postgres://u:p@db:5432/d' })
    expect(Object.keys(a).sort()).toEqual([...SEVEN].sort())
    expect(a.BETTER_AUTH_SECRET).toMatch(/^[0-9a-f]{64}$/)
    expect(a.BETTER_AUTH_SECRET).not.toBe(b.BETTER_AUTH_SECRET)
    expect(a).toEqual(
      expect.objectContaining({
        NODE_ENV: 'production',
        BETTER_AUTH_URL: 'http://localhost',
        CHATGPT_CONNECT_DISABLED: '1',
        DOOP_GEMINI_CLOUD_WORKERS: '0',
      }),
    )
  })

  it('never copies a production key, whatever the host env holds', () => {
    process.env.STRIPE_SECRET_KEY = 'sk_live_x'
    try {
      expect(Object.keys(buildPredecessorEnv({ databaseUrl: 'postgres://x' }))).not.toContain('STRIPE_SECRET_KEY')
    } finally {
      delete process.env.STRIPE_SECRET_KEY
    }
  })

  it('every other key in server/env.ts is absent from the allowlist (a production env key added to it fails CI)', () => {
    const src = readFileSync('server/env.ts', 'utf8')
    const keys = [...src.matchAll(/^ {2}([A-Z][A-Z0-9_]+):/gm)].map((m) => String(m[1]))
    expect(keys.length).toBeGreaterThan(40)
    const forbidden =
      /OIDC|SOCIAL|GOOGLE|APPLE|SMTP|MAIL|OPENAI|ANTHROPIC|OPENROUTER|GEMINI_API|API_KEY|STRIPE|BUCKET|S3_|LINEAR|SLACK|GITHUB|APNS|POSTHOG|META_|PEXELS|BRANDFETCH|WEBHOOK|ADMIN/
    for (const k of keys) {
      if (SEVEN.includes(k)) continue
      expect(ALLOWED_KEYS, k).not.toContain(k)
    }
    for (const k of ALLOWED_KEYS) {
      expect(keys, `${k} must be a declared server key`).toContain(k)
      if (k !== 'BETTER_AUTH_SECRET') expect(k).not.toMatch(forbidden)
    }
  })

  it('refuses a key outside the allowlist, in `docker inspect` form too', () => {
    expect(checkEnvKeys(SEVEN).ok).toBe(true)
    expect(checkEnvKeys(['STRIPE_SECRET_KEY', ...SEVEN])).toEqual(
      expect.objectContaining({ ok: false, extra: ['STRIPE_SECRET_KEY'] }),
    )
    expect(checkEnvKeys(SEVEN.slice(1)).ok).toBe(false) // a missing key is as unknown as an extra one
  })
})
