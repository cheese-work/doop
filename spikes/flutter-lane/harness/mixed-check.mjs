// Mixed content with Chrome's stock policy: HTTPS outer page, iframe + scripts over HTTP. (Playwright's default switches are dropped.)
// usage: node mixed-check.mjs <outer https url>
import { chromium } from 'playwright-core'
import { CHROME } from './lib.mjs'
const browser = await chromium.launch({
  executablePath: CHROME,
  ignoreDefaultArgs: true,
  args: [
    '--headless=new',
    '--no-sandbox',
    '--remote-debugging-pipe',
    '--user-data-dir=/mnt/ssd2/scratch/che-7352/mixed-profile',
  ],
})
const page = await browser.newPage()
const logs = []
page.on('console', (m) => logs.push(m.text().slice(0, 240)))
await page.addInitScript(() => {
  window.__t = []
  window.addEventListener('message', (e) => window.__t.push(e.data?.type))
})
await page.goto(process.argv[2], { waitUntil: 'commit' })
await page.waitForTimeout(8000)
console.log(
  logs
    .filter((l) => /mixed/i.test(l))
    .slice(0, 3)
    .join('\n') || 'no mixed-content message',
)
console.log(
  'messages that reached the outer page:',
  JSON.stringify(await page.evaluate(() => window.__t.filter(Boolean))),
)
console.log(
  'frames:',
  page.frames().map((f) => f.url().slice(0, 70)),
)
await browser.close()
