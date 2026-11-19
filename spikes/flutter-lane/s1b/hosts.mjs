// Every request origin a page makes (step 2: nothing off the tailnet host). usage: node hosts.mjs <url> <doop:flutter-* type> [wait ms]
import { open, waitMsg } from '../harness/lib.mjs'
const [url, type, w] = process.argv.slice(2)
const { browser, page, ctx } = await open('about:blank', { viewport: { width: 1250, height: 900 }, dpr: 1 })
const seen = new Map()
ctx.on('request', (r) => {
  const u = new URL(r.url())
  if (u.protocol === 'data:' || u.protocol === 'blob:') return
  const k = u.origin + ' ' + u.pathname.split('/').slice(0, 3).join('/')
  seen.set(k, (seen.get(k) ?? 0) + 1)
})
await page.goto(url)
await waitMsg(page, type, Number(w ?? 240000))
await page.waitForTimeout(3000)
for (const [k, v] of [...seen].sort()) console.log(v, k)
console.log('origins:', [...new Set([...seen.keys()].map((k) => k.split(' ')[0]))].join(', '))
await browser.close()
