import { chromium } from 'playwright-core'
import os from 'node:os'
const CHROME = `${os.homedir()}/.cache/ms-playwright/chromium-1254/chrome-linux64/chrome`
const b = await chromium.launch({ executablePath: CHROME })
const page = await (await b.newContext()).newPage()
page.on('console', (m) => console.log('console', m.text().slice(0, 300)))
page.on('requestfailed', (r) => console.log('FAILED', r.url(), r.failure()?.errorText))
page.on(
  'response',
  (r) => /mirror|pub\.dev/.test(r.url()) && console.log(r.status(), r.url().replace(/.*ts.net:\d+/, '')),
)
await page.goto(process.argv[2], { waitUntil: 'commit' })
await page
  .waitForFunction(() => window.s1b?.ready || window.s1b?.error, null, { timeout: 90000 })
  .catch(() => console.log('TIMEOUT'))
console.log(await page.evaluate(() => document.getElementById('log').textContent.slice(-900)))
await b.close()
