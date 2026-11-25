// Edit-loop timing: save a Dart file -> watcher -> reload -> visible frame. N runs, prints every value.
// usage: node timing.mjs <url> <dartFile> <runs>   needs the dev server + watcher already running
import fs from 'node:fs'
import { open, waitMsg } from './lib.mjs'
const [url, file, n = '20'] = process.argv.slice(2)
const { browser, page } = await open(url)
const vals = []
try {
  await waitMsg(page, 'doop:flutter-ready', 60000)
  const src = fs.readFileSync(file, 'utf8')
  for (let i = 1; i <= Number(n); i++) {
    const idx = await page.evaluate(() => window.__msgs.length)
    const t0 = Date.now()
    fs.writeFileSync(file, src.replace(/kBuildStamp = '[^']*'/, `kBuildStamp = 'run-${i}'`))
    const m = await waitMsg(page, 'doop:flutter-frame', 15000, idx)
    if (m.stamp !== `run-${i}`) throw new Error(`stamp ${m.stamp} != run-${i}`)
    vals.push(m.ts - t0)
    console.log(`run ${i}: ${m.ts - t0} ms`)
    await new Promise((r) => setTimeout(r, 1500))
  }
  fs.writeFileSync(file, src)
  vals.sort((a, b) => a - b)
  console.log(`n=${vals.length} p50=${vals[Math.floor((vals.length - 1) / 2)]} max=${vals.at(-1)}`)
  if (vals.length !== Number(n)) process.exitCode = 1
} catch (e) {
  console.log('TIMING FAILED:', e.message)
  process.exitCode = 1
} finally {
  await browser.close()
}
