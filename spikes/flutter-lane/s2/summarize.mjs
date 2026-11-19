// usage: node summarize.mjs report.json ...   one line per drift.mjs report
import fs from 'node:fs'
for (const f of process.argv.slice(2)) {
  const o = JSON.parse(fs.readFileSync(f, 'utf8'))
  const r2 = (v) => (v === undefined ? v : +v.toFixed(2))
  console.log(
    JSON.stringify({
      mode: o.mode,
      factory: o.factory,
      renderer: o.ready?.renderer,
      chrome: o.chromeArgs?.length ? 'gpu-flags' : 'default',
      trace: o.trace,
      capture: o.capture,
      matched: o.matched,
      noRing: o.noRing,
      maxAbsTransPx: r2(o.maxAbsTransPx),
      maxAbsEdgePx: r2(o.maxAbsEdgePx),
      maxAbsThickPx: r2(o.maxAbsThickPx),
      maxAbsTraceCss: o.maxAbsTraceCss,
      offenders: o.offenders?.length,
      trans: o.transHistogramPx,
    }),
  )
}
