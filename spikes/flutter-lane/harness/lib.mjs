import { chromium } from 'playwright-core'
import os from 'node:os'

export const CHROME = process.env.CHROME ?? `${os.homedir()}/.cache/ms-playwright/chromium-1254/chrome-linux64/chrome`

/** Open `url` in headless Chrome. Every window.postMessage that reaches the OUTER page lands in window.__msgs. */
export async function open(url, { args = [], viewport = { width: 390, height: 844 }, dpr = 3 } = {}) {
  const browser = await chromium.launch({ executablePath: CHROME, args })
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: dpr, ignoreHTTPSErrors: false })
  await ctx.addInitScript(() => {
    if (window.top !== window) return
    window.__msgs = []
    // the player rule (PrototypePlayer.tsx:527-528): only the frame iframe's own window counts
    window.addEventListener('message', (e) => {
      let fi = e.source === window ? -1 : -2
      // fi: DOM position of the <iframe> whose own window sent it (the player rule), -1 = self (top-level)
      // (window.frames[] order is NOT DOM order after an iframe is replaced)
      const els = document.querySelectorAll('iframe')
      for (let i = 0; i < els.length; i++) if (els[i].contentWindow === e.source) fi = i
      if (fi !== -2 && e.data && typeof e.data.type === 'string' && e.data.type.startsWith('doop:flutter'))
        window.__msgs.push({ ...e.data, fi, rx: Date.now() })
    })
  })
  const page = await ctx.newPage()
  const logs = []
  page.on('console', (m) => logs.push(`${m.type()}: ${m.text()}`))
  page.on('requestfailed', (r) => logs.push(`requestfailed: ${r.url()} ${r.failure()?.errorText}`))
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  return { browser, ctx, page, logs }
}

export async function waitMsg(page, type, timeout = 30000, afterIdx = 0) {
  const h = await page.waitForFunction(
    ([t, i]) => window.__msgs.slice(i).find((m) => m.type === t) ?? false,
    [type, afterIdx],
    { timeout },
  )
  return h.jsonValue()
}
