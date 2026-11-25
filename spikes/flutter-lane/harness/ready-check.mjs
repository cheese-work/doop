// Ready-signal check: the OUTER page must receive doop:flutter-ready after the app's first frame.
// usage: node ready-check.mjs <url> [timeoutMs]   exit 0 = ready, 1 = not ready
import { open, waitMsg } from './lib.mjs'
const [url, t = '30000'] = process.argv.slice(2)
const { browser, page, logs } = await open(url)
const t0 = Date.now()
try {
  const m = await waitMsg(page, 'doop:flutter-ready', Number(t))
  console.log(`READY after ${m.rx - t0} ms (renderer=${m.renderer})`)
} catch {
  console.log(`NOT READY within ${t} ms`, logs.slice(-5))
  process.exitCode = 1
} finally {
  await browser.close()
}
