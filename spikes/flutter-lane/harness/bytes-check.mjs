// Bytes the browser downloads for one cold first load of a release build (uncompressed: static.ts sends no gzip/brotli).
// usage: node bytes-check.mjs <url>
import { open, waitMsg } from './lib.mjs'

const [url] = process.argv.slice(2)
const { browser, page } = await open(url)
const rows = []
page.on('requestfinished', async (req) => {
  const size = (await req.sizes()).responseBodySize
  rows.push({ name: new URL(req.url()).pathname, size })
})
await waitMsg(page, 'doop:flutter-ready', 30000)
await page.waitForTimeout(1500)
rows.sort((a, b) => b.size - a.size)
for (const r of rows.slice(0, 6)) console.log(`${String(r.size).padStart(9)}  ${r.name}`)
console.log(`${String(rows.reduce((n, r) => n + r.size, 0)).padStart(9)}  TOTAL (${rows.length} requests)`)
await browser.close()
