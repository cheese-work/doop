// S2 drift capture: does the Flutter screen stay on the Rive cutout while the device box scales every frame?
// usage: S2_URL=<page url> [FRAMES=240] [DPR=2] [FACTORY=flutter|rive] [CHROME_ARGS='--flag --flag'] [OUT=report.json] node drift.mjs
//   (run.sh sets S2_URL). X99: CHROME_ARGS='--use-gl=angle --use-angle=vulkan --enable-features=Vulkan --ignore-gpu-blocklist
//   --enable-gpu-rasterization' puts Chrome on the RTX 3060; without it headless Chrome renders with SwiftShader (about 7 fps).
// Also runs on a MacBook: no host paths; the URL, DPR and frame count come from the environment. S3 reuses it with
// DPR/FRAMES set for a 120 Hz display (the capture rate is whatever Chrome's screencast delivers; it is reported).
//
// MODE=screencast (default): live. Chrome's screencast delivers every painted frame while the animation runs on its own
//   clock; frames are CSS-pixel sized, so edges are good to about 1 px. Reports the achieved Flutter and capture fps.
// MODE=step: lockstep. The page advances one frame per message and the script takes a lossless screenshot at DPR after each;
//   exact per frame at device-pixel precision, but not real time (it proves position, not rate).
// MODE=rate: no capture at all; only the Flutter frame rate of the animation is reported (SEM=1: with Semantics on).
//
// Method: the harness (anim=drift) scales the device box by a cosine of the frame number, one step per Flutter frame, and
// paints the frame number into the page corner as a 16-cell strip. Chrome's screencast delivers PNG frames of the page.
// For each frame the script reads the frame number, finds the outer edges of the 4 pt probe ring on the middle row and
// column, and compares them with where the cutout must be at that frame's scale (artboard centre + screen node, scaled).
// The bezel is drawn OVER the ring, so a ring that reaches past the cutout shows up as a thinner ring, and a ring that
// stops short of it as an outer edge that moved in. Both are reported in device px; the expected value is 0.
import fs from 'node:fs'
import { open, waitMsg } from '../harness/lib.mjs'
import { measurer } from './measure.mjs'

const DPR = Number(process.env.DPR ?? 2)
const FRAMES = Number(process.env.FRAMES ?? 240)
const FACTORY = process.env.FACTORY ?? 'flutter'
const VIEW = { width: 600, height: 1000 }
const MODE = process.env.MODE ?? 'screencast'
const url = `${process.env.S2_URL}&probe=1&anim=drift&frames=${FRAMES}&factory=${FACTORY}${MODE === 'step' ? '&step=1' : ''}`
const args = (process.env.CHROME_ARGS ?? '').split(' ').filter(Boolean)
const { browser, ctx, page, logs } = await open(url, { args, viewport: VIEW, dpr: DPR })
const out = { mode: MODE, factory: FACTORY, frames: FRAMES, dpr: DPR, chromeArgs: args }
try {
  const ready = await waitMsg(page, 'doop:flutter-ready', Number(process.env.WAIT ?? 400000))
  out.ready = ready
  const bb = await page.locator('iframe').first().boundingBox()
  const box = { x: bb.x, y: bb.y, w: bb.width, h: bb.height }
  const shots = []
  let clip = null // screencast frames hold the whole outer page; step screenshots are already cropped to the iframe
  let effDpr = DPR
  const mark = await page.evaluate(() => window.__msgs.length)
  const go = () =>
    page.evaluate(() => document.querySelector('iframe').contentWindow.postMessage({ type: 'doop:go' }, '*'))
  if (MODE === 'step') {
    const stepTo = async (i) => {
      await page.evaluate(() => document.querySelector('iframe').contentWindow.postMessage({ type: 'doop:step' }, '*'))
      await page.waitForFunction(
        (i) =>
          window.__msgs.some(
            (m) => (m.type === 'doop:flutter-stepped' && m.n === i) || m.type === 'doop:flutter-trace-end',
          ),
        i,
        { timeout: 60000 },
      )
    }
    const t0 = Date.now()
    shots.push({ data: (await page.screenshot({ clip: bb })).toString('base64'), t: 0 })
    for (let i = 1; i <= FRAMES; i++) {
      await stepTo(i)
      shots.push({ data: (await page.screenshot({ clip: bb })).toString('base64'), t: (Date.now() - t0) / 1000 })
    }
  } else if (MODE === 'rate') {
    if (process.env.SEM === '1') {
      // SEM=1: switch Flutter's Semantics tree on first (the first doop:nodes request does it), to price it per frame
      await page.evaluate(() => document.querySelector('iframe').contentWindow.postMessage({ type: 'doop:nodes' }, '*'))
      await page.waitForTimeout(2000)
    }
    await go()
    await waitMsg(page, 'doop:flutter-trace-end', Math.max(60000, FRAMES * 1000), mark)
  } else {
    const cdp = await ctx.newCDPSession(page)
    cdp.on('Page.screencastFrame', (f) => {
      shots.push({ data: f.data, t: f.metadata.timestamp })
      cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {})
    })
    await cdp.send('Page.startScreencast', {
      format: 'png',
      maxWidth: Math.round(VIEW.width * DPR),
      maxHeight: Math.round(VIEW.height * DPR),
      everyNthFrame: 1,
    })
    await go()
    await waitMsg(page, 'doop:flutter-trace-end', Math.max(60000, FRAMES * 1000), mark)
    await cdp.send('Page.stopScreencast')
    clip = box
  }
  if (MODE === 'step') await waitMsg(page, 'doop:flutter-trace-end', 60000, mark)
  const rows = (await page.evaluate(() => window.__msgs.filter((m) => m.type === 'doop:flutter-trace')))
    .sort((a, b) => a.from - b.from)
    .flatMap((m) => m.rows)
  out.trace = { rows: rows.length }
  if (rows.length > 1 && MODE !== 'step') {
    const ms = rows.at(-1)[5] - rows[0][5]
    out.trace.flutterFps = +(((rows.length - 1) / ms) * 1000).toFixed(1)
  }
  if (MODE === 'rate') {
    console.log(
      JSON.stringify({ mode: MODE, factory: FACTORY, chromeArgs: args, renderer: ready.renderer, trace: out.trace }),
    )
    if (process.env.OUT) fs.writeFileSync(process.env.OUT, JSON.stringify(out) + '\n')
    await browser.close()
    process.exit(0)
  }
  if (process.env.SAVE_SHOTS) {
    // SAVE_SHOTS='0,120,200' SHOT_DIR=dir : keep those captured frames (index in capture order) as PNG files
    fs.mkdirSync(process.env.SHOT_DIR ?? '.', { recursive: true })
    for (const i of process.env.SAVE_SHOTS.split(',').map(Number))
      if (shots[i])
        fs.writeFileSync(
          `${process.env.SHOT_DIR ?? '.'}/drift-${MODE}-${FACTORY}-${i}.png`,
          Buffer.from(shots[i].data, 'base64'),
        )
  }
  const first = Buffer.from(shots[0].data, 'base64')
  out.capture = { shots: shots.length, pngPx: [first.readUInt32BE(16), first.readUInt32BE(20)] }
  if (MODE === 'screencast') {
    // Chrome's screencast frames are CSS-pixel sized whatever the DPR: measure at that scale, so the quantum is 1 CSS px
    effDpr = out.capture.pngPx[0] / VIEW.width
    out.capture.fps = +((shots.length - 1) / (shots.at(-1).t - shots[0].t) || 0).toFixed(1)
  }
  out.capture.effDpr = effDpr

  const spec = ready.spec
  const W = ready.page.w
  const H = ready.page.h
  const m = await measurer(browser)
  const byId = new Map()
  let noRing = 0
  for (const s of shots) {
    const r = await m.ring(Buffer.from(s.data, 'base64'), effDpr, clip)
    if (!r.h || !r.v) {
      noRing++
      continue
    }
    if (!byId.has(r.frame)) byId.set(r.frame, { r, t: s.t })
  }
  const traceBy = new Map(rows.map((row) => [row[0], row]))
  const per = []
  for (const [id, { r }] of [...byId].sort((a, b) => a[0] - b[0])) {
    const row = traceBy.get(id)
    if (!row) continue
    const s = row[1]
    const left = (W - spec.aw * s) / 2 + s * spec.sx
    const top = (H - spec.ah * s) / 2 + s * spec.sy
    const want = {
      l: left * effDpr,
      r: (left + s * spec.sw) * effDpr,
      t: top * effDpr,
      b: (top + s * spec.sh) * effDpr,
    }
    const th = 4 * s * effDpr
    per.push({
      frame: id,
      scale: +s.toFixed(4),
      // signed device px, measured minus expected
      edge: { l: r.h.a0 - want.l, r: r.h.b1 - want.r, t: r.v.a0 - want.t, b: r.v.b1 - want.b },
      // translation = both opposite edges moving the same way (what drift is); a pixel-threshold loss moves them apart
      trans: { x: (r.h.a0 - want.l + r.h.b1 - want.r) / 2, y: (r.v.a0 - want.t + r.v.b1 - want.b) / 2 },
      thick: { l: r.h.a1 - r.h.a0 - th, r: r.h.b1 - r.h.b0 - th, t: r.v.a1 - r.v.a0 - th, b: r.v.b1 - r.v.b0 - th },
      // the slot the harness read from the Rive node, against the same expectation, in CSS px
      trace: { l: row[2] - left, t: row[3] - top, w: row[4] - s * spec.sw },
    })
  }
  out.matched = per.length
  out.unique = byId.size
  out.noRing = noRing
  if (noRing) console.log('frames without a ring:', noRing, '\npage console tail:\n' + logs.slice(-12).join('\n'))
  out.missingIds = FRAMES - per.length
  const hist = (get) => {
    const h = {}
    for (const p of per) for (const v of Object.values(get(p))) h[Math.round(v)] = (h[Math.round(v)] ?? 0) + 1
    return h
  }
  out.edgeHistogramPx = hist((p) => p.edge)
  out.thickHistogramPx = hist((p) => p.thick)
  const th1 = (get) => {
    const h = {}
    for (const p of per)
      for (const v of Object.values(get(p)))
        h[(Math.round(v * 10) / 10).toFixed(1)] = (h[(Math.round(v * 10) / 10).toFixed(1)] ?? 0) + 1
    return h
  }
  out.transHistogramPx = th1((p) => p.trans)
  out.maxAbsTransPx = Math.max(0, ...per.flatMap((p) => Object.values(p.trans).map(Math.abs)))
  out.maxAbsEdgePx = Math.max(0, ...per.flatMap((p) => Object.values(p.edge).map(Math.abs)))
  out.maxAbsThickPx = Math.max(0, ...per.flatMap((p) => Object.values(p.thick).map(Math.abs)))
  out.maxAbsTraceCss = Math.max(0, ...per.flatMap((p) => Object.values(p.trace).map(Math.abs)))
  // bounds: translation 0.5 px; edge and thickness errors of the colour threshold (64 % coverage) reach 0.64 px per edge
  out.offenders = per.filter(
    (p) =>
      Math.abs(p.trans.x) > 0.5 || Math.abs(p.trans.y) > 0.5 || Object.values(p.thick).some((v) => Math.abs(v) > 1.5),
  )
  out.per = per
  console.log(JSON.stringify({ ...out, per: undefined, offenders: out.offenders.slice(0, 40) }, null, 1))
  console.log(
    `offenders (translation > 0.5 px or thickness error > 1.5 px): ${out.offenders.length} of ${per.length} matched frames`,
  )
  if (process.env.OUT) fs.writeFileSync(process.env.OUT, JSON.stringify(out) + '\n')
} catch (e) {
  console.log('drift failed:', e.message)
  console.log(logs.slice(-8).join('\n'))
  process.exitCode = 1
}
await browser.close()
