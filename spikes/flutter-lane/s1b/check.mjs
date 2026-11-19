// S1b checks. Each prints every value. usage:
//   node check.mjs load <url> [warm]          cold (empty cache) or warm (second load, same cache) time to first Flutter frame
//   node check.mjs edit <url> <file> <runs>   new source text -> visible hot reload, every run; state kept?
// A "frame" = the doop:flutter-frame message the erus screen posts after each painted frame (see ../app/lib/bridge.dart).
import fs from 'node:fs'
import { open, waitMsg } from '../harness/lib.mjs'
const [mode, url, a, b] = process.argv.slice(2)
const W = Number(process.env.WAIT ?? 180000)
const med = (v) => [...v].sort((x, y) => x - y)[Math.floor((v.length - 1) / 2)]
const done = (ok) => {
  process.exitCode = ok ? 0 : 1
}

if (mode === 'load') {
  const warm = a === 'warm'
  const { browser, ctx, page, logs } = await open(url, { viewport: { width: 1250, height: 900 }, dpr: 1 })
  try {
    const t0 = Date.now()
    await page.goto(url)
    const m = await waitMsg(page, 'doop:flutter-frame', W)
    console.log(`cold first frame: ${m.ts - t0} ms`)
    let ok = true
    if (warm) {
      await page.close()
      const p2 = await ctx.newPage()
      await p2.addInitScript(() => {
        window.__msgs = []
      })
      const t1 = Date.now()
      await p2.goto(url)
      const m2 = await waitMsg(p2, 'doop:flutter-frame', W)
      console.log(`warm first frame: ${m2.ts - t1} ms`)
    }
    done(ok)
  } catch (e) {
    console.log('LOAD FAILED:', e.message)
    console.log(logs.slice(-15).join('\n'))
    done(false)
  } finally {
    await browser.close()
  }
} else if (mode === 'edit') {
  const { browser, page, logs } = await open(url, { viewport: { width: 1250, height: 900 }, dpr: 1 })
  const src = fs.readFileSync(a, 'utf8')
  const vals = []
  try {
    await page.goto(url)
    await waitMsg(page, 'doop:flutter-ready', W)
    await page.waitForTimeout(1500)
    const box = await page.locator('iframe').first().boundingBox()
    for (let k = 0; k < 2; k++) {
      await page.mouse.click(box.x + 109, box.y + 323)
      await page.waitForTimeout(400)
    } // state: taps=2
    for (let i = 1; i <= Number(b); i++) {
      const idx = await page.evaluate(() => window.__msgs.length)
      const t0 = Date.now()
      fs.writeFileSync(a, src.replace(/kBuildStamp = '[^']*'/, `kBuildStamp = 'run-${i}'`))
      const m = await waitMsg(page, 'doop:flutter-frame', 30000, idx)
      if (m.taps !== 2) throw new Error(`state lost: taps=${m.taps}`)
      if (m.stamp !== `run-${i}`) {
        await new Promise((r) => setTimeout(r, 1500))
        throw new Error(`stamp ${m.stamp} != run-${i}`)
      }
      vals.push(m.ts - t0)
      console.log(`run ${i}: ${m.ts - t0} ms taps=${m.taps}`)
      await page.waitForTimeout(1500)
    }
    console.log(`n=${vals.length} p50=${med(vals)} max=${Math.max(...vals)}`)
    done(vals.length === Number(b))
  } catch (e) {
    console.log('EDIT FAILED:', e.message)
    console.log(logs.slice(-15).join('\n'))
    done(false)
  } finally {
    fs.writeFileSync(a, src)
    await browser.close()
  }
} else {
  console.log('usage: see header')
  done(false)
}
