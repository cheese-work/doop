// S2 slot check, run first (test-first). usage: S2_URL=<page url> node check.mjs   (run.sh sets S2_URL)
// Claims: the harness reports a slot that follows the Rive screen node, and the pixels agree: the probe ring that sits
// at the slot edge is visible on all four sides of the bezel cutout, with the same thickness left/right and top/bottom.
import fs from 'node:fs'
import { open, waitMsg } from '../harness/lib.mjs'
import { measurer } from './measure.mjs'

const DPR = 2
const BLOB = process.env.BLOB_DIR ?? '/mnt/ssd2/scratch/che-7353/blob'
const url = `${process.env.S2_URL}&probe=1`
const { browser, page, logs } = await open(url, { viewport: { width: 600, height: 1000 }, dpr: DPR })
const results = []
const check = (name, ok, detail) => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ' | ' + detail}`)
}
try {
  const ready = await waitMsg(page, 'doop:flutter-ready', Number(process.env.WAIT ?? 240000))
  console.log('ready:', JSON.stringify(ready))
  const spec = JSON.parse(fs.readFileSync(`${BLOB}/shell.json`, 'utf8'))
  check('harness is doop_harness', ready.harness === 'doop', ready.harness)
  check('slot reported', !!ready.slot, JSON.stringify(ready.slot))
  check('slot follows the Rive node (Component lookup)', ready.tracked === true, String(ready.tracked))
  const want = ready.page && {
    x: (ready.page.w - spec.artboard.w) / 2 + spec.screen.x,
    y: (ready.page.h - spec.artboard.h) / 2 + spec.screen.y,
  }
  if (ready.slot) {
    check(
      'slot origin = artboard centre + screen node',
      Math.abs(ready.slot.x - want.x) < 0.01 && Math.abs(ready.slot.y - want.y) < 0.01,
      `got ${ready.slot.x},${ready.slot.y} want ${want.x},${want.y}`,
    )
    check(
      'slot size = screen artboard size',
      Math.abs(ready.slot.w - spec.screen.w) < 0.01 && Math.abs(ready.slot.h - spec.screen.h) < 0.01,
      `${ready.slot.w}x${ready.slot.h}`,
    )
  }
  await page.waitForTimeout(2000)
  const png = await page.locator('iframe').first().screenshot()
  const m = await measurer(browser)
  const r = await m.ring(png, DPR)
  console.log('ring:', JSON.stringify({ h: r.h, v: r.v, size: [r.width, r.height] }))
  check('probe ring visible on all four sides', !!r.h && !!r.v, r.h && r.v ? 'yes' : 'no ring pixels')
  if (r.h && r.v && want) {
    const t = (a0, a1) => a1 - a0
    const dx = (t(r.h.a0, r.h.a1) - t(r.h.b0, r.h.b1)) / 2
    const dy = (t(r.v.a0, r.v.a1) - t(r.v.b0, r.v.b1)) / 2
    console.log(
      `ring thickness px: left ${t(r.h.a0, r.h.a1)} right ${t(r.h.b0, r.h.b1)} top ${t(r.v.a0, r.v.a1)} bottom ${t(r.v.b0, r.v.b1)} (4 pt = ${4 * DPR} px)`,
    )
    // the ring's outer edges must sit on the bezel cutout: artboard centre + screen node, at the page's device pixels
    const edge = { l: r.h.a0, r: r.h.b1, t: r.v.a0, b: r.v.b1 }
    const wantPx = {
      l: want.x * DPR,
      r: (want.x + spec.screen.w) * DPR,
      t: want.y * DPR,
      b: (want.y + spec.screen.h) * DPR,
    }
    for (const k of ['l', 'r', 't', 'b'])
      check(
        `ring edge ${k} on the cutout edge`,
        Math.abs(edge[k] - wantPx[k]) <= 1,
        `got ${edge[k]} want ${wantPx[k].toFixed(1)} device px`,
      )
    check('ring centred in the cutout, x', Math.abs(dx) <= 1, `${dx} device px`)
    check('ring centred in the cutout, y', Math.abs(dy) <= 1, `${dy} device px`)
  }
  if (process.env.PNG) fs.writeFileSync(process.env.PNG, png)
} catch (e) {
  check('page reached ready', false, e.message)
  console.log(logs.slice(-8).join('\n'))
}
console.log(
  'page state:',
  await page
    .evaluate(() => JSON.stringify({ error: window.s1b?.error, console: window.s1b?.console?.slice(-8) }))
    .catch(() => 'n/a'),
)
await browser.close()
const failed = results.filter((x) => !x).length
console.log(`s2 check: ${failed ? 'RED' : 'GREEN'} (${results.length - failed}/${results.length} pass)`)
process.exitCode = failed ? 1 : 0
