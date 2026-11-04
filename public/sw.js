/* global self, caches */
/* Offline fallback only: precaches one static page and serves it when a navigation fails.
   Never caches API responses, canvas data or the app bundle. */
const CACHE = 'doop-offline-v1'
const OFFLINE_URL = '/offline.html'

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll([OFFLINE_URL])))
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.mode !== 'navigate') return
  event.respondWith(fetch(request).catch(() => caches.match(OFFLINE_URL)))
})
