/* global fetch, Buffer */
// Fill the X99 mirror once, from X99 (build time, not the viewer): pub.dev package JSON + archives, the Flutter fallback font,
// the rive wasm runtime. usage: node mirror.mjs <urls.txt> <MIRROR_DIR>
// package JSON gets archive_url rewritten to <ORIGIN>/mirror/pub/api/archives/<file>, (__ORIGIN__ is filled in by the server per request) so `pub get` in the browser never leaves X99.
import fs from 'node:fs'
import path from 'node:path'
const [list, root] = process.argv.slice(2)
const urls = fs
  .readFileSync(list, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => l.replace(/^GET /, ''))
const put = (rel, buf) => {
  const f = path.join(root, rel)
  fs.mkdirSync(path.dirname(f), { recursive: true })
  fs.writeFileSync(f, buf)
  return buf.length
}
const get = async (u, accept) => {
  const r = await fetch(u, { headers: accept ? { accept } : {} })
  if (!r.ok) throw new Error(`${u} ${r.status}`)
  return Buffer.from(await r.arrayBuffer())
}
let n = 0,
  bytes = 0
for (const u of urls) {
  const x = new URL(u)
  if (x.hostname === 'pub.dev' && x.pathname.startsWith('/api/packages/') && !x.pathname.endsWith('/advisories')) {
    const j = JSON.parse((await get(u, 'application/vnd.pub.v2+json')).toString())
    for (const v of j.versions) v.archive_url = `__ORIGIN__/mirror/pub/api/archives/${v.archive_url.split('/').pop()}`
    bytes += put(`pub${x.pathname}.json`, Buffer.from(JSON.stringify(j)))
  } else if (x.hostname === 'pub.dev' && x.pathname.startsWith('/api/archives/')) {
    bytes += put(`pub${x.pathname}`, await get(u))
  } else if (x.hostname === 'fonts.gstatic.com') bytes += put(`fonts${x.pathname}`, await get(u))
  else if (x.hostname === 'cdn.jsdelivr.net') bytes += put(`jsdelivr${x.pathname}`, await get(u))
  else continue
  n++
}
console.log(`mirrored ${n} files, ${bytes} bytes into ${root}`)
