// S1b step 7 limit probes. usage: node probe.mjs <url> <font|sem|riv> [png]
// Each probe app posts one doop:flutter-probe message; this prints it plus the page state and asserts the per-kind claim.
import { open, waitMsg } from '../harness/lib.mjs'
const [url, kind, png] = process.argv.slice(2)
const W = Number(process.env.WAIT ?? 240000)
const { browser, page, logs } = await open(url, { viewport: { width: 1250, height: 900 }, dpr: 1 })
// every element with the attribute, looking through open shadow roots (Flutter puts the semantics tree in one)
const deep = (attr) => {
  const out = []
  const walk = (n) => {
    for (const e of n.querySelectorAll('*')) {
      if (e.hasAttribute(attr)) out.push(e.getAttribute(attr))
      if (e.shadowRoot) walk(e.shadowRoot)
    }
  }
  walk(document)
  return out
}
let ok = false
try {
  const m = await waitMsg(page, 'doop:flutter-probe', W)
  await page.waitForTimeout(1500)
  console.log('probe msg:', JSON.stringify(m))
  const dom = []
  for (const f of page.frames()) dom.push(...(await f.evaluate(deep, 'flt-semantics-identifier').catch(() => [])))
  console.log('flt-semantics-identifier values:', JSON.stringify(dom))
  if (png) await page.screenshot({ path: png })
  ok =
    kind === 'font'
      ? m.differs === true
      : kind === 'sem'
        ? dom.includes('doop-probe-id')
        : kind === 'riv'
          ? m.ok === true
          : false
} catch (e) {
  console.log('PROBE FAILED:', e.message)
}
console.log(
  'page state:',
  await page.evaluate(() => JSON.stringify({ error: s1b.error, console: s1b.console?.slice(-12) })).catch(() => 'n/a'),
)
if (!ok) console.log(logs.slice(-10).join('\n'))
console.log(`${kind}: ${ok ? 'PASS' : 'FAIL'}`)
await browser.close()
process.exitCode = ok ? 0 : 1
