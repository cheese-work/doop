// Print what the embedding gave the app (origin, storage, isolation, renderer) and any failed requests. usage: node env-check.mjs <url> [timeoutMs]
import { open, waitMsg } from './lib.mjs'
const [url, t = '30000'] = process.argv.slice(2)
const { browser, page, logs } = await open(url)
try {
  const m = await waitMsg(page, 'doop:flutter-ready', Number(t))
  const { type, ts, rx, stamp, ...env } = m
  console.log('READY', JSON.stringify(env))
} catch {
  console.log(
    'NOT READY',
    logs
      .filter((l) => !/DDC|Injecting/.test(l))
      .map((l) => l.split('\n')[0].slice(0, 200))
      .slice(0, 4),
  )
}
console.log('failed requests:', logs.filter((l) => l.startsWith('requestfailed')).length)
await browser.close()
