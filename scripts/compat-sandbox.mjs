// The compat sandbox (CHE-5474 S4c, C-8.5b to C-8.5d): clone the live database into an `--internal`
// Docker network, migrate it with the candidate, boot the PREDECESSOR on it and run the contract smoke
// suite. Evidence says whether the candidate can be rolled forward over the predecessor. This file
// holds the decisions; `runCompat` takes a runner so tests script what Docker answers.
//
//   node scripts/compat-sandbox.mjs run     (env below)   writes compat-evidence.json
//   node scripts/compat-sandbox.mjs verify  (env below)   deploy step 1: exit 1 unless the evidence fits
//
// Nothing here builds an image, pulls one, publishes a port or mounts a path. Every resource carries
// the label `doop.compat.run=<run id>`, so `c00.sh sweep` removes whatever a killed job left behind.
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ALLOWED_KEYS, buildPredecessorEnv, checkEnvKeys } from './compat-env.mjs'

export const LABEL = 'doop.compat.run'
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,39}$/
const PORT = '4400'
const DISK_FACTOR = 3
const no = (reason) => ({ ok: false, reason })

export const names = (id) => ({
  network: `doop-compat-${id}`,
  db: `doop-compat-db-${id}`,
  volume: `doop-compat-vol-${id}`,
  app: `doop-compat-app-${id}`,
  probe: `doop-compat-probe-${id}`,
  migrate: `doop-migrate-${id}`,
  smoke: `doop-compat-smoke-${id}`,
})

/* ---------- isolation probes ---------- */

export const probeTargets = ({ hostGateway, livePgAddress }) => [
  { id: 'tcp:1.1.1.1:443', kind: 'tcp', host: '1.1.1.1', port: 443 },
  { id: `tcp:${hostGateway}:443`, kind: 'tcp', host: hostGateway, port: 443 },
  { id: `tcp:${livePgAddress}:5432`, kind: 'tcp', host: livePgAddress, port: 5432 },
  { id: 'dns:api.github.com', kind: 'dns', host: 'api.github.com' },
]

/** One line of node, run inside a sandbox container. Prints a JSON array of {id, reached}. */
export const probeScript = (targets) =>
  `const net=require('net'),dns=require('dns');const T=${JSON.stringify(targets)};` +
  `const one=t=>new Promise(r=>{const d=ok=>r({id:t.id,reached:ok});` +
  `if(t.kind==='dns'){dns.lookup(t.host,e=>d(!e));setTimeout(()=>d(false),4000);return}` +
  `const s=net.connect({host:t.host,port:t.port});s.setTimeout(3000);` +
  `s.on('connect',()=>{s.destroy();d(true)});s.on('timeout',()=>{s.destroy();d(false)});s.on('error',()=>d(false))});` +
  `Promise.all(T.map(one)).then(r=>console.log(JSON.stringify(r)))`

/** Every target must answer, and every answer must be "not reached". */
export function parseProbeOutput(stdout, targets) {
  const line = String(stdout ?? '')
    .trim()
    .split('\n')
    .filter(Boolean)
    .at(-1)
  if (!line) return no('probe printed nothing')
  let rows
  try {
    rows = JSON.parse(line)
  } catch {
    return no('probe output is not JSON')
  }
  if (!Array.isArray(rows)) return no('probe output is not a list')
  const byId = new Map(rows.map((r) => [r?.id, r?.reached]))
  const unanswered = targets.filter((t) => typeof byId.get(t.id) !== 'boolean').map((t) => t.id)
  if (unanswered.length) return no(`probe left ${unanswered.join(', ')} unanswered`)
  const reached = targets.filter((t) => byId.get(t.id) === true).map((t) => t.id)
  if (reached.length) return no(`sandbox reached ${reached.join(', ')}`)
  return { ok: true }
}

const cname = (n) => String(n ?? '').replace(/^\//, '')

/** `docker network inspect`: Internal, and nothing on it that is not ours. */
export function checkNetworkInspect(inspect, allowedNames) {
  const net = Array.isArray(inspect) ? inspect[0] : undefined
  if (!net) return no('network inspect is empty')
  if (net.Internal !== true) return no('sandbox network is not Internal')
  const foreign = Object.values(net.Containers ?? {})
    .map((c) => cname(c?.Name))
    .filter((n) => !allowedNames.includes(n))
  return foreign.length ? no(`foreign container on the sandbox network: ${foreign.join(', ')}`) : { ok: true }
}

/** `docker inspect` of the predecessor. Image-level ENV (PATH, NODE_VERSION, ...) is not ours to police. */
export function checkAppInspect(inspect, network, imageEnvKeys = []) {
  const c = Array.isArray(inspect) ? inspect[0] : undefined
  if (!c) return no('predecessor inspect is empty')
  const keys = (c.Config?.Env ?? [])
    .map((e) => String(e).split('=')[0])
    .filter((k) => ALLOWED_KEYS.includes(k) || !imageEnvKeys.includes(k))
  const env = checkEnvKeys(keys)
  if (!env.ok)
    return no(
      `predecessor env is not the allowlist (extra: ${env.extra.join(',') || '-'}; missing: ${env.missing.join(',') || '-'})`,
    )
  if ((c.Mounts ?? []).length) return no('predecessor has a mount')
  const hc = c.HostConfig ?? {}
  if (hc.Privileged) return no('predecessor is privileged')
  if (hc.ReadonlyRootfs !== true) return no('predecessor root filesystem is writable')
  if (!(hc.CapDrop ?? []).includes('ALL')) return no('predecessor keeps capabilities')
  if (Object.keys(hc.PortBindings ?? {}).length) return no('predecessor publishes a port')
  if (Object.values(c.NetworkSettings?.Ports ?? {}).some((v) => v)) return no('predecessor publishes a port')
  const nets = Object.keys(c.NetworkSettings?.Networks ?? {})
  if (nets.length !== 1 || nets[0] !== network)
    return no(`predecessor is on ${nets.join(',') || 'no network'}, not only ${network}`)
  return { ok: true }
}

/* ---------- disk, ledger, evidence ---------- */

export function diskOk({ freeBytes, dbBytes }) {
  if (!Number.isFinite(freeBytes) || !Number.isFinite(dbBytes) || dbBytes < 0)
    return no('disk: free space or database size is unknown')
  return freeBytes >= DISK_FACTOR * dbBytes
    ? { ok: true }
    : no(`disk: ${freeBytes} bytes free, need ${DISK_FACTOR}x the ${dbBytes} byte database`)
}

const canon = (v) =>
  Array.isArray(v)
    ? `[${v.map(canon).join(',')}]`
    : v && typeof v === 'object'
      ? `{${Object.keys(v)
          .sort()
          .map((k) => `${JSON.stringify(k)}:${canon(v[k])}`)
          .join(',')}}`
      : JSON.stringify(v ?? null)

/** Content hash of the migration ledger rows, in order. */
export const ledgerHash = (rows) => createHash('sha256').update(canon(rows)).digest('hex')

/** Deploy step 1: evidence counts only for this candidate, this predecessor digest and this ledger. */
export function verifyEvidence(evidence, expected = {}) {
  let ev = evidence
  if (typeof ev === 'string') {
    try {
      ev = JSON.parse(ev)
    } catch {
      return no('compat evidence is not readable')
    }
  }
  if (!ev || typeof ev !== 'object') return no('compat evidence is missing')
  for (const k of ['candidateSha', 'predecessorDigest', 'ledgerHash']) {
    if (typeof expected[k] !== 'string' || !expected[k]) return no(`expected ${k} is missing`)
  }
  if (ev.ok !== true) return no('compat evidence is not ok')
  for (const part of ['static', 'clone', 'behavior']) {
    if (ev.results?.[part]?.ok !== true) return no(`compat result "${part}" is missing or failed`)
  }
  if (ev.cleanup?.ok !== true) return no('compat cleanup did not finish')
  if (ev.predecessorDigest !== expected.predecessorDigest)
    return no('compat evidence is for another predecessor digest')
  if (ev.ledgerHash !== expected.ledgerHash) return no('compat evidence is for another ledger hash')
  if (ev.candidateSha !== expected.candidateSha) return no('compat evidence is for another candidate sha')
  return { ok: true }
}

const ict = (d) => `${new Date(d.getTime() + 7 * 3600e3).toISOString().slice(0, 19).replace('T', ' ')} ICT`
const tail = (r) =>
  String(r?.stderr || r?.stdout || '')
    .trim()
    .split('\n')
    .slice(-3)
    .join(' | ')
    .slice(0, 300)
const lastJson = (s) => {
  try {
    return JSON.parse(
      String(s ?? '')
        .trim()
        .split('\n')
        .filter(Boolean)
        .at(-1),
    )
  } catch {
    return undefined
  }
}

/* ---------- the run ---------- */

class Stop extends Error {
  constructor(part, reason) {
    super(reason)
    this.part = part
  }
}

export async function runCompat({
  runner,
  runId,
  candidate,
  predecessor,
  liveDb,
  staticResult,
  ledgerRows,
  probeTargets: targets,
}) {
  if (typeof runId !== 'string' || !RUN_ID.test(runId)) throw new Error('compat: run id must be a plain token')
  const first = await runner.sweep()
  if (!first.ok) throw new Error(`compat: sweep before the run failed: ${first.message}`)

  const n = names(runId)
  const label = ['--label', `${LABEL}=${runId}`]
  const sandbox = ['--network', n.network]
  const locked = ['--cap-drop', 'ALL', '--read-only', '--tmpfs', '/tmp']
  const evidence = {
    ok: false,
    candidateSha: candidate.sha,
    predecessorDigest: predecessor.digest,
    ledgerHash: ledgerHash(ledgerRows),
    runId,
    startedAtIct: ict(runner.now()),
    results: { static: { ok: false }, clone: { ok: false }, behavior: { ok: false } },
    disk: { beforeBytes: null, afterBytes: null },
    cleanup: { ok: false },
  }
  const must = async (part, args, what) => {
    const r = await runner.docker(args)
    if (r.code !== 0) throw new Stop(part, `${what} failed: ${tail(r)}`)
    return r
  }

  let thrown
  try {
    evidence.disk.beforeBytes = await runner.freeBytes()
    if (!staticResult || staticResult.ok !== true)
      throw new Stop('static', staticResult?.reason ?? 'static compatibility result is missing')
    evidence.results.static = { ok: true }

    const size = await runner.docker([
      'exec',
      liveDb.container,
      'psql',
      '-U',
      liveDb.user,
      '-d',
      liveDb.db,
      '-tAc',
      'select pg_database_size(current_database())',
    ])
    if (size.code !== 0) throw new Stop('clone', `cannot read the live database size: ${tail(size)}`)
    const disk = diskOk({
      freeBytes: evidence.disk.beforeBytes,
      dbBytes: Number.parseInt(String(size.stdout).trim(), 10),
    })
    if (!disk.ok) throw new Stop('clone', disk.reason)

    const image = (
      await must('clone', ['inspect', '--format', '{{.Image}}', liveDb.container], 'reading the live Postgres image')
    ).stdout.trim()
    if (!image) throw new Stop('clone', 'live Postgres image id is empty')
    const url = `postgres://${liveDb.user}:${runner.randomSecret()}@${n.db}:5432/${liveDb.db}`
    const password = new URL(url).password

    await must('clone', ['network', 'create', '--internal', ...label, n.network], 'creating the sandbox network')
    await must('clone', ['volume', 'create', ...label, n.volume], 'creating the sandbox volume')
    await must(
      'clone',
      [
        'run',
        '-d',
        '--name',
        n.db,
        ...label,
        ...sandbox,
        '-v',
        `${n.volume}:/var/lib/postgresql/data`,
        '-e',
        'PGDATA=/var/lib/postgresql/data/pgdata',
        '-e',
        `POSTGRES_USER=${liveDb.user}`,
        '-e',
        `POSTGRES_PASSWORD=${password}`,
        '-e',
        `POSTGRES_DB=${liveDb.db}`,
        image,
      ],
      'starting the clone database',
    )
    let ready = false
    for (let i = 0; i < 90 && !ready; i++) {
      ready =
        (await runner.docker(['exec', n.db, 'pg_isready', '-h', '127.0.0.1', '-U', liveDb.user, '-d', liveDb.db]))
          .code === 0
      if (!ready) await runner.sleep(1000)
    }
    if (!ready) throw new Stop('clone', 'the clone database did not become ready')

    const copy = await runner.pipe(
      ['exec', liveDb.container, 'pg_dump', '-U', liveDb.user, '-d', liveDb.db, '-Fc', '--no-owner', '--no-acl'],
      [
        'exec',
        '-i',
        n.db,
        'pg_restore',
        '-U',
        liveDb.user,
        '-d',
        liveDb.db,
        '--no-owner',
        '--no-acl',
        '--exit-on-error',
      ],
    )
    if (copy.code !== 0) throw new Stop('clone', `copying the live data failed: ${tail(copy)}`)

    // The candidate's migrations on the cloned data: the supervised runner of C-8.8, in a one-shot container.
    await must(
      'clone',
      [
        'run',
        '--name',
        n.migrate,
        ...label,
        ...sandbox,
        ...locked,
        '-e',
        `DATABASE_URL=${url}`,
        '-e',
        `DOOP_MIGRATE_APP_NAME=${n.migrate}`,
        '-e',
        'DOOP_MIGRATE_DEADLINE_SECONDS=300',
        '--entrypoint',
        'node_modules/.bin/tsx',
        candidate.image,
        'server/db/migrate.ts',
      ],
      'the candidate migration on the cloned data',
    )
    evidence.results.clone = { ok: true }

    // Probes first: any one that gets out blocks startup.
    const probe = await runner.docker([
      'run',
      '--name',
      n.probe,
      ...label,
      ...sandbox,
      ...locked,
      '--entrypoint',
      'node',
      candidate.image,
      '-e',
      probeScript(targets),
    ])
    if (probe.code !== 0) throw new Stop('behavior', `isolation probe could not run: ${tail(probe)}`)
    const probed = parseProbeOutput(probe.stdout, targets)
    if (!probed.ok) throw new Stop('behavior', `isolation probe: ${probed.reason}`)

    const net = await must('behavior', ['network', 'inspect', n.network], 'inspecting the sandbox network')
    const netCheck = checkNetworkInspect(lastJsonArray(net.stdout), Object.values(n))
    if (!netCheck.ok) throw new Stop('behavior', netCheck.reason)

    const imageEnv = await must(
      'behavior',
      ['image', 'inspect', '--format', '{{json .Config.Env}}', predecessor.image],
      'reading the predecessor image env',
    )
    const imageEnvKeys = (JSON.parse(imageEnv.stdout.trim() || '[]') ?? []).map((e) => String(e).split('=')[0])
    const env = buildPredecessorEnv({ databaseUrl: url, port: PORT, secret: runner.randomSecret() })
    await must(
      'behavior',
      [
        'create',
        '--name',
        n.app,
        ...label,
        ...sandbox,
        ...locked,
        ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
        predecessor.image,
      ],
      'creating the predecessor',
    )
    const app = await must('behavior', ['inspect', n.app], 'inspecting the predecessor')
    const appCheck = checkAppInspect(lastJsonArray(app.stdout), n.network, imageEnvKeys)
    if (!appCheck.ok) throw new Stop('behavior', appCheck.reason)

    await must('behavior', ['start', n.app], 'starting the predecessor')
    // The smoke suite runs from the CANDIDATE image: the predecessor may predate it.
    const smoke = await runner.docker([
      'run',
      '--name',
      n.smoke,
      ...label,
      ...sandbox,
      ...locked,
      '-e',
      `SMOKE_BASE_URL=http://${n.app}:${PORT}`,
      '-e',
      'SMOKE_ORIGIN=http://localhost',
      '--entrypoint',
      'node',
      candidate.image,
      'scripts/deploy-smoke.mjs',
    ])
    const out = lastJson(smoke.stdout)
    if (!out || typeof out !== 'object')
      throw new Stop('behavior', `smoke output is unreadable (exit ${smoke.code}): ${tail(smoke)}`)
    if (smoke.code !== 0 || out.ok !== true) {
      const bad = (out.failed ?? [])
        .map((f) => `${f.group} ${f.kind ?? ''} ${f.status ?? ''}`.trim())
        .slice(0, 5)
        .join('; ')
      throw new Stop('behavior', `smoke failed on the predecessor: ${bad || 'no detail'}`)
    }
    evidence.results.behavior = { ok: true, smokeCalls: Array.isArray(out.results) ? out.results.length : null }
  } catch (e) {
    if (e instanceof Stop) evidence.failed = { part: e.part, reason: e.message }
    else thrown = e
  }

  // Always last, success or not: the scratch database goes with the sandbox.
  let last
  try {
    last = await runner.sweep()
  } catch (e) {
    last = { ok: false, message: String(e?.message ?? e) }
  }
  try {
    evidence.disk.afterBytes = await runner.freeBytes()
  } catch {
    // df is evidence, not a gate
  }
  if (thrown) throw thrown
  evidence.cleanup = { ok: last.ok === true, message: last.message }
  if (!evidence.cleanup.ok && !evidence.failed)
    evidence.failed = { part: 'cleanup', reason: `sweep after the run failed: ${last.message}` }
  evidence.ok = !evidence.failed && evidence.cleanup.ok && Object.values(evidence.results).every((r) => r.ok)
  return evidence
}

function lastJsonArray(text) {
  try {
    return JSON.parse(String(text ?? ''))
  } catch {
    return undefined
  }
}

/* ---------- CLI: the real runner ---------- */

const run = (cmd, args, { input } = {}) =>
  new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    p.stdout.on('data', (d) => (stdout += d))
    p.stderr.on('data', (d) => (stderr += d))
    p.on('error', (e) => resolve({ code: 127, stdout, stderr: String(e) }))
    p.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }))
    p.stdin.on('error', () => {})
    p.stdin.end(input)
  })

function realRunner() {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const dfPath = process.env.C00_DF_PATH ?? '/var/lib/docker'
  return {
    docker: (args, o) => run('docker', args, o),
    pipe: (a, b) =>
      new Promise((resolve) => {
        const left = spawn('docker', a, { stdio: ['ignore', 'pipe', 'pipe'] })
        const right = spawn('docker', b, { stdio: ['pipe', 'ignore', 'pipe'] })
        let err = ''
        let codes = 0
        const codeOf = {}
        left.stderr.on('data', (d) => (err += d))
        right.stderr.on('data', (d) => (err += d))
        left.stdout.pipe(right.stdin)
        right.stdin.on('error', () => {})
        const done = (who) => (code) => {
          codeOf[who] = code ?? 1
          if (++codes === 2) resolve({ code: codeOf.left || codeOf.right, stderr: err })
        }
        left.on('close', done('left'))
        right.on('close', done('right'))
      }),
    freeBytes: async () =>
      Number.parseInt((await run('df', ['-B1', '--output=avail', dfPath])).stdout.split('\n').at(1)?.trim() ?? '', 10),
    sweep: async () => {
      const r = await run('bash', [path.join(here, '..', 'deploy', 'cd', 'c00.sh'), 'sweep'])
      return { ok: r.code === 0, message: tail(r) }
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => new Date(),
    randomSecret: () => buildPredecessorEnv({ databaseUrl: 'x' }).BETTER_AUTH_SECRET,
  }
}

const need = (k) => {
  const v = process.env[k]
  if (!v) throw new Error(`compat-sandbox: ${k} is required`)
  return v
}
const readJson = (k) => JSON.parse(readFileSync(need(k), 'utf8'))

async function cli(cmd) {
  if (cmd === 'verify') {
    const r = verifyEvidence(readFileSync(need('COMPAT_EVIDENCE'), 'utf8'), {
      candidateSha: need('COMPAT_CANDIDATE_SHA'),
      predecessorDigest: need('COMPAT_PREDECESSOR_DIGEST'),
      ledgerHash: ledgerHash(readJson('COMPAT_LEDGER_ROWS')),
    })
    console.log(JSON.stringify(r))
    return r.ok ? 0 : 1
  }
  if (cmd !== 'run') throw new Error('usage: compat-sandbox.mjs run|verify')
  const runner = realRunner()
  const liveDb = {
    container: need('COMPAT_LIVE_DB_CONTAINER'),
    user: need('COMPAT_DB_USER'),
    db: need('COMPAT_DB_NAME'),
  }
  const gateway = (
    await runner.docker(['network', 'inspect', 'bridge', '--format', '{{range .IPAM.Config}}{{.Gateway}}{{end}}'])
  ).stdout.trim()
  const addr = (
    await runner.docker([
      'inspect',
      '--format',
      '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}',
      liveDb.container,
    ])
  ).stdout
    .trim()
    .split(/\s+/)[0]
  if (!gateway || !addr) throw new Error('compat-sandbox: cannot read the host gateway or the live Postgres address')
  const predecessorImage = need('COMPAT_PREDECESSOR_IMAGE')
  const evidence = await runCompat({
    runner,
    runId: need('COMPAT_RUN_ID'),
    candidate: { sha: need('COMPAT_CANDIDATE_SHA'), image: need('COMPAT_CANDIDATE_IMAGE') },
    predecessor: { image: predecessorImage, digest: predecessorImage.split('@')[1] },
    liveDb,
    staticResult: readJson('COMPAT_STATIC_RESULT'),
    ledgerRows: readJson('COMPAT_LEDGER_ROWS'),
    probeTargets: probeTargets({ hostGateway: gateway, livePgAddress: addr }),
  })
  writeFileSync(need('COMPAT_OUT'), JSON.stringify(evidence, null, 2) + '\n')
  console.log(JSON.stringify({ ok: evidence.ok, failed: evidence.failed }))
  return evidence.ok ? 0 : 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  cli(process.argv[2]).then(
    (code) => process.exit(code),
    (e) => {
      console.error(String(e?.message ?? e))
      process.exit(1)
    },
  )
}
