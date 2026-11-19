// Cold then warm load in ONE persistent Chrome profile (real HTTP disk cache across two browser launches).
// Prints per load: first-frame ms, bytes over the wire, requests served from cache, the page's phase log.
// usage: node wire.mjs <url> <profileDir>
import { chromium } from '../harness/node_modules/playwright-core/index.mjs'
import fs from 'node:fs'
import { CHROME } from '../harness/lib.mjs'
const [url, dir] = process.argv.slice(2)
fs.rmSync(dir, { recursive: true, force: true })
for (const label of ['cold', 'warm']) {
  const ctx = await chromium.launchPersistentContext(dir, {
    executablePath: CHROME,
    viewport: { width: 1250, height: 900 },
  })
  const page = ctx.pages()[0] ?? (await ctx.newPage())
  const cdp = await ctx.newCDPSession(page)
  await cdp.send('Network.enable')
  let wire = 0,
    cached = 0,
    reqs = 0
  const seen = new Map()
  cdp.on('Network.responseReceived', (e) => seen.set(e.requestId, e.response))
  cdp.on('Network.loadingFinished', (e) => {
    reqs++
    wire += e.encodedDataLength
    const r = seen.get(e.requestId)
    if (r && (r.fromDiskCache || r.fromPrefetchCache)) cached++
  })
  await page.addInitScript(() => {
    window.__first = null
    addEventListener('message', (e) => {
      if (e.data?.type === 'doop:flutter-frame' && !window.__first) window.__first = Date.now()
    })
  })
  const t0 = Date.now()
  await page.goto(url)
  await page.waitForFunction(() => window.__first, null, { timeout: 180000 })
  const first = await page.evaluate(() => window.__first)
  console.log(
    `${label}: first frame ${first - t0} ms; wire ${(wire / 1e6).toFixed(1)} MB in ${reqs} requests; ${cached} from disk cache`,
  )
  console.log(
    (await page.evaluate(() => document.getElementById('log').textContent))
      .split('\n')
      .filter((l) => /worker session|pub get|sandbox connected|run /.test(l))
      .map((l) => '  ' + l.slice(0, 110))
      .join('\n'),
  )
  await ctx.close()
}
