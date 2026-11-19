// S2b service worker: Cache Storage for the pinned toolkit under /sdks/. One entry per file, keyed by the file's
// SHA-256 from /sdks/manifest.json, so a toolkit change replaces only the files whose hash changed.
// Cache name = package:dartpad version + Dart + Flutter version; a new name drops the old cache whole.
/* global self, caches, fetch, Request, clients */
let manifest = null
let manifestAt = 0
const metaKey = '/sdks/manifest.json'

async function getManifest() {
  if (manifest && Date.now() - manifestAt < 10000) return manifest
  const meta = await caches.open('toolkit-meta')
  try {
    const r = await fetch(metaKey, { cache: 'no-store' })
    manifest = await r.clone().json()
    await meta.put(metaKey, r)
  } catch {
    // offline or server down: run on the last manifest we saw
    const r = await meta.match(metaKey)
    if (!r) throw new Error('no manifest and no network')
    manifest = await r.json()
  }
  manifestAt = Date.now()
  return manifest
}
const cacheName = (m) => `toolkit-${m.dartpad}-${m.dart}-${m.flutter}`

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e) =>
  e.waitUntil(
    (async () => {
      const m = await getManifest().catch(() => null)
      if (m)
        for (const n of await caches.keys())
          if (n.startsWith('toolkit-') && n !== 'toolkit-meta' && n !== cacheName(m)) await caches.delete(n)
      await clients.claim()
    })(),
  ),
)

self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url)
  // third-party runtime assets the toolkit hardcodes: answer from the X99 mirror (filled by mirror.mjs)
  const hop = { 'fonts.gstatic.com': '/mirror/fonts', 'cdn.jsdelivr.net': '/mirror/jsdelivr' }[u.hostname]
  if (hop && e.request.method === 'GET') return e.respondWith(fetch(self.location.origin + hop + u.pathname))
  if (u.origin !== self.location.origin || !u.pathname.startsWith('/sdks/') || u.pathname === metaKey) return
  if (e.request.method !== 'GET' || e.request.headers.has('range')) return
  e.respondWith(
    (async () => {
      const m = await getManifest()
      const rel = decodeURIComponent(u.pathname.slice('/sdks/'.length))
      const sha = m.files[rel]
      if (!sha) return fetch(e.request) // not a pinned file: pass through
      const cache = await caches.open(cacheName(m))
      const key = new Request(`${u.origin}/sdks/${rel}?sha=${sha}`)
      const hit = await cache.match(key)
      if (hit) return hit
      const r = await fetch(u.href, { cache: 'no-store' })
      if (r.ok) {
        for (const k of await cache.keys()) if (new URL(k.url).pathname === u.pathname) await cache.delete(k) // old hash
        // a full or evicted origin throws QuotaExceededError: serve from the network, keep what fits, never fail the fetch
        await cache.put(key, r.clone()).catch(() => {})
      }
      return r
    })(),
  )
})
