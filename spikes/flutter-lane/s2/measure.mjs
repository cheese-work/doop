// Pixel measurements on a PNG of the S2 frame. Decoding runs in a helper browser page, so no image library is needed.
// ring: the magenta probe ring (harness flag probe=1) along the middle row and middle column of the screenshot.
// id:   the frame number the harness paints into the page corner (16 cells of 6 logical px, white = 1).
export async function measurer(browser) {
  const page = await browser.newPage()
  await page.setContent('<!doctype html><title>measure</title>')
  // clip: {x, y, w, h} in CSS px of the PNG; measure only that part (a screencast frame holds the whole outer page)
  const run = (png, dpr, what, clip) =>
    page.evaluate(
      async ([b64, dpr, what, clip]) => {
        const bmp = await createImageBitmap(
          await (await fetch('data:image/' + (b64.startsWith('/9j') ? 'jpeg' : 'png') + ';base64,' + b64)).blob(),
        )
        const cw = clip ? Math.round(clip.w * dpr) : bmp.width
        const ch = clip ? Math.round(clip.h * dpr) : bmp.height
        const g = new OffscreenCanvas(cw, ch).getContext('2d', { willReadFrequently: true })
        g.drawImage(bmp, clip ? -Math.round(clip.x * dpr) : 0, clip ? -Math.round(clip.y * dpr) : 0)
        const { data, width, height } = g.getImageData(0, 0, cw, ch)
        const at = (x, y) => {
          const i = (y * width + x) * 4
          return [data[i], data[i + 1], data[i + 2]]
        }
        const mag = ([r, gr, b]) => r > 170 && gr < 90 && b > 170
        const idOf = () => {
          let n = 0
          for (let i = 0; i < 16; i++) if (at(Math.round((6 * i + 3) * dpr), Math.round(3 * dpr))[0] > 128) n |= 1 << i
          return n
        }
        if (what === 'id') return { frame: idOf() }
        // first and last magenta run along a line; each run is [start, end) in device px of the screenshot
        const runs = (len, get) => {
          const out = []
          let s = -1
          for (let i = 0; i <= len; i++) {
            const m = i < len && mag(get(i))
            if (m && s < 0) s = i
            if (!m && s >= 0) {
              out.push([s, i])
              s = -1
            }
          }
          return out
        }
        const row = runs(width, (x) => at(x, height >> 1))
        const col = runs(height, (y) => at(width >> 1, y))
        return { width, height, row, col, frame: idOf() }
      },
      [png.toString('base64'), dpr, what, clip ?? null],
    )
  return {
    id: (png, dpr, clip) => run(png, dpr, 'id', clip),
    async ring(png, dpr, clip) {
      const m = await run(png, dpr, 'ring', clip)
      const edge = (runs) =>
        runs.length >= 2 ? { a0: runs[0][0], a1: runs[0][1], b0: runs.at(-1)[0], b1: runs.at(-1)[1] } : null
      return { ...m, h: edge(m.row), v: edge(m.col) }
    },
    close: () => page.close(),
  }
}
