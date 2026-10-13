// Platform app-shell cache. The public chain sits behind Caddy basic auth,
// and Chromium will not reuse disk-cache entries for responses to requests
// carrying Authorization — so every repeat visit re-downloaded the ~205KB
// gzipped bundle over a slow relayed link. A cache-first Service Worker keyed
// on the content-hashed asset URLs (?v=<hash> in index.html) sidesteps the
// HTTP disk cache entirely: first visit populates, later visits serve from
// the Cache API in milliseconds. index.html and /api/* always hit the network
// (new deploys bump the hash → fresh URLs → cache-first naturally picks them
// up; stale entries are swept on activate).
const CACHE = 'pp-shell-v1'
const ASSET = /^\/platform\/(app\.js|app\.css|theme\.js)$/

self.addEventListener('install', () => {
  self.skipWaiting()
})

self.addEventListener('activate', (e) => {
  e.waitUntil(
    (async () => {
      for (const k of await caches.keys()) {
        if (k !== CACHE) await caches.delete(k)
      }
      await self.clients.claim()
    })(),
  )
})

self.addEventListener('fetch', (e) => {
  const req = e.request
  if (req.method !== 'GET') return
  const u = new URL(req.url)
  if (u.origin !== self.location.origin) return
  if (!ASSET.test(u.pathname) || !u.search.startsWith('?v=')) return
  e.respondWith(
    (async () => {
      const hit = await caches.match(req)
      if (hit) return hit
      const res = await fetch(req)
      if (res.ok) {
        const cache = await caches.open(CACHE)
        cache.put(req, res.clone())
      }
      return res
    })(),
  )
})
