// State kept across hot reload: tap the button 2x, save a Dart edit, the next frame must still say taps=2.
// usage: node state-check.mjs <url> <dartFile>
import fs from 'node:fs'
import { open, waitMsg } from './lib.mjs'
const [url, file] = process.argv.slice(2)
const { browser, page } = await open(url)
const src = fs.readFileSync(file, 'utf8')
try {
  await waitMsg(page, 'doop:flutter-ready', 60000)
  await page.waitForTimeout(500)
  for (let i = 0; i < 2; i++) {
    await page.mouse.click(109, 317)
    await page.waitForTimeout(400)
  }
  const before = await page.evaluate(() => window.__msgs.at(-1))
  const idx = await page.evaluate(() => window.__msgs.length)
  fs.writeFileSync(file, src.replace(/kBuildStamp = '[^']*'/, `kBuildStamp = 'state-check'`))
  const m = await waitMsg(page, 'doop:flutter-frame', 15000, idx)
  console.log(`before taps=${before.taps} stamp=${before.stamp}; after reload taps=${m.taps} stamp=${m.stamp}`)
  if (m.taps !== 2 || m.stamp !== 'state-check') process.exitCode = 1
} finally {
  fs.writeFileSync(file, src)
  await browser.close()
}
