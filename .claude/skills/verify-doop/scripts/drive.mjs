#!/usr/bin/env node
// Drive one doop feature in a real browser against a launch.sh run.
// Usage: drive.mjs <run-dir> <feature> <evidence-dir>   feature: auth | canvas | pages
// Writes <feature>-*.png and <feature>.json (every step, pass or fail) into the evidence dir. Exit 1 if a check fails.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import puppeteer from 'puppeteer-core'

const [run, feature, evidence] = process.argv.slice(2)
const features = { auth, canvas, pages }
if (!run || !features[feature] || !evidence) {
  console.error('usage: drive.mjs <run-dir> <auth|canvas|pages> <evidence-dir>')
  process.exit(2)
}
mkdirSync(evidence, { recursive: true })
const origin = `http://localhost:${readFileSync(join(run, 'port'), 'utf8').trim()}`
const steps = []
const step = (name, pass, detail = '') => {
  steps.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`)
  return pass
}
const executablePath = process.env.CHROME_PATH || '/usr/bin/google-chrome'
const browser = await puppeteer.launch({
  executablePath,
  headless: true,
  args: process.env.CHROME_NO_SANDBOX ? ['--no-sandbox', '--disable-setuid-sandbox'] : [],
})
const page = await browser.newPage()
await page.setViewport({ width: 1440, height: 900 })
const shot = (name) => page.screenshot({ path: join(evidence, `${feature}-${name}.png`) })
// A fresh user per run: the database is empty anyway, the suffix only keeps repeat drives on one run apart.
const user = { name: 'Verify Doop', email: `verify-${Date.now()}@example.test`, password: 'verify-doop-pw-123' }
const post = (path, body) =>
  page.evaluate(
    async (p, b) => {
      const r = await fetch(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) })
      return { status: r.status, body: await r.json().catch(() => null) }
    },
    path,
    body,
  )

async function signUp() {
  await page.goto(`${origin}/`, { waitUntil: 'networkidle0' })
  const r = await post('/api/auth/sign-up/email', user)
  return step('sign up through the auth API', r.status === 200, `status ${r.status}`)
}

async function auth() {
  if (!(await signUp())) return
  const me = await page.evaluate(() => fetch('/api/me').then((r) => r.json()))
  step('/api/me returns the new account', me?.user?.email === user.email || me?.email === user.email, JSON.stringify(me).slice(0, 120))
  await page.goto(`${origin}/`, { waitUntil: 'networkidle0' })
  await shot('signed-in-home')
}

async function openCanvas() {
  if (!(await signUp())) return null
  const made = await post('/api/canvases', { name: 'verify-doop canvas' })
  if (!step('create a canvas through the API', made.status === 200 && !!made.body?.id, `status ${made.status}`)) return null
  await page.goto(`${origin}/c/${made.body.id}`, { waitUntil: 'networkidle0' })
  const ready = await page
    .waitForSelector('[data-slot="frame-section-heading"]', { timeout: 30000 })
    .then(() => true, () => false)
  step('editor chrome renders (Layers heading)', ready)
  return ready ? made.body.id : null
}

async function canvas() {
  const id = await openCanvas()
  if (!id) return
  const hasPage = await page.$('[data-page-id]')
  step('the new canvas has a first page', !!hasPage)
  await shot('editor')
}

async function pages() {
  const id = await openCanvas()
  if (!id) return
  const count = () => page.$$eval('[data-page-id]', (els) => els.length)
  const before = await count()
  await shot('before')
  await page.click('button[aria-label="Add page"]')
  const grew = await page
    .waitForFunction((n) => document.querySelectorAll('[data-page-id]').length === n + 1, { timeout: 15000 }, before)
    .then(() => true, () => false)
  step('Add page adds one page row', grew, `${before} -> ${await count()}`)
  await shot('after-add')
  await page.reload({ waitUntil: 'networkidle0' })
  await page.waitForSelector('[data-page-id]', { timeout: 30000 })
  step('the added page survives a reload', (await count()) === before + 1, `after reload: ${await count()}`)
  await shot('after-reload')
}

try {
  await features[feature]()
} catch (error) {
  step('drive finished without an exception', false, String(error?.stack ?? error).slice(0, 400))
} finally {
  await browser.close()
  writeFileSync(join(evidence, `${feature}.json`), JSON.stringify({ feature, origin, steps }, null, 2))
}
process.exit(steps.length > 0 && steps.every((s) => s.pass) ? 0 : 1)
