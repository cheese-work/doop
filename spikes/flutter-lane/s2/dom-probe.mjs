// S2 steps 4-5 evidence: what the page holds under each Rive factory (canvases, WebGL contexts, platform views).
// usage: S2_URL=<page url> FACTORY=flutter|rive node dom-probe.mjs
import { open, waitMsg } from '../harness/lib.mjs'
const GPU = [
  '--use-gl=angle',
  '--use-angle=vulkan',
  '--enable-features=Vulkan',
  '--ignore-gpu-blocklist',
  '--enable-gpu-rasterization',
]
const f = process.env.FACTORY ?? 'flutter'
const { browser, page } = await open(`${process.env.S2_URL}&factory=${f}`, {
  args: GPU,
  viewport: { width: 600, height: 1000 },
  dpr: 2,
})
const ready = await waitMsg(page, 'doop:flutter-ready', 240000)
await page.waitForTimeout(2000)
const fr = page.frames().find((x) => x !== page.mainFrame())
const dom = await fr.evaluate(() => {
  const cv = [...document.querySelectorAll('canvas')].map((c) => ({
    w: c.width,
    h: c.height,
    parent: c.parentElement?.tagName,
    style: c.getAttribute('style')?.slice(0, 60),
  }))
  const gl = new OffscreenCanvas(1, 1).getContext('webgl2')
  const ext = gl?.getExtension('WEBGL_debug_renderer_info')
  return {
    canvases: cv,
    flutterView: !!document.querySelector('flutter-view'),
    platformViews: document.querySelectorAll('flt-platform-view, flt-platform-view-slot').length,
    sceneHost: !!document.querySelector('flt-scene-host'),
    glRenderer: gl && ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null,
  }
})
console.log(JSON.stringify({ factory: f, renderer: ready.renderer, tracked: ready.tracked, ...dom }))
await browser.close()
