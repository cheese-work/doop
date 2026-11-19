// The ?edit=1 box: type a new kBuildStamp into the textarea, the frame must show it. usage: node typeedit.mjs <url-with-edit=1>
import { open, waitMsg } from '../harness/lib.mjs'
const { browser, page } = await open(process.argv[2], { viewport: { width: 1250, height: 900 }, dpr: 1 })
try {
  await waitMsg(page, 'doop:flutter-ready', 180000); await page.waitForTimeout(1500)
  const idx = await page.evaluate(() => window.__msgs.length)
  const t0 = Date.now()
  await page.locator('#ed').evaluate((el) => { el.value = el.value.replace(/kBuildStamp = '[^']*'/, "kBuildStamp = 'typed-1'"); el.dispatchEvent(new Event('input')) })
  const m = await waitMsg(page, 'doop:flutter-frame', 30000, idx)
  console.log(`typed edit -> frame stamp=${m.stamp} in ${m.ts - t0} ms; status bar: ${await page.locator('#st').textContent()}`)
  process.exitCode = m.stamp === 'typed-1' ? 0 : 1
} catch (e) { console.log('TYPEEDIT FAILED:', e.message); process.exitCode = 1 }
await browser.close()
