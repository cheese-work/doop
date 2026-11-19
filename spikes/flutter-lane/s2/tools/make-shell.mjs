/* global Buffer */
// Derives the two S2 shell layers from a Rive community iPhone file, and a manifest of the screen slot.
// usage: node make-shell.mjs <in.riv> <outdir> [artboard name, default Bezel_BlackTitanium]
//   outdir/shell-below.riv  bezel raster hidden: body + (no screen)  -> drawn UNDER the Flutter screen
//   outdir/shell-above.riv  body hidden: the bezel raster only       -> drawn OVER the Flutter screen
//   outdir/shell.json       {artboard:{w,h}, screen:{x,y,w,h,name}, source:{sha256,bytes}}
// The nested screen artboard is hidden in both layers (opacity 0) and gets the name "doop-screen", so Flutter can ask
// the runtime for it with Artboard.component('doop-screen'). The input .riv is never committed (CC BY 4.0, 1.9 MB).
// Format: rive-runtime include/rive/generated headers (MIT); riv-key-types.json is the key -> type table built from them.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const KEYS = JSON.parse(fs.readFileSync(path.join(here, 'riv-key-types.json'), 'utf8'))
const K = { name: 4, parent: 5, w: 7, h: 8, x: 13, y: 14, opacity: 18, nestedAbId: 197 }
const T = { artboard: 1, node: 2, shape: 3, image: 100, nested: 92 }

export function parse(buf) {
  let o = 4
  const varuint = () => {
    let r = 0n
    let s = 0n
    for (;;) {
      const b = buf[o++]
      r |= BigInt(b & 0x7f) << s
      if (!(b & 0x80)) break
      s += 7n
    }
    return Number(r)
  }
  if (buf.toString('latin1', 0, 4) !== 'RIVE') throw new Error('not a .riv file')
  varuint()
  varuint()
  varuint() // major, minor, file id
  const tocKeys = []
  for (let k = varuint(); k; k = varuint()) tocKeys.push(k)
  const types = { ...KEYS }
  let bits = 0
  tocKeys.forEach((k, i) => {
    if (i % 4 === 0) {
      bits = buf.readUInt32LE(o)
      o += 4
    }
    types[k] ??= (bits >> ((i % 4) * 2)) & 3
  })
  const objs = []
  while (o < buf.length) {
    const start = o
    const typeKey = varuint()
    const props = []
    for (let k = varuint(); k; k = varuint()) {
      const t = types[k]
      if (t === undefined) throw new Error(`unknown property key ${k} at byte ${o}`)
      if (t === 0) props.push([k, t, varuint()])
      else if (t === 1) {
        const n = varuint()
        props.push([k, t, buf.subarray(o, o + n)])
        o += n
      } else if (t === 2) {
        props.push([k, t, buf.readFloatLE(o)])
        o += 4
      } else {
        props.push([k, t, buf.readUInt32LE(o)])
        o += 4
      }
    }
    objs.push({ typeKey, props, start, end: o })
  }
  return { objs, headEnd: objs[0].start }
}

const enc = {
  varuint(n) {
    const out = []
    do {
      let b = n & 0x7f
      n = Math.floor(n / 128)
      if (n) b |= 0x80
      out.push(b)
    } while (n)
    return Buffer.from(out)
  },
}
export function encode(ob) {
  const parts = [enc.varuint(ob.typeKey)]
  for (const [k, t, v] of ob.props) {
    parts.push(enc.varuint(k))
    if (t === 0) parts.push(enc.varuint(v))
    else if (t === 1) parts.push(enc.varuint(v.length), v)
    else {
      const b = Buffer.alloc(4)
      if (t === 2) b.writeFloatLE(v)
      else b.writeUInt32LE(v)
      parts.push(b)
    }
  }
  parts.push(enc.varuint(0))
  return Buffer.concat(parts)
}

const get = (ob, key) => ob.props.find((p) => p[0] === key)?.[2]
const set = (ob, key, type, v) => {
  const p = ob.props.find((q) => q[0] === key)
  if (p) p[2] = v
  else ob.props.push([key, type, v])
}

// Objects of one artboard: the artboard object and everything up to the next one. Object i of that list is the id
// other objects use as parent (the artboard is 0).
export function artboards(objs) {
  const out = []
  objs.forEach((ob, i) => {
    if (ob.typeKey === T.artboard) out.push({ first: i, name: Buffer.from(get(ob, K.name) ?? '').toString(), list: [] })
    if (out.length) out.at(-1).list.push(ob)
  })
  return out
}

export function patch(buf, objs, patches) {
  // patches: [{ob, props:[[key,type,value]]}]; rewrites only those objects, copies every other byte
  const chunks = []
  let at = 0
  for (const { ob, props } of [...patches].sort((a, b) => a.ob.start - b.ob.start)) {
    const copy = { ...ob, props: ob.props.map((p) => [...p]) }
    for (const [k, t, v] of props) set(copy, k, t, v)
    chunks.push(buf.subarray(at, ob.start), encode(copy))
    at = ob.end
  }
  chunks.push(buf.subarray(at))
  return Buffer.concat(chunks)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [inFile, outDir, abName = 'Bezel_BlackTitanium'] = process.argv.slice(2)
  if (!inFile || !outDir) throw new Error('usage: node make-shell.mjs <in.riv> <outdir> [artboard]')
  const buf = fs.readFileSync(inFile)
  const { objs } = parse(buf)
  const abs = artboards(objs)
  const ab = abs.find((a) => a.name === abName)
  if (!ab) throw new Error(`no artboard ${abName}; have ${abs.map((a) => a.name).join(', ')}`)
  const image = ab.list.findIndex((o) => o.typeKey === T.image)
  const shape = ab.list.findIndex((o) => o.typeKey === T.shape)
  const nested = ab.list.findIndex((o) => o.typeKey === T.nested)
  if (image < 1 || shape < 1 || nested < 1) throw new Error('shell layout is not image + shape + nested artboard')
  const nob = ab.list[nested]
  // the shape's rectangle gives the screen corner radius (key 31); its fill is switched off in the source file
  const rect = ab.list.findIndex((o) => o.typeKey === 7 && get(o, K.parent) === shape)
  const fill = ab.list.findIndex((o) => o.typeKey === 20 && get(o, K.parent) === shape)
  const color = ab.list.findIndex((o) => o.typeKey === 18 && get(o, K.parent) === fill)
  if (rect < 1 || fill < 1 || color < 1) throw new Error('screen shape has no rectangle, fill and colour')
  const target = abs[get(nob, K.nestedAbId)]
  const num = (ob, k) => get(ob, k) ?? 0
  const name = Buffer.from('doop-screen')
  const hide = [K.opacity, 2, 0]
  const layers = {
    below: [
      { ob: ab.list[image], props: [hide] },
      { ob: nob, props: [hide, [K.name, 1, name]] },
      // the screen-sized backing the file ships switched off: on, and black, so the below layer draws something
      { ob: ab.list[fill], props: [[41, 0, 1]] },
      { ob: ab.list[color], props: [[37, 3, 0xff000000]] },
    ],
    above: [
      { ob: ab.list[shape], props: [hide] },
      { ob: nob, props: [hide, [K.name, 1, name]] },
    ],
  }
  fs.mkdirSync(outDir, { recursive: true })
  for (const [k, p] of Object.entries(layers))
    fs.writeFileSync(path.join(outDir, `shell-${k}.riv`), patch(buf, objs, p))
  const manifest = {
    artboard: { name: abName, w: num(ab.list[0], K.w), h: num(ab.list[0], K.h) },
    screen: {
      name: 'doop-screen',
      x: num(nob, K.x),
      y: num(nob, K.y),
      w: num(target.list[0], K.w),
      h: num(target.list[0], K.h),
      radius: num(ab.list[rect], 31),
    },
    objects: { image, shape, nested, fill, color },
    source: { bytes: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex') },
  }
  fs.writeFileSync(path.join(outDir, 'shell.json'), JSON.stringify(manifest, null, 1) + '\n')
  console.log(JSON.stringify(manifest))
}
