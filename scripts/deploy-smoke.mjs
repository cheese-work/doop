// Contract smoke suite for the deploy train (CHE-5474 S4c, C-8.5c): one read and one write per route group
// in deploy/cd/smoke-routes.json, against a running doop. The compat job runs it from the candidate image,
// on the sandbox network, against the predecessor on the migrated clone. Health 200 and every call passing
// are required. Run it only against a sandbox: it signs up a throwaway user and writes.
//
//   SMOKE_BASE_URL=http://app:4400 [SMOKE_ORIGIN=http://localhost] node scripts/deploy-smoke.mjs
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitHealthy({ baseUrl, fetchImpl, sleep, deadlineMs }) {
  const until = Date.now() + deadlineMs
  let last = 'no answer'
  for (;;) {
    try {
      const res = await fetchImpl(`${baseUrl}/healthz`)
      if (res.status === 200) return { ok: true }
      last = `status ${res.status}`
    } catch (e) {
      last = e.message
    }
    if (Date.now() >= until) return { ok: false, reason: `health never answered 200 (${last})` }
    await sleep(1000)
  }
}

const cookieHeader = (res) =>
  (res.headers.getSetCookie?.() ?? [])
    .map((c) => c.split(';')[0])
    .filter(Boolean)
    .join('; ')

function fill(template, saved) {
  let missing
  const out = template.replace(/\{(\w+)\}/g, (_, name) => {
    if (saved[name] === undefined) missing = name
    return encodeURIComponent(String(saved[name] ?? ''))
  })
  return { path: out, missing }
}

export async function runSmoke({
  baseUrl,
  origin = 'http://localhost',
  routes,
  fetchImpl = fetch,
  sleep = delay,
  healthDeadlineMs = 120_000,
}) {
  const results = []
  const failed = []
  const health = await waitHealthy({ baseUrl, fetchImpl, sleep, deadlineMs: healthDeadlineMs })
  if (!health.ok) {
    failed.push({ group: '/healthz', kind: 'read', error: health.reason })
    return { ok: false, results, failed }
  }

  // A throwaway user in the sandbox database; the clone's own accounts are never used.
  const email = `smoke-${randomBytes(6).toString('hex')}@compat.invalid`
  let cookie = ''
  try {
    const res = await fetchImpl(`${baseUrl}/api/auth/sign-up/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({ email, password: randomBytes(12).toString('hex'), name: 'Deploy Smoke' }),
    })
    cookie = cookieHeader(res)
    if (res.status !== 200 || !cookie) throw new Error(`status ${res.status}${cookie ? '' : ', no session cookie'}`)
  } catch (e) {
    failed.push({ group: '/api/auth', kind: 'write', error: `smoke user sign-up failed: ${e.message}` })
    return { ok: false, results, failed }
  }

  const saved = {}
  for (const g of routes.groups) {
    // a write that saves a value (a created id) runs first, so the read can use it
    for (const kind of g.write?.save ? ['write', 'read'] : ['read', 'write']) {
      const call = g[kind]
      const row = { group: g.group, kind, method: call?.method, path: call?.path }
      let status
      let error
      try {
        if (!call) throw new Error(`group has no ${kind}`)
        const { path: url, missing } = fill(call.path, saved)
        if (missing) throw new Error(`needs a captured value "${missing}" that was never saved`)
        row.path = url
        const headers = { origin }
        if (call.auth !== false) headers.cookie = cookie
        if (call.body !== undefined) headers['content-type'] = 'application/json'
        const res = await fetchImpl(`${baseUrl}${url}`, {
          method: call.method,
          headers,
          body: call.body === undefined ? undefined : JSON.stringify(call.body),
          redirect: 'manual',
        })
        status = res.status
        if (call.save && (call.expect ?? [200]).includes(status)) {
          const json = await res.json().catch(() => ({}))
          for (const [name, field] of Object.entries(call.save)) saved[name] = json?.[field]
        }
        if (!(call.expect ?? [200]).includes(status))
          error = `status ${status}, expected ${(call.expect ?? [200]).join('/')}`
      } catch (e) {
        error = e.message
      }
      const ok = error === undefined
      results.push({ ...row, status, ok })
      if (!ok) failed.push({ ...row, status, error })
    }
  }
  return { ok: failed.length === 0, results, failed }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const baseUrl = process.env.SMOKE_BASE_URL
  if (!baseUrl) {
    console.error('deploy-smoke: SMOKE_BASE_URL is required')
    process.exit(2)
  }
  const file =
    process.env.SMOKE_ROUTES ??
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'deploy', 'cd', 'smoke-routes.json')
  const out = await runSmoke({
    baseUrl,
    origin: process.env.SMOKE_ORIGIN ?? 'http://localhost',
    routes: JSON.parse(readFileSync(file, 'utf8')),
  })
  console.log(JSON.stringify(out))
  process.exit(out.ok ? 0 : 1)
}
