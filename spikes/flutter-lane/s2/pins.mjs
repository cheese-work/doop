/* global createImageBitmap, fetch, OffscreenCanvas */
// S2 step 8, run first (test-first): the Semantics / node-annotation probe.
// usage: S2_URL=<page url> node pins.mjs   env SCALE (default 0.9), SHOTS=<dir> to keep screenshots
// Claims: (1) the harness answers a `doop:nodes` message with {id, rect} for each Home widget that carries
// Semantics(identifier:), rects in product points (402 x 874 screen space, scale-free); (2) the outer page maps a rect through
// the slot (slot origin + k * rect, k = slot scale) to a pin over the iframe, and the pin sits within 1 pt of the PAINTED
// pixels of the Add button, at rest and after the list scrolls; (3) the answer costs how long per call (record it).
import fs from 'node:fs'
import { open, waitMsg } from '../harness/lib.mjs'

const SCALE = Number(process.env.SCALE ?? 0.9)
const DPR = 2
const GPU = [
  '--use-gl=angle',
  '--use-angle=vulkan',
  '--enable-features=Vulkan',
  '--ignore-gpu-blocklist',
  '--enable-gpu-rasterization',
]
const { browser, page, logs } = await open(`${process.env.S2_URL}&scale=${SCALE}`, {
  args: GPU,
  viewport: { width: 600, height: 1000 },
  dpr: DPR,
})
const results = []
const check = (name, ok, detail) => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ' | ' + detail}`)
}
const ask = async () => {
  const idx = await page.evaluate(() => {
    const i = window.__msgs.length
    document.querySelector('iframe').contentWindow.postMessage({ type: 'doop:nodes' }, '*')
    return i
  })
  return waitMsg(page, 'doop:flutter-nodes', 8000, idx)
}
// bounding box (CSS px of the screenshot) of pixels near the colour sampled just inside `r`, searched in `r` grown by 6 px
const painted = (png, r) =>
  page.evaluate(
    async ([b64, r, dpr]) => {
      const bmp = await createImageBitmap(await (await fetch('data:image/png;base64,' + b64)).blob())
      const g = new OffscreenCanvas(bmp.width, bmp.height).getContext('2d', { willReadFrequently: true })
      g.drawImage(bmp, 0, 0)
      const px = (x, y) => g.getImageData(Math.round(x * dpr), Math.round(y * dpr), 1, 1).data
      const c = px(r.x + 8, r.y + r.h / 2)
      const near = (d) => Math.abs(d[0] - c[0]) + Math.abs(d[1] - c[1]) + Math.abs(d[2] - c[2]) < 40
      const pad = 6
      const x0 = Math.round((r.x - pad) * dpr),
        y0 = Math.round((r.y - pad) * dpr)
      const w = Math.round((r.w + 2 * pad) * dpr),
        h = Math.round((r.h + 2 * pad) * dpr)
      const { data } = g.getImageData(x0, y0, w, h)
      let minx = 1e9,
        miny = 1e9,
        maxx = -1,
        maxy = -1
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4
          if (near([data[i], data[i + 1], data[i + 2]])) {
            minx = Math.min(minx, x)
            maxx = Math.max(maxx, x)
            miny = Math.min(miny, y)
            maxy = Math.max(maxy, y)
          }
        }
      return {
        colour: Array.from(c.slice(0, 3)),
        x: (x0 + minx) / dpr,
        y: (y0 + miny) / dpr,
        w: (maxx - minx + 1) / dpr,
        h: (maxy - miny + 1) / dpr,
      }
    },
    [png.toString('base64'), r, DPR],
  )
const pinRect = (n, box) => ({
  x: box.x + n.slot.x + n.k * n.node.rect.x,
  y: box.y + n.slot.y + n.k * n.node.rect.y,
  w: n.k * n.node.rect.w,
  h: n.k * n.node.rect.h,
})
const maxDelta = (a, b) =>
  Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.x + a.w - b.x - b.w), Math.abs(a.y + a.h - b.y - b.h))
try {
  await waitMsg(page, 'doop:flutter-ready', Number(process.env.WAIT ?? 240000))
  const box = await page.locator('iframe').first().boundingBox()
  await ask() // first call switches Semantics on
  await page.waitForTimeout(1500)
  const times = []
  let m = null
  for (let i = 0; i < 20; i++) {
    m = await ask()
    times.push(m.ms)
  }
  const ids = (m.nodes ?? []).map((n) => n.id).sort()
  check(
    'nodes message lists the three Home identifiers',
    JSON.stringify(ids) === JSON.stringify(['erus-add', 'erus-net-worth', 'erus-recent']),
    JSON.stringify(ids),
  )
  times.sort((a, b) => a - b)
  console.log(
    `annotation cost per call: median ${times[10].toFixed(2)} ms, max ${times[19].toFixed(2)} ms, ${m.nodes.length} nodes`,
  )
  const at = (nodes, id) => ({ node: nodes.find((n) => n.id === id), slot: m.slot, k: m.k })
  for (const phase of ['rest', 'scrolled']) {
    if (phase === 'scrolled') {
      await page.mouse.move(box.x + m.slot.x + 150, box.y + m.slot.y + 300)
      await page.mouse.wheel(0, 120)
      await page.waitForTimeout(1200)
      m = await ask()
    }
    const png = await page.screenshot()
    const pin = pinRect(at(m.nodes, 'erus-add'), box)
    const px = await painted(png, pin)
    const d = maxDelta(pin, px)
    console.log(
      `${phase}: pin ${JSON.stringify(pin)} painted ${JSON.stringify({ x: px.x, y: px.y, w: px.w, h: px.h })} colour ${px.colour}`,
    )
    check(`${phase}: Add pin within 1 pt of the painted button`, d <= 1, `max edge delta ${d.toFixed(2)} pt`)
    if (process.env.SHOTS) {
      await page.evaluate((p) => {
        document.querySelectorAll('.doop-pin').forEach((e) => e.remove())
        const el = document.createElement('div')
        el.className = 'doop-pin'
        el.style.cssText = `position:fixed;left:${p.x}px;top:${p.y}px;width:${p.w}px;height:${p.h}px;outline:2px solid #00e5ff;pointer-events:none;z-index:99`
        document.body.append(el)
      }, pin)
      fs.writeFileSync(`${process.env.SHOTS}/pin-${phase}.png`, await page.screenshot())
    }
    if (phase === 'rest') globalThis.restRect = m.nodes.find((n) => n.id === 'erus-add').rect
    else
      check(
        'scroll moved the node (rect changed)',
        Math.abs(globalThis.restRect.y - m.nodes.find((n) => n.id === 'erus-add').rect.y) > 20,
        `y ${globalThis.restRect.y.toFixed(1)} -> ${m.nodes.find((n) => n.id === 'erus-add').rect.y.toFixed(1)} pt`,
      )
  }
} catch (e) {
  check('probe completed', false, e.message)
  console.log(logs.slice(-8).join('\n'))
}
await browser.close()
const failed = results.filter((x) => !x).length
console.log(`s2 pins: ${failed ? 'RED' : 'GREEN'} (${results.length - failed}/${results.length} pass)`)
process.exitCode = failed ? 1 : 0
