import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type ViteDevServer } from 'vite'
import type { Browser, Page } from 'puppeteer-core'
import { findBrowserPath, getBrowser } from '../server/screenshot'
import type { Frame } from '../shared/types'

/* the shared elementPanel fixture; typed here because other browser tests declare the same global differently */
type Harness = {
  seed(frame: Frame): void
  selectFrame(): void
  unselectFrame(): void
  setMounted(mounted: boolean): void
}
type HarnessWindow = { elementPanelHarness: Harness }

describe.skipIf(!findBrowserPath())('culling a frame that is being edited', () => {
  let vite: ViteDevServer
  let browser: Browser
  let page: Page
  let saved: Frame
  beforeAll(async () => {
    vite = await createServer({ server: { port: 0 }, logLevel: 'error' })
    await vite.listen()
    browser = await getBrowser()
    page = await browser.newPage()
    await page.setViewport({ width: 1000, height: 900 })
    await page.setRequestInterception(true)
    page.on('request', async (request) => {
      if (new URL(request.url()).pathname === '/api/frames/f' && request.method() === 'PATCH') {
        saved = { ...saved, ...JSON.parse(request.postData()!) }
        await request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(saved) })
      } else await request.continue()
    })
    await page.goto(`${vite.resolvedUrls!.local[0]}tests/fixtures/elementPanel.html`)
    await page.waitForFunction(() => !!(window as unknown as Partial<HarnessWindow>).elementPanelHarness)
  }, 60_000)
  afterAll(async () => {
    await page?.close()
    await browser?.close()
    await vite?.close()
  })

  it('saves the typed text when the frame is deselected and culled before the 400 ms debounce', async () => {
    saved = {
      id: 'f',
      canvasId: 'c',
      name: 'Culled edit',
      x: 0,
      y: 0,
      width: 600,
      height: 400,
      createdAt: 0,
      updatedAt: 0,
      updatedBy: 'Tester',
      html: '<!doctype html><html><body><p id="target" style="margin:50px;width:200px">Edit me</p></body></html>',
    }
    await page.evaluate((frame) => (window as unknown as HarnessWindow).elementPanelHarness.seed(frame), saved)
    const iframe = await page.waitForSelector('iframe')
    const frame = (await iframe!.contentFrame())!
    await frame.waitForSelector('#target')
    await page.evaluate(() => (window as unknown as HarnessWindow).elementPanelHarness.selectFrame())
    const box = (await (await frame.$('#target'))!.boundingBox())!
    await page.mouse.click(box.x + 20, box.y + 8, { count: 2, delay: 60 })
    await frame.waitForSelector('style[data-v-edit]')
    await frame.click('#target')
    await frame.waitForSelector('#target[contenteditable]')
    await page.keyboard.type(' FINAL')
    // Inside the debounce: the runtime has not posted the text yet.
    await page.evaluate(() => {
      const harness = (window as unknown as HarnessWindow).elementPanelHarness
      harness.unselectFrame()
      harness.setMounted(false)
    })
    await expect.poll(() => saved.html).toContain('FINAL')

    // Coming back remounts the iframe with the saved text.
    await page.evaluate(() => (window as unknown as HarnessWindow).elementPanelHarness.setMounted(true))
    const back = (await (await page.waitForSelector('iframe'))!.contentFrame())!
    await back.waitForFunction(() => document.querySelector('#target')?.textContent?.includes('FINAL'))
  }, 30_000)
})
