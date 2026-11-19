// List every non-X99 URL a page visit requests (full URLs). usage: node urls.mjs <url> [settle ms]
import { chromium } from 'playwright-core'
import os from 'node:os'
const CHROME = process.env.CHROME ?? `${os.homedir()}/.cache/ms-playwright/chromium-1254/chrome-linux64/chrome`
const [url, settle = '8000'] = process.argv.slice(2)
const b = await chromium.launch({ executablePath: CHROME })
const ctx = await b.newContext()
const seen = new Set()
ctx.on('request', (r) => {
  const u = new URL(r.url())
  if (/^https?:$/.test(u.protocol) && !u.hostname.includes('ts.net')) seen.add(r.method() + ' ' + r.url())
})
const page = await ctx.newPage()
await page.goto(url, { waitUntil: 'commit' })
await page.waitForFunction(() => window.s1b?.ready || window.s1b?.error, null, { timeout: 240000 })
await page.waitForTimeout(Number(settle))
for (const u of [...seen].sort()) console.log(u)
await b.close()
