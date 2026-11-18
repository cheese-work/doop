// Release build in a frame form: N cold runs (fresh browser each). Prints per-run first-frame time (ms from navigation
// start, cold cache), renderer, env the embedding gave the app, and failed requests; then p50/max.
// usage: node release-check.mjs <url> [runs=5] [timeoutMs=30000] [chrome-arg ...]
import { open, waitMsg } from './lib.mjs'
const [url, runs = '5', t = '30000', ...args] = process.argv.slice(2)
const times = []
let last = ''
for (let i = 1; i <= Number(runs); i++) {
  const t0 = Date.now()
  const { browser, page, logs } = await open(url, { args })
  try {
    const m = await waitMsg(page, 'doop:flutter-ready', Number(t))
    const f = (await page.evaluate(() => window.__msgs)).find((x) => x.type === 'doop:flutter-frame')
    const ms = (f?.rx ?? m.rx) - t0
    times.push(ms)
    const { type, ts, rx, stamp, fi, ...env } = m
    last = JSON.stringify(env)
    console.log(`run ${i}: first frame ${ms} ms`)
  } catch {
    console.log(`run ${i}: NOT READY in ${t} ms`)
    const bad = logs
      .filter((l) => /requestfailed|rror/.test(l) && !/GPU stall/.test(l))
      .map((l) => l.split('\n')[0].slice(0, 230))
    console.log('  first errors:', JSON.stringify([...new Set(bad)].slice(0, 4)))
  }
  const failed = logs.filter((l) => l.startsWith('requestfailed')).length
  if (failed) console.log(`  failed requests: ${failed}`)
  await browser.close()
}
if (last) console.log('env:', last)
if (times.length) {
  const s = [...times].sort((a, b) => a - b)
  console.log(`ready ${times.length}/${runs}; p50=${s[Math.floor((s.length - 1) / 2)]} ms, max=${s.at(-1)} ms`)
} else console.log(`ready 0/${runs}`)
