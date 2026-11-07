import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import express from 'express'
import type { Browser, Page } from 'puppeteer-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { serveClient } from '../server/clientStatic.ts'
import { findBrowserPath, getBrowser } from '../server/screenshot'

/* the real public/sw.js + offline.html behind the real serveClient, in a real Chromium */
describe.skipIf(!findBrowserPath())('service worker offline fallback', { timeout: 60_000 }, () => {
  let dist: string
  let server: http.Server
  let base: string
  /* page.setOfflineMode does not reach the worker's own fetch, so drop connections at the server */
  let networkDown = false
  let browser: Browser
  let page: Page

  beforeAll(async () => {
    dist = fs.mkdtempSync(path.join(os.tmpdir(), 'doop-sw-'))
    fs.copyFileSync('public/sw.js', path.join(dist, 'sw.js'))
    fs.copyFileSync('public/offline.html', path.join(dist, 'offline.html'))
    fs.writeFileSync(
      path.join(dist, 'index.html'),
      '<html><body><h1 id="app">app</h1><script>navigator.serviceWorker.register("/sw.js")</script></body></html>',
    )
    const app = express()
    app.use((req, _res, next) => (networkDown ? req.socket.destroy() : next()))
    serveClient(app, dist)
    server = http.createServer(app)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    browser = await getBrowser()
    page = await browser.newPage()
  })

  afterAll(async () => {
    await page?.close()
    server?.close()
    fs.rmSync(dist, { recursive: true, force: true })
  })

  it('serves the app online and the offline page with the network off', async () => {
    await page.goto(`${base}/c/abc`)
    expect(await page.$eval('#app', (el) => el.textContent)).toBe('app')
    await page.evaluate(() => navigator.serviceWorker.ready)
    /* first load is not controlled until clients.claim(); reload so the worker handles navigations */
    await page.reload()
    await page.evaluate(() => navigator.serviceWorker.ready)

    networkDown = true
    await page.goto(`${base}/c/abc`).catch(() => undefined)
    expect(await page.$eval('h1', (el) => el.textContent)).toBe("You're offline")
    if (process.env.SW_SCREENSHOT) await page.screenshot({ path: process.env.SW_SCREENSHOT })

    networkDown = false
    await page.goto(`${base}/c/abc`)
    expect(await page.$eval('#app', (el) => el.textContent)).toBe('app')
  })

  it('caches only the offline page', async () => {
    const urls = await page.evaluate(async () => {
      const out: string[] = []
      for (const name of await caches.keys()) for (const r of await (await caches.open(name)).keys()) out.push(r.url)
      return out
    })
    expect(urls).toEqual([`${base}/offline.html`])
  })
})
