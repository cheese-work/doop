// Contract smoke suite for the deploy train (CHE-5474 S4c, C-8.5c): an ordered chain of calls per route group
// in deploy/cd/smoke-routes.json (real writes that are read back; `contract` calls for routes that need an
// outside service, which may name the body for each allowed status in `expectByStatus`; `noWrite` states why a group has no write), against a running doop. The compat job runs it from the candidate image,
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

/** Substitute {name} in every string of a body or header set; the value goes in as is, not URL-encoded. */
function fillDeep(value, saved, state) {
  if (typeof value === 'string')
    return value.replace(/\{(\w+)\}/g, (_, name) => {
      if (saved[name] === undefined) state.missing = name
      return String(saved[name] ?? '')
    })
  if (Array.isArray(value)) return value.map((v) => fillDeep(v, saved, state))
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fillDeep(v, saved, state)]))
  return value
}

/** "pages.0.id" on a parsed JSON body. */
const dig = (json, dotted) =>
  String(dotted)
    .split('.')
    .reduce((v, k) => (v == null ? undefined : v[k]), json)

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
  const password = randomBytes(12).toString('hex')
  let cookie = ''
  try {
    const res = await fetchImpl(`${baseUrl}/api/auth/sign-up/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({ email, password, name: 'Deploy Smoke' }),
    })
    cookie = cookieHeader(res)
    if (res.status !== 200 || !cookie) throw new Error(`status ${res.status}${cookie ? '' : ', no session cookie'}`)
  } catch (e) {
    failed.push({ group: '/api/auth', kind: 'write', error: `smoke user sign-up failed: ${e.message}` })
    return { ok: false, results, failed }
  }

  const saved = { email, password }
  for (const g of routes.groups) {
    const calls = g.calls ?? []
    const kinds = new Set(calls.map((c) => c.kind))
    if (!kinds.has('read') && !kinds.has('contract'))
      failed.push({ group: g.group, kind: 'read', error: 'group has no read' })
    if (!kinds.has('write') && !g.noWrite)
      failed.push({ group: g.group, kind: 'write', error: 'group has no write and no noWrite reason' })
    for (const call of calls) {
      const row = { group: g.group, kind: call.kind, method: call.method, path: call.path }
      let status
      let error
      try {
        const { path: url, missing } = fill(call.path, saved)
        const state = { missing }
        const body = call.body === undefined ? undefined : fillDeep(call.body, saved, state)
        const extra = call.headers === undefined ? {} : fillDeep(call.headers, saved, state)
        const byStatus = call.expectByStatus
        let want = call.expectJson === undefined ? undefined : fillDeep(call.expectJson, saved, state)
        if (state.missing) throw new Error(`needs a captured value "${state.missing}" that was never saved`)
        row.path = url
        const headers = { origin, ...extra }
        if (call.auth !== false) headers.cookie = cookie
        if (body !== undefined) headers['content-type'] = 'application/json'
        const res = await fetchImpl(`${baseUrl}${url}`, {
          method: call.method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          redirect: 'manual',
        })
        status = res.status
        // `expectByStatus`: each allowed status names the body that goes with it (a feature that is on or off).
        const expect = byStatus ? Object.keys(byStatus).map(Number) : (call.expect ?? [200])
        if (byStatus && expect.includes(status)) want = fillDeep(byStatus[String(status)], saved, state)
        if (!expect.includes(status)) error = `status ${status}, expected ${expect.join('/')}`
        else if (call.save || want) {
          const json = await res.json().catch(() => undefined)
          for (const [name, field] of Object.entries(call.save ?? {})) {
            saved[name] = dig(json, field)
            if (saved[name] === undefined) error = `response has no "${field}" to save as ${name}`
          }
          for (const [field, value] of Object.entries(want ?? {})) {
            if (String(dig(json, field)) !== String(value))
              error = `${field} is ${JSON.stringify(dig(json, field))}, expected ${JSON.stringify(value)}`
          }
        }
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
