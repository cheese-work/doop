// Cross-check of the message-based timing: poll real screenshots of the colour band until its pixels change.
// usage: node pixel-check.mjs <url> <dartFile> <runs>
import fs from 'node:fs'
import { open, waitMsg } from './lib.mjs'
const [url, file, n = '5'] = process.argv.slice(2)
const { browser, page } = await open(url)
const clip = { x: 345 - 14, y: 20, width: 20, height: 20 } // the 28 px stamp band, top right (css px)
const src = fs.readFileSync(file, 'utf8')
const snap = async () => (await page.screenshot({ clip })).toString('base64')
try {
  await waitMsg(page, 'doop:flutter-ready', 60000)
  await page.waitForTimeout(800)
  let prev = await snap()
  for (let i = 1; i <= Number(n); i++) {
    const idx = await page.evaluate(() => window.__msgs.length)
    const t0 = Date.now()
    fs.writeFileSync(file, src.replace(/kBuildStamp = '[^']*'/, `kBuildStamp = 'px-${i}'`))
    let cur = prev,
      tPix = 0
    while (Date.now() - t0 < 10000) {
      cur = await snap()
      if (cur !== prev) {
        tPix = Date.now() - t0
        break
      }
    }
    const m = await waitMsg(page, 'doop:flutter-frame', 5000, idx)
    console.log(`run ${i}: pixels changed at ${tPix} ms, post-frame message at ${m.ts - t0} ms`)
    prev = cur
    await page.waitForTimeout(1200)
  }
} finally {
  fs.writeFileSync(file, src)
  await browser.close()
}
