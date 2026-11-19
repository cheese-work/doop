// S2 step 7, run first (test-first): real mouse and keyboard reach the live Home through the Rive shell, with the device scaled.
// usage: S2_URL=<page url> node input.mjs   (run.sh sets S2_URL)   env SCALE (default 0.9), PNG (screenshot path)
// Claims: (1) the harness scales the device box (flag scale=) and the slot follows; (2) a mouse click at the Add button's
// scaled position, found through the Semantics tree, reaches the button (taps counted, bridge event arrives);
// (3) a click on the Note field focuses it and typed text, including a non-ASCII insert, arrives in the field.
import fs from 'node:fs'
import { open, waitMsg } from '../harness/lib.mjs'

const SCALE = Number(process.env.SCALE ?? 0.9)
const BLOB = process.env.BLOB_DIR ?? '/mnt/ssd2/scratch/che-7353/blob'
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
  dpr: 2,
})
const results = []
const check = (name, ok, detail) => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ' | ' + detail}`)
}
const msgs = (type) => page.evaluate((t) => window.__msgs.filter((m) => m.type === t), type)
const waitCount = (type, n) =>
  page.waitForFunction(([t, k]) => window.__msgs.filter((m) => m.type === t).length >= k, [type, n], { timeout: 15000 })
try {
  const ready = await waitMsg(page, 'doop:flutter-ready', Number(process.env.WAIT ?? 240000))
  const spec = JSON.parse(fs.readFileSync(`${BLOB}/shell.json`, 'utf8'))
  console.log('ready slot:', JSON.stringify(ready.slot), 'page:', JSON.stringify(ready.page))
  const k = SCALE
  check(
    'slot scaled with the device box',
    Math.abs(ready.slot.w - spec.screen.w * k) < 0.5,
    `slot w ${ready.slot.w} want ${(spec.screen.w * k).toFixed(1)}`,
  )

  const fr = page.frames().find((f) => f !== page.mainFrame())
  const box = await page.locator('iframe').first().boundingBox()
  // turn the Semantics tree on (Flutter web builds it only when asked), then read the rects of the three Home widgets
  const sem = await fr.evaluate(async () => {
    document.querySelector('flt-semantics-placeholder')?.click()
    await new Promise((r) => setTimeout(r, 1500))
    const rect = (el) => {
      const r = el.getBoundingClientRect()
      return { x: r.x, y: r.y, w: r.width, h: r.height }
    }
    const byId = (id) => document.querySelector(`[flt-semantics-identifier="${id}"]`)
    const out = {}
    for (const id of ['erus-net-worth', 'erus-add', 'erus-recent']) out[id] = byId(id) ? rect(byId(id)) : null
    const note = document.querySelector('input[data-semantics-role="text-field"][aria-label="Note"]')?.parentElement
    out.note = note ? rect(note) : null
    return out
  })
  console.log('semantics rects (iframe px):', JSON.stringify(sem))
  const add = sem['erus-add']
  check('Semantics reports the Add button', !!add, JSON.stringify(add))
  // natural Add width is 94.6 px at scale 1 (measured with scale=1): the scaled one must be k times that
  if (add)
    check(
      'Add button rect is scaled by the device box',
      Math.abs(add.w - 94.6 * k) < 1.5,
      `w ${add.w.toFixed(1)} want ${(94.6 * k).toFixed(1)}`,
    )
  if (add) {
    const at = { x: box.x + add.x + add.w / 2, y: box.y + add.y + add.h / 2 }
    for (let i = 1; i <= 2; i++) {
      await page.mouse.click(at.x, at.y)
      await waitCount('doop:flutter-tap', i).catch(() => {})
      const taps = await msgs('doop:flutter-tap')
      check(
        `mouse click ${i} on Add reaches the button`,
        taps.length === i && taps.at(-1).taps === i,
        `events ${taps.length}, last ${JSON.stringify(taps.at(-1))}`,
      )
    }
  }
  const note = sem.note
  check('Semantics reports the Note field', !!note, JSON.stringify(note))
  if (note) {
    await page.mouse.click(box.x + note.x + note.w / 2, box.y + note.y + note.h / 2)
    await page.waitForTimeout(500)
    await page.keyboard.type('hello 123', { delay: 30 })
    await page.keyboard.insertText(' đồng')
    await page.waitForTimeout(800)
    const texts = await msgs('doop:flutter-text')
    check(
      'typed text arrives, ASCII then non-ASCII',
      texts.at(-1)?.value === 'hello 123 đồng',
      JSON.stringify(texts.at(-1)),
    )
  }
  await page.waitForTimeout(500)
  if (process.env.PNG) fs.writeFileSync(process.env.PNG, await page.screenshot())
} catch (e) {
  check('input flow completed', false, e.message)
  console.log(logs.slice(-8).join('\n'))
}
await browser.close()
const failed = results.filter((x) => !x).length
console.log(`s2 input: ${failed ? 'RED' : 'GREEN'} (${results.length - failed}/${results.length} pass)`)
process.exitCode = failed ? 1 : 0
