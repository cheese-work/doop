// One worker, N sandboxes. Records: time until every frame is ready, which frames get each edit (and when),
// state kept in frame 0, Chrome memory (sum of RSS of this profile's processes), console errors.
// usage: node multi.mjs <url-without-n> <n> <file> [edits=5]
import fs from 'node:fs'
import { execSync } from 'node:child_process'
import { open } from '../harness/lib.mjs'
const [base, nArg, file, e = '5'] = process.argv.slice(2)
const n = Number(nArg)
const { browser, page, logs } = await open(`${base}?n=${n}`, { viewport: { width: 390 * n + 40, height: 900 }, dpr: 1 })
const src = fs.readFileSync(file, 'utf8')
const rss = () => {
  // RSS of every descendant of this node process (the Chrome this run launched)
  try {
    const rows = execSync('ps -eo pid=,ppid=,rss=')
      .toString()
      .trim()
      .split('\n')
      .map((l) => l.trim().split(/\s+/).map(Number))
    const kids = new Set([process.pid])
    let grew = true
    while (grew) {
      grew = false
      for (const [pid, ppid] of rows)
        if (kids.has(ppid) && !kids.has(pid)) {
          kids.add(pid)
          grew = true
        }
    }
    return rows.filter(([pid]) => kids.has(pid) && pid !== process.pid).reduce((a, r) => a + r[2], 0)
  } catch {
    return -1
  }
}
const msgs = () => page.evaluate(() => window.__msgs)
try {
  const t0 = Date.now()
  await page.waitForFunction(
    (k) => new Set(window.__msgs.filter((m) => m.type === 'doop:flutter-ready').map((m) => m.fi)).size >= k,
    n,
    { timeout: 240000 },
  )
  console.log(`n=${n}: all ${n} frames ready after ${Date.now() - t0} ms`)
  console.log(
    (await page.evaluate(() => document.getElementById('log').textContent))
      .split('\n')
      .filter((l) => /pub get|sandbox connected|run /.test(l))
      .map((l) => '  ' + l.slice(0, 100))
      .join('\n'),
  )
  await page.waitForTimeout(2000)
  const boxes = await page.locator('iframe').evaluateAll((els) =>
    els.map((el) => {
      const r = el.getBoundingClientRect()
      return { x: r.x, y: r.y }
    }),
  )
  for (let k = 0; k < 2; k++) {
    await page.mouse.click(boxes[0].x + 109, boxes[0].y + 323)
    await page.waitForTimeout(400)
  }
  for (let i = 1; i <= Number(e); i++) {
    const idx = (await msgs()).length
    const t = Date.now()
    fs.writeFileSync(file, src.replace(/kBuildStamp = '[^']*'/, `kBuildStamp = 'm${n}-${i}'`))
    await page.waitForTimeout(4000)
    const got = (await msgs()).slice(idx).filter((m) => m.type === 'doop:flutter-frame' && m.stamp === `m${n}-${i}`)
    const per = [...new Set(got.map((m) => m.fi))]
      .sort()
      .map(
        (fi) =>
          `f${fi}:${Math.min(...got.filter((m) => m.fi === fi).map((m) => m.ts)) - t} ms taps=${got.find((m) => m.fi === fi).taps}`,
      )
    console.log(`edit ${i}: frames reloaded ${per.length} of ${n} -> ${per.join(', ')}`)
  }
  console.log(
    'worker-side reload times (ms from write start, one entry per frame):',
    JSON.stringify(await page.evaluate(() => s1b.reloads)),
  )
  console.log(
    `memory: JS heap(page) ${((await page.evaluate(() => performance.memory.usedJSHeapSize)) / 1e6).toFixed(0)} MB; chrome processes RSS ${(rss() / 1e3).toFixed(0)} MB`,
  )
  console.log(
    'console errors:',
    logs
      .filter((l) => /^(error|requestfailed)/.test(l))
      .slice(0, 5)
      .join(' || ') || 'none',
  )
} catch (err) {
  console.log('MULTI FAILED:', err.message)
  console.log(logs.slice(-10).join('\n'))
} finally {
  fs.writeFileSync(file, src)
  await browser.close()
}
