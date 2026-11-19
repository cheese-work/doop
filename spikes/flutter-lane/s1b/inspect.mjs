// Open the page, wait for the first frame, print the page log + worker state, save a screenshot. usage: node inspect.mjs <url> <png> [n]
import { open, waitMsg } from '../harness/lib.mjs'
const [url, png] = process.argv.slice(2)
const { browser, page, logs } = await open(url, { viewport: { width: 1250, height: 900 }, dpr: 1 })
try {
  const m = await waitMsg(page, 'doop:flutter-ready', 120000)
  await page.waitForTimeout(2000)
  console.log('ready msg:', JSON.stringify(m))
  console.log(await page.evaluate(() => document.getElementById('log').textContent))
  console.log('state:', await page.evaluate(() => JSON.stringify({ version: s1b.version, pubGetMs: s1b.pubGetMs, error: s1b.error, console: s1b.console?.slice(0, 10) })))
  await page.screenshot({ path: png })
} catch (e) { console.log('FAILED', e.message); console.log(await page.evaluate(() => document.getElementById('log').textContent).catch(() => '')); console.log(logs.slice(-20).join('\n')) }
finally { await browser.close() }
