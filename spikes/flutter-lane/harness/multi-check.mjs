// Concurrent instances: N iframes of the same dev app. Records ready count, which instances get a hot reload,
// state after hot reload vs after remount, WebGL-context errors.   usage: node multi-check.mjs <multi url> <n>
import fs from 'node:fs'
import { open } from './lib.mjs'
const [url, nArg = '3', file = '../app/lib/main.dart'] = process.argv.slice(2)
const n = Number(nArg)
const { browser, page, logs } = await open(url, {
  viewport: n > 3 ? { width: 1200, height: 900 } : { width: 390 * n, height: 844 },
})
const src = fs.readFileSync(file, 'utf8')
const wait = (ms) => page.waitForTimeout(ms)
const msgs = () => page.evaluate(() => window.__msgs)
try {
  await (async () => {
    const t0 = Date.now()
    await page
      .waitForFunction(
        (k) => new Set(window.__msgs.filter((m) => m.type === 'doop:flutter-ready').map((m) => m.fi)).size >= k,
        n,
        { timeout: 40000 },
      )
      .catch(() => {})
    const ready = new Set((await msgs()).filter((m) => m.type === 'doop:flutter-ready').map((m) => m.fi))
    console.log(`ready: ${ready.size} of ${n} instances [${[...ready].sort()}] after ${Date.now() - t0} ms`)
    console.log(
      `failed script requests (ERR_INSUFFICIENT_RESOURCES): ${logs.filter((l) => l.startsWith('requestfailed') && /INSUFFICIENT/.test(l)).length}`,
    )
    const glErr = logs.filter((l) => /Too many active WebGL|context lost|CONTEXT_LOST/i.test(l)).length
    console.log(`WebGL context-limit messages in console ("Too many active WebGL contexts" / lost): ${glErr}`)
    const glLines = [
      ...new Set(
        logs.filter((l) => /Too many active WebGL|context lost|CONTEXT_LOST/i.test(l)).map((l) => l.slice(0, 160)),
      ),
    ]
    for (const l of glLines) console.log(`  console: ${l}`)
    if (n > 3) return
    const last = async (fi) => (await msgs()).filter((m) => m.type === 'doop:flutter-frame' && m.fi === fi).at(-1)
    const save = async (stamp) => {
      const idx = (await msgs()).length
      fs.writeFileSync(file, src.replace(/kBuildStamp = '[^']*'/, `kBuildStamp = '${stamp}'`))
      await wait(7000)
      const got = (await msgs()).slice(idx).filter((m) => m.type === 'doop:flutter-frame' && m.stamp === stamp)
      return [...new Set(got.map((m) => m.fi))].sort()
    }
    await wait(1000)
    for (let i = 0; i < 2; i++) {
      await page.mouse.click(109, 317)
      await wait(400)
    }
    console.log(`instance 0 taps before save: ${(await last(0))?.taps}`)
    console.log(`save 1 -> hot reload delivered to instances [${await save('multi-1')}] of 0..${n - 1}`)
    const t1 = await last(0)
    console.log(`instance 0 after save 1: stamp=${t1?.stamp} taps=${t1?.taps}`)
    const idx = (await msgs()).length
    const tr = Date.now()
    await page.evaluate(() => window.remount(0))
    await page
      .waitForFunction((i) => window.__msgs.slice(i).some((m) => m.type === 'doop:flutter-frame' && m.fi === 0), idx, {
        timeout: 40000,
      })
      .catch(() => {})
    const re = (await msgs()).slice(idx).find((m) => m.type === 'doop:flutter-frame' && m.fi === 0)
    console.log(
      `instance 0 REMOUNT: first frame ${re ? Date.now() - tr : 'none in 40000'} ms, taps=${re?.taps} stamp=${re?.stamp} (state gone; code = current)`,
    )
    console.log(`save 2 -> hot reload delivered to instances [${await save('multi-2')}] (after remount of 0)`)
  })()
} finally {
  fs.writeFileSync(file, src)
  await browser.close()
}
