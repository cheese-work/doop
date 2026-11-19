// Wire-bytes budget for one cold first load (what crosses the network, i.e. after content-encoding).
// usage: node load-budget.mjs <url> <maxBytes> [timeoutMs]   exit 0 = within budget and ready, 1 = over budget or not ready
import { open, waitMsg } from './lib.mjs'

const [url, max, t = '300000'] = process.argv.slice(2)
if (!url || !max) throw new Error('usage: node load-budget.mjs <url> <maxBytes> [timeoutMs]')
const { browser, page, logs } = await open(url)
let wire = 0
let n = 0
page.on('requestfinished', async (req) => {
  wire += (await req.sizes()).responseBodySize
  n++
})
const t0 = Date.now()
try {
  await waitMsg(page, 'doop:flutter-ready', Number(t))
  const ms = Date.now() - t0
  await page.waitForTimeout(1500)
  console.log(`ready after ${ms} ms, ${wire} wire bytes in ${n} requests, budget ${max}`)
  if (wire > Number(max)) {
    console.log('OVER BUDGET')
    process.exitCode = 1
  } else console.log('WITHIN BUDGET')
} catch {
  console.log(`NOT READY within ${t} ms`, logs.slice(-5))
  process.exitCode = 1
} finally {
  await browser.close()
}
