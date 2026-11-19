/* global window, document, addEventListener, performance, fetch, crypto, TextEncoder, navigator, caches */
// S2b load timing check. Spawns the server itself (so it can swap the toolkit between visits), drives headless Chrome
// in ONE persistent profile (real HTTP cache, service worker and Cache Storage survive the relaunch), and records
// bytes on the wire and time to first frame. Exit 1 when an assertion fails (that is the red).
//
//   node check.mjs assert  --server s1b|s2b [--mode none|http|sw]     cold, warm, bump, preload assertions
//   node check.mjs visits  --server s2b --mode http --runs 5          cold / warm / bump table, p50 and max
//   node check.mjs preload --server s2b --mode sw --level 0|1|2 --delays 0,5000,15000 --runs 3
//
// bytes: for s2b the server's own count of body bytes it sent (STATS_FILE, authoritative, also sees service worker
// fetches); Playwright's per-request count is printed beside it. For s1b (no stats) Playwright's count is all there is.
import { chromium } from 'playwright-core'
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const A = Object.fromEntries(
  process.argv
    .slice(3)
    .join(' ')
    .split(/\s--/)
    .map((s) => s.replace(/^--/, '').trim().split(/\s+/))
    .filter((x) => x[0])
    .map(([k, v]) => [k, v ?? true]),
)
const suite = process.argv[2]
const server = A.server ?? 's2b'
const mode = A.mode ?? 'none'
const SCR = process.env.SCR ?? '/mnt/ssd2/scratch/che-7630'
const SDK_A = process.env.SDK_A ?? '/mnt/ssd2/scratch/che-7478/sdk'
const SDK_B = process.env.SDK_B ?? `${SCR}/sdk-bump`
const CHROME = process.env.CHROME ?? `${os.homedir()}/.cache/ms-playwright/chromium-1254/chrome-linux64/chrome`
const here = path.dirname(new URL(import.meta.url).pathname)
const PORT = server === 's1b' ? 19470 : 19471
const HOST = 'congvc-x99.taila6fa8a.ts.net'
const STATS = `${SCR}/stats-${server}.jsonl`
const rootUrl = () => {
  const q = server === 's2b' ? `?cache=${mode}${A.query ? '&' + A.query : ''}` : A.query ? '?' + A.query : ''
  return `https://${HOST}:${PORT}/${q}`
}

let child
async function startServer(sdk) {
  stopServer()
  const script = server === 's1b' ? path.join(here, '../s1b/serve.ts') : path.join(here, 'serve.ts')
  child = spawn('bun', [script, String(PORT)], {
    env: { ...process.env, SDK_DIR: sdk, ZCACHE: `${SCR}/zcache`, STATS_FILE: STATS },
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  await new Promise((res, rej) => {
    child.stdout.on('data', (d) => /on https:/.test(String(d)) && res())
    child.on('exit', (c) => rej(new Error('server exited ' + c)))
  })
}
function stopServer() {
  if (child) child.kill('SIGTERM') // exact child PID, never by name
  child = undefined
}
process.on('exit', stopServer)

const statsSize = () => (fs.existsSync(STATS) ? fs.statSync(STATS).size : 0)
const statsSince = (off) =>
  fs.existsSync(STATS)
    ? fs
        .readFileSync(STATS, 'utf8')
        .slice(off)
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : []

async function visit(profile, url, { waitFrame = true, timeout = 240000, quota = null } = {}) {
  const off = statsSize()
  const ctx = await chromium.launchPersistentContext(profile, {
    executablePath: CHROME,
    viewport: { width: 1250, height: 900 },
  })
  const page = ctx.pages()[0] ?? (await ctx.newPage())
  if (quota) {
    // pretend the origin has a small storage quota: what a browser under disk pressure would grant
    const cdp = await ctx.newCDPSession(page)
    await cdp.send('Storage.overrideQuotaForOrigin', { origin: new URL(url).origin, quotaSize: quota })
  }
  const reqs = []
  let inflight = 0
  ctx.on('request', () => inflight++)
  ctx.on('requestfailed', () => inflight--)
  ctx.on('requestfinished', async (r) => {
    inflight--
    try {
      const s = await r.sizes()
      const u = new URL(r.url())
      const resp = await r.response()
      reqs.push({ u, bytes: s.responseBodySize + s.responseHeadersSize, sw: resp?.fromServiceWorker() })
    } catch {
      /* request raced the close */
    }
  })
  await page.addInitScript(() => {
    window.__first = null
    addEventListener('message', (e) => {
      if (e.data?.type === 'doop:flutter-frame' && !window.__first) window.__first = Date.now()
    })
  })
  const t0 = Date.now()
  await page.goto(url, { waitUntil: 'commit', timeout })
  let first = null
  if (waitFrame) {
    await page.waitForFunction(() => window.__first, null, { timeout })
    first = await page.evaluate(() => window.__first)
  }
  // settle: late requests (fonts, the lazily loaded sdk.tar) must finish, or the byte count is short
  for (let quiet = 0, w = 0; quiet < 6 && w < 120; w++) {
    await page.waitForTimeout(500)
    quiet = inflight <= 0 ? quiet + 1 : 0
  }
  const opened = await page.evaluate(() => window.s2b?.openedAt ?? null)
  const base = await page.evaluate(() => window.s2b?.base ?? '/sdk/')
  const hasHook = await page.evaluate(() => typeof window.s2b?.openFrame === 'function')
  // what toolkit the page actually runs: hash of worker.js as this page's fetch path serves it now
  const workerHash = await page.evaluate(async (b) => {
    const buf = await (await fetch(b + 'worker.js')).arrayBuffer()
    const d = await crypto.subtle.digest('SHA-256', buf)
    return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, '0')).join('')
  }, base)
  const storage = await page.evaluate(async () => (await navigator.storage.estimate()).usage)
  const cacheEntries = await page.evaluate(async () => {
    let n = 0
    for (const k of await caches.keys())
      if (k.startsWith('toolkit-') && k !== 'toolkit-meta') n += (await (await caches.open(k)).keys()).length
    return n
  })
  if (A.verbose)
    for (const r of reqs) if (r.u.hostname === HOST) console.log('   req', r.u.pathname, r.bytes, r.sw ? 'sw' : '')
  await ctx.close()
  const tk = (u) => /^\/(sdk|sdkh|sdks|mirror)\//.test(u.pathname) && u.hostname === HOST
  const pw = reqs.filter((r) => tk(r.u) && !r.sw).reduce((n, r) => n + r.bytes, 0)
  // a request the service worker answered from the X99 mirror leaves the browser for X99 only: not third-party
  const third = reqs.filter((r) => r.u.hostname !== HOST && /^https?:$/.test(r.u.protocol) && !r.sw)
  const stats = server === 's2b' ? statsSince(off) : null
  const srv = stats ? stats.reduce((n, s) => n + s.bytes, 0) : null
  return {
    ttf: first ? first - t0 : null,
    openToFrame: first && opened ? first - opened : null,
    toolkitBytes: srv ?? pw,
    playwrightBytes: pw,
    toolkitReqs: stats ? stats.filter((s) => s.status === 200).length : reqs.filter((r) => tk(r.u) && !r.sw).length,
    thirdParty: [...new Set(third.map((r) => r.u.hostname))],
    thirdBytes: third.reduce((n, r) => n + r.bytes, 0),
    workerHash,
    hasHook,
    storage,
    cacheEntries,
  }
}

const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')
const mb = (n) => (n / 1e6).toFixed(2) + ' MB'
const p50 = (a) => [...a].sort((x, y) => x - y)[Math.floor((a.length - 1) / 2)]
const max = (a) => Math.max(...a)
const prof = () => {
  const d = fs.mkdtempSync(path.join(SCR, 'prof-'))
  return d
}
const ICT = () => new Date().toLocaleString('sv', { timeZone: 'Asia/Bangkok' }) + ' ICT'

async function threeVisits() {
  const profile = prof()
  try {
    await startServer(SDK_A)
    const cold = await visit(profile, rootUrl())
    const warm = await visit(profile, rootUrl())
    await startServer(SDK_B) // same origin, new toolkit
    const bump = await visit(profile, rootUrl())
    bump.expectedWorker = sha(path.join(SDK_B, 'worker.js'))
    return { cold, warm, bump }
  } finally {
    stopServer()
    fs.rmSync(profile, { recursive: true, force: true })
  }
}

let fails = 0
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail ?? ''}`)
  if (!ok) fails++
}

if (suite === 'assert') {
  console.log(
    `# ${ICT()} server=${server} mode=${mode} load=${os
      .loadavg()
      .map((x) => x.toFixed(1))
      .join(' ')}`,
  )
  const { cold, warm, bump } = await threeVisits()
  console.log(
    `cold  ttf ${cold.ttf} ms, toolkit ${mb(cold.toolkitBytes)} in ${cold.toolkitReqs} requests, third-party ${cold.thirdParty.join(',') || 'none'}`,
  )
  console.log(`warm  ttf ${warm.ttf} ms, toolkit ${mb(warm.toolkitBytes)} in ${warm.toolkitReqs} requests`)
  console.log(`bump  ttf ${bump.ttf} ms, toolkit ${mb(bump.toolkitBytes)} in ${bump.toolkitReqs} requests`)
  check('1 cold reaches a first frame', cold.ttf !== null)
  check('2 warm second visit downloads no toolkit asset', warm.toolkitBytes === 0, mb(warm.toolkitBytes))
  check(
    '3 after a toolkit bump the page runs the new toolkit',
    bump.workerHash === bump.expectedWorker,
    `ran ${bump.workerHash.slice(0, 12)} want ${bump.expectedWorker.slice(0, 12)}`,
  )
  // http: the URL base is keyed to the whole toolkit, so a bump re-downloads everything (recorded, not asserted).
  // sw: one Cache Storage entry per file keyed by its SHA-256, so only the changed files download.
  if (mode === 'http')
    console.log(`INFO  4 http mode: bump downloads ${mb(bump.toolkitBytes)} (whole toolkit, new URL base)`)
  else check('4 after a bump only changed assets download (< 1 MB)', bump.toolkitBytes < 1e6, mb(bump.toolkitBytes))
  check('5 page exposes a frame-open hook (preload needs one)', cold.hasHook)
  if (mode === 'sw' || server === 's1b')
    check(
      '6 viewer browser calls no third-party host',
      cold.thirdParty.length === 0,
      cold.thirdParty.join(',') || 'none',
    )
  else
    console.log(
      `INFO  6 ${mode} mode: third-party host still called: ${cold.thirdParty.join(',') || 'none'} (only the service worker can redirect the hardcoded font URL)`,
    )
  process.exit(fails ? 1 : 0)
}

if (suite === 'visits') {
  const n = Number(A.runs ?? 5)
  const rows = { cold: [], warm: [], bump: [] }
  console.log(
    `# ${ICT()} server=${server} mode=${mode} runs=${n} load=${os
      .loadavg()
      .map((x) => x.toFixed(1))
      .join(' ')}`,
  )
  for (let i = 1; i <= n; i++) {
    const r = await threeVisits()
    for (const k of ['cold', 'warm', 'bump']) {
      rows[k].push(r[k])
      console.log(
        `run ${i} ${k}: ttf ${r[k].ttf} ms; toolkit ${r[k].toolkitBytes} B (${r[k].toolkitReqs} req, playwright saw ${r[k].playwrightBytes} B); third-party ${r[k].thirdBytes} B ${r[k].thirdParty.join(',')}; storage ${r[k].storage}; ran-new-toolkit ${r[k].workerHash === sha(path.join(k === 'bump' ? SDK_B : SDK_A, 'worker.js'))}`,
      )
    }
  }
  for (const k of ['cold', 'warm', 'bump']) {
    const t = rows[k].map((r) => r.ttf)
    const b = rows[k].map((r) => r.toolkitBytes)
    console.log(`SUMMARY ${k}: ttf p50 ${p50(t)} ms max ${max(t)} ms; toolkit bytes p50 ${p50(b)} max ${max(b)}`)
  }
}

if (suite === 'preload') {
  const level = A.level ?? '0'
  const delays = String(A.delays ?? '0,5000,15000')
    .split(',')
    .map(Number)
  const n = Number(A.runs ?? 3)
  console.log(
    `# ${ICT()} server=${server} mode=${mode} preload=${level} runs=${n} load=${os
      .loadavg()
      .map((x) => x.toFixed(1))
      .join(' ')}`,
  )
  await startServer(SDK_A)
  try {
    for (const d of delays) {
      const vals = []
      for (let i = 1; i <= n; i++) {
        const profile = prof()
        const q = `${A.warm ? '' : ''}preload=${level}&frameAt=${d}`
        const url = `https://${HOST}:${PORT}/?cache=${mode}${A.query ? '&' + A.query : ''}&${q}`
        if (A.warm) await visit(profile, url) // warm the cache first
        const r = await visit(profile, url)
        fs.rmSync(profile, { recursive: true, force: true })
        vals.push(r.openToFrame)
        console.log(
          `preload=${level} frame opens ${d} ms after page, run ${i}: open->first frame ${r.openToFrame} ms (page->first frame ${r.ttf} ms)`,
        )
      }
      console.log(`SUMMARY preload=${level} delay=${d}: open->frame p50 ${p50(vals)} ms max ${max(vals)} ms`)
    }
  } finally {
    stopServer()
  }
}

// step 6: what the viewer sees after the cache is cleared or evicted. One persistent profile per scenario.
//   node check.mjs evict --server s2b --mode sw --query mirror=1
async function chrome(profile, fn) {
  const ctx = await chromium.launchPersistentContext(profile, { executablePath: CHROME })
  try {
    const page = ctx.pages()[0] ?? (await ctx.newPage())
    await page.goto(`https://${HOST}:${PORT}/src.json`) // any same-origin document: Cache Storage API and CDP Storage need an origin
    return await fn(page, await ctx.newCDPSession(page))
  } finally {
    await ctx.close()
  }
}
if (suite === 'evict') {
  console.log(
    `# ${ICT()} server=${server} mode=${mode} load=${os
      .loadavg()
      .map((x) => x.toFixed(1))
      .join(' ')}`,
  )
  const origin = `https://${HOST}:${PORT}`
  const line = (label, r) =>
    console.log(
      `${label}: ttf ${r.ttf} ms; toolkit ${r.toolkitBytes} B in ${r.toolkitReqs} req; cache entries ${r.cacheEntries}; storage ${mb(r.storage)}`,
    )
  const on = (x) => !A.only || String(A.only).includes(x) // --only D,E runs those scenarios (A always runs first: it fills the profile)
  await startServer(SDK_A)
  try {
    // A. baseline
    let profile = prof()
    const onlyE = A.only === 'E' // E uses its own profile: skip A
    const cold = onlyE ? { cacheEntries: 0, toolkitBytes: 0 } : await visit(profile, rootUrl())
    if (!onlyE) {
      line('A cold', cold)
      const warm = await visit(profile, rootUrl())
      line('A warm', warm)
      check('A warm visit downloads nothing', warm.toolkitBytes === 0, mb(warm.toolkitBytes))
    }
    if (on('B')) {
      // B. Cache Storage cleared (the user hit "clear site data" for cache only; the service worker stays registered)
      await chrome(profile, (_p, cdp) =>
        cdp.send('Storage.clearDataForOrigin', { origin, storageTypes: 'cache_storage' }),
      )
      const b1 = await visit(profile, rootUrl())
      line('B after Cache Storage cleared', b1)
      check('B page still reaches a first frame', b1.ttf !== null)
      check(
        'B refilled the cache (entries back)',
        b1.cacheEntries === cold.cacheEntries,
        `${b1.cacheEntries} vs ${cold.cacheEntries}`,
      )
      const b2 = await visit(profile, rootUrl())
      line('B next visit', b2)
      check('B next visit is warm again', b2.toolkitBytes === 0, mb(b2.toolkitBytes))
    }
    if (on('C')) {
      // C. all site data cleared, service worker unregistered
      await chrome(profile, (_p, cdp) => cdp.send('Storage.clearDataForOrigin', { origin, storageTypes: 'all' }))
      const c1 = await visit(profile, rootUrl())
      line('C after all site data cleared', c1)
      check('C page still reaches a first frame', c1.ttf !== null)
      const c2 = await visit(profile, rootUrl())
      line('C next visit', c2)
      check('C next visit is warm again', c2.toolkitBytes === 0, mb(c2.toolkitBytes))
    }
    if (on('D')) {
      // D. partial eviction: the browser drops some entries (here every canvaskit and assets entry)
      const dropped = await chrome(profile, (page) =>
        page.evaluate(async () => {
          let n = 0
          for (const k of await caches.keys()) {
            if (!k.startsWith('toolkit-') || k === 'toolkit-meta') continue
            const c = await caches.open(k)
            for (const r of await c.keys()) {
              if (!/\/sdks\/(canvaskit|assets)\//.test(r.url)) continue
              if (await c.delete(r)) n++
            }
          }
          return n
        }),
      )
      const d1 = await visit(profile, rootUrl())
      line(`D after ${dropped} entries evicted`, d1)
      check('D page still reaches a first frame', d1.ttf !== null)
      check(
        'D only the evicted files download',
        d1.toolkitBytes > 0 && d1.toolkitBytes < cold.toolkitBytes,
        mb(d1.toolkitBytes),
      )
      const d2 = await visit(profile, rootUrl())
      check('D next visit is warm again', d2.toolkitBytes === 0, mb(d2.toolkitBytes))
    }
    fs.rmSync(profile, { recursive: true, force: true })
    if (on('E')) {
      // E. quota smaller than the toolkit (100 MB against ~250 MB): cache.put throws QuotaExceededError
      const quota = 100e6
      profile = prof()
      const e1 = await visit(profile, rootUrl(), { quota, timeout: 240000 }).catch((e) => ({
        ttf: null,
        err: String(e).split('\n')[0],
        toolkitBytes: 0,
        toolkitReqs: 0,
        cacheEntries: 0,
        storage: 0,
      }))
      line(`E quota ${quota / 1e6} MB, first visit`, e1)
      if (e1.err) console.log(`E error: ${e1.err}`)
      check('E page still reaches a first frame when the cache is full', e1.ttf !== null)
      const e2 = await visit(profile, rootUrl(), { quota, timeout: 240000 }).catch((e) => ({
        ttf: null,
        err: String(e).split('\n')[0],
        toolkitBytes: 0,
        toolkitReqs: 0,
        cacheEntries: 0,
        storage: 0,
      }))
      line(`E quota ${quota / 1e6} MB, second visit`, e2)
      check('E second visit reaches a first frame', e2.ttf !== null)
      fs.rmSync(profile, { recursive: true, force: true })
    }
  } finally {
    stopServer()
  }
  process.exit(fails ? 1 : 0)
}
