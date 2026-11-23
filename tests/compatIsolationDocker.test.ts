import { spawnSync } from 'node:child_process'
import { createServer, type Server } from 'node:net'
import { randomBytes } from 'node:crypto'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  LABEL,
  networkCreateArgs,
  parseProbeOutput,
  probeScript,
  probeTargets,
  sandboxAddress,
  sandboxGateway,
  sandboxTargets,
  // @ts-expect-error plain .mjs script, no types
} from '../scripts/compat-sandbox.mjs'

/* Sandbox isolation with real Docker (CHE-5474 C-8.5c): a CI fixture for a hosted runner. It uses the same
   probe script the compat job runs, on an `--internal` network, against a "live" Postgres on another network. */
const docker = (...args: string[]) => spawnSync('docker', args, { encoding: 'utf8' })
const haveDocker = docker('info', '--format', '{{.ServerVersion}}').status === 0
const IMAGE = 'node:22-slim'
const RUN = 'fx' + randomBytes(3).toString('hex')
const L = ['--label', `${LABEL}=${RUN}`]
const net = (n: string) => `doop-compat-${RUN}-${n}`
const slot = (n: number) => sandboxAddress(JSON.parse(sh(['network', 'inspect', net('sandbox')])), n) as string
const ctr = (n: string) => `doop-compat-${RUN}-c-${n}`
const SINK = `require('net').createServer(c=>c.end()).listen(5432,'0.0.0.0');setInterval(()=>{},1e6)`

function sh(args: string[]) {
  const r = docker(...args)
  if (r.status !== 0) throw new Error(`docker ${args.join(' ')}: ${r.stderr}`)
  return r.stdout.trim()
}
function addr(container: string, network: string) {
  return sh(['inspect', '-f', `{{(index .NetworkSettings.Networks "${network}").IPAddress}}`, container])
}
function waitListening(container: string) {
  for (let i = 0; i < 40; i++) {
    if (
      docker(
        'exec',
        container,
        'node',
        '-e',
        "require('net').connect(5432,'127.0.0.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))",
      ).status === 0
    )
      return
    spawnSync('sleep', ['0.5'])
  }
  throw new Error(`${container} is not listening`)
}
function listenOnEveryInterface(): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((ok, fail) => {
    const server: Server = createServer((c) => c.destroy())
    server.on('error', fail)
    server.listen(0, '0.0.0.0', () => {
      const a = server.address()
      ok({ port: typeof a === 'object' && a ? a.port : 0, close: () => new Promise((r) => server.close(() => r())) })
    })
  })
}
/** Probe from a fixed address: an unaddressed container would take the network's would-be gateway. */
function probe(network: string, targets: unknown[], extra: string[] = []) {
  const r = docker(
    'run',
    '--rm',
    ...L,
    '--network',
    network,
    '--cap-drop',
    'ALL',
    '--read-only',
    '--entrypoint',
    'node',
    ...extra,
    IMAGE,
    '-e',
    probeScript(targets),
  )
  return r
}

describe.skipIf(!haveDocker)('sandbox isolation (docker)', () => {
  let liveIp = ''
  let sandboxSinkIp = ''
  let gateway = ''
  let targets: { id: string }[] = []

  beforeAll(() => {
    docker('pull', '-q', IMAGE)
    sh(networkCreateArgs(net('sandbox'), L))
    sh(['network', 'create', ...L, net('open')])
    sh(['network', 'create', ...L, net('live')])
    sh(['run', '-d', '--name', ctr('live'), ...L, '--network', net('live'), '--entrypoint', 'node', IMAGE, '-e', SINK])
    sh([
      'run',
      '-d',
      '--name',
      ctr('sink'),
      ...L,
      '--network',
      net('sandbox'),
      '--ip',
      slot(0),
      '--entrypoint',
      'node',
      IMAGE,
      '-e',
      SINK,
    ])
    waitListening(ctr('live'))
    waitListening(ctr('sink'))
    liveIp = addr(ctr('live'), net('live'))
    sandboxSinkIp = addr(ctr('sink'), net('sandbox'))
    gateway = sh(['network', 'inspect', 'bridge', '--format', '{{range .IPAM.Config}}{{.Gateway}}{{end}}'])
    targets = probeTargets({ hostGateway: gateway, livePgAddress: liveIp })
  }, 180_000)

  afterAll(() => {
    // the real sweep, so the fixture also proves it leaves nothing behind
    const r = spawnSync('bash', [resolve('deploy/cd/c00.sh'), 'sweep'], {
      encoding: 'utf8',
      env: { ...process.env, C00_DF_PATH: '/' },
    })
    expect(r.status, r.stderr).toBe(0)
  })

  it('a container on the internal network cannot reach an external address, the host gateway, a live Postgres on another network, or resolve external DNS', () => {
    const r = probe(net('sandbox'), targets, ['--ip', slot(2)])
    expect(r.status, r.stderr).toBe(0)
    expect(parseProbeOutput(r.stdout, targets)).toEqual({ ok: true })
  }, 120_000)

  it('the probe can tell: it reaches a listener on the same internal network, and the live Postgres from its own network', () => {
    const same = probe(net('sandbox'), probeTargets({ hostGateway: gateway, livePgAddress: sandboxSinkIp }), [
      '--ip',
      slot(2),
    ])
    expect(same.status, same.stderr).toBe(0)
    const parsed = parseProbeOutput(same.stdout, probeTargets({ hostGateway: gateway, livePgAddress: sandboxSinkIp }))
    expect(parsed.ok).toBe(false)
    expect(parsed.reason).toContain(`tcp:${sandboxSinkIp}:5432`)
    const own = probe(net('live'), probeTargets({ hostGateway: gateway, livePgAddress: liveIp }))
    expect(JSON.parse(own.stdout.trim().split('\n').at(-1)!)).toEqual(
      expect.arrayContaining([{ id: `tcp:${liveIp}:5432`, reached: true }]),
    )
  }, 120_000)

  it('the sandbox network has no host-side gateway address, and a host listener on every interface is not reachable at it', async () => {
    const inspect = JSON.parse(sh(['network', 'inspect', net('sandbox')]))
    expect(inspect[0].IPAM.Config[0].Gateway).toBeUndefined()
    const gw = sandboxGateway(inspect)
    expect(gw).toMatch(/^\d+\.\d+\.\d+\.1$/)
    const canary = await listenOnEveryInterface()
    try {
      const ts = sandboxTargets({
        base: [],
        gateway: gw,
        canaryPort: canary.port,
        controlHost: ctr('sink'),
      })
      const r = probe(net('sandbox'), ts, ['--ip', slot(2)])
      expect(r.status, r.stderr).toBe(0)
      expect(parseProbeOutput(r.stdout, ts)).toEqual({ ok: true })
      const rows = JSON.parse(r.stdout.trim().split('\n').at(-1)!) as { id: string; reached: boolean }[]
      expect(rows.find((x) => x.id.startsWith('control:'))?.reached).toBe(true)
    } finally {
      await canary.close()
    }
  }, 120_000)

  it('the gateway probe can tell: on an ordinary network the same host listener is reached, and the run is blocked', async () => {
    const open = JSON.parse(sh(['network', 'inspect', net('open')]))
    const gw = open[0].IPAM.Config[0].Gateway as string
    const canary = await listenOnEveryInterface()
    try {
      const ts = [{ id: `tcp:${gw}:${canary.port}`, kind: 'tcp', host: gw, port: canary.port }]
      const r = probe(net('open'), ts)
      expect(r.status, r.stderr).toBe(0)
      expect(JSON.parse(r.stdout.trim().split('\n').at(-1)!)).toEqual([{ id: ts[0]!.id, reached: true }])
      expect(parseProbeOutput(r.stdout, ts).ok).toBe(false)
    } finally {
      await canary.close()
    }
  }, 120_000)

  it('why the gateway matters: on a plain --internal network the host listener IS reachable at the gateway', async () => {
    sh(['network', 'create', '--internal', ...L, net('plain')])
    const gw = sandboxGateway(JSON.parse(sh(['network', 'inspect', net('plain')]))) as string
    const canary = await listenOnEveryInterface()
    try {
      const ts = [{ id: `tcp:${gw}:${canary.port}`, kind: 'tcp', host: gw, port: canary.port }]
      const r = probe(net('plain'), ts, [
        '--ip',
        sandboxAddress(JSON.parse(sh(['network', 'inspect', net('plain')])), 0),
      ])
      expect(JSON.parse(r.stdout.trim().split('\n').at(-1)!)).toEqual([{ id: ts[0]!.id, reached: true }])
    } finally {
      await canary.close()
    }
  }, 120_000)

  it('a probe that cannot see its control fails closed', () => {
    const ts = sandboxTargets({ base: [], gateway: '172.31.255.1', canaryPort: 0, controlHost: 'no-such-host' })
    const r = probe(net('sandbox'), ts, ['--ip', slot(2)])
    expect(r.status, r.stderr).toBe(0)
    expect(parseProbeOutput(r.stdout, ts).reason).toMatch(/control/)
  }, 120_000)

  it('a background worker that starts after boot cannot reach out either', () => {
    const late = `setTimeout(()=>{${probeScript(targets).replace(/\n/g, ' ')}},3000)`
    sh([
      'run',
      '-d',
      '--name',
      ctr('worker'),
      ...L,
      '--network',
      net('sandbox'),
      '--ip',
      slot(1),
      '--entrypoint',
      'node',
      IMAGE,
      '-e',
      late,
    ])
    spawnSync('sleep', ['9'])
    const out = sh(['logs', ctr('worker')])
    expect(parseProbeOutput(out, targets)).toEqual({ ok: true })
  }, 120_000)

  it('after a killed compat job the next sweep removes every labelled resource and reads back zero', () => {
    sh(['volume', 'create', ...L, `doop-compat-${RUN}-vol`])
    const r = spawnSync('bash', [resolve('deploy/cd/c00.sh'), 'sweep'], {
      encoding: 'utf8',
      env: { ...process.env, C00_DF_PATH: '/' },
    })
    expect(r.status, r.stderr).toBe(0)
    for (const kind of ['ps -aq', 'network ls -q', 'volume ls -q']) {
      const out = docker(...kind.split(' '), '--filter', `label=${LABEL}`)
      expect(out.stdout.trim(), kind).toBe('')
    }
  }, 120_000)
})
