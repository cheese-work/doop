import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
// @ts-expect-error plain .mjs script, no types
import { LABEL, parseProbeOutput, probeScript, probeTargets } from '../scripts/compat-sandbox.mjs'

/* Sandbox isolation with real Docker (CHE-5474 C-8.5c): a CI fixture for a hosted runner. It uses the same
   probe script the compat job runs, on an `--internal` network, against a "live" Postgres on another network. */
const docker = (...args: string[]) => spawnSync('docker', args, { encoding: 'utf8' })
const haveDocker = docker('info', '--format', '{{.ServerVersion}}').status === 0
const IMAGE = 'node:22-slim'
const RUN = 'fx' + randomBytes(3).toString('hex')
const L = ['--label', `${LABEL}=${RUN}`]
const net = (n: string) => `doop-compat-${RUN}-${n}`
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
    sh(['network', 'create', '--internal', ...L, net('sandbox')])
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
    const r = probe(net('sandbox'), targets)
    expect(r.status, r.stderr).toBe(0)
    expect(parseProbeOutput(r.stdout, targets)).toEqual({ ok: true })
  }, 120_000)

  it('the probe can tell: it reaches a listener on the same internal network, and the live Postgres from its own network', () => {
    const same = probe(net('sandbox'), probeTargets({ hostGateway: gateway, livePgAddress: sandboxSinkIp }))
    expect(same.status, same.stderr).toBe(0)
    const parsed = parseProbeOutput(same.stdout, probeTargets({ hostGateway: gateway, livePgAddress: sandboxSinkIp }))
    expect(parsed.ok).toBe(false)
    expect(parsed.reason).toContain(`tcp:${sandboxSinkIp}:5432`)
    const own = probe(net('live'), probeTargets({ hostGateway: gateway, livePgAddress: liveIp }))
    expect(JSON.parse(own.stdout.trim().split('\n').at(-1)!)).toEqual(
      expect.arrayContaining([{ id: `tcp:${liveIp}:5432`, reached: true }]),
    )
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
