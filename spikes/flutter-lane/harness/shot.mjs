// Agent screenshot: headless Chrome loads the URL, waits for doop:flutter-ready, writes a PNG. usage: node shot.mjs <url> <out.png>
import { open, waitMsg } from './lib.mjs'
const [url, out] = process.argv.slice(2)
const { browser, page } = await open(url)
const t0 = Date.now()
await waitMsg(page, 'doop:flutter-ready', 60000)
await page.waitForTimeout(500)
await page.screenshot({ path: out })
console.log(`screenshot ${out} ${Date.now() - t0} ms after load`)
await browser.close()
