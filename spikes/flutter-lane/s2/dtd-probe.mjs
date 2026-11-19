// S2 step 8 (DTD): does the in-browser DartPad build expose anything the widget inspector / Dart Tooling Daemon can attach to?
// Looks for a VM-service or DWDS hook on the sandbox window, and for debug-only inspector entry points; prints what it finds.
import { open, waitMsg } from '../harness/lib.mjs'
const { browser, page } = await open(process.env.S2_URL, { viewport: { width: 600, height: 1000 }, dpr: 1 })
await waitMsg(page, 'doop:flutter-ready', 240000)
const fr = page.frames().find((x) => x !== page.mainFrame())
const r = await fr.evaluate(() => ({
  windowKeys: Object.getOwnPropertyNames(window).filter((k) =>
    /dwds|devtools|vmservice|vm_service|dtd|inspector|\$dart(Debug|Runtime)|dartDevEmbedder|flutterDebug/i.test(k),
  ),
  hasDevEmbedder: typeof window.dartDevEmbedder,
  hasDevtoolsExt: typeof window.$dartDevToolsExtensions,
  location: location.protocol + '//' + location.host,
}))
console.log(JSON.stringify(r))
await browser.close()
