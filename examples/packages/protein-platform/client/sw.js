// Platform app-shell cache. The public chain sits behind Caddy basic auth,
// and Chromium (a) will not reuse disk-cache entries for responses to
// Authorization-carrying requests, and (b) does NOT attach the cached basic
// credentials to fetches issued INSIDE a Service Worker — an SW network fetch
// here 401s and can even poison the profile's auth state (ERR_INVALID_AUTH_
// CREDENTIALS on every later navigation). So this SW never touches the
// network: the page (whose fetches carry the browser's credentials) downloads
// the content-hashed assets and posts the blobs over; the SW stores them and
// subsequently serves those exact URLs cache-first. URLs it has never seen
// are simply not intercepted — they flow through the normal (authenticated)
// browser path. index.html and /api/* always hit the network.
const CACHE = 'pp-shell-v1'
const ASSET = /^\/platform\/(app\.js|app\.css|theme\.js)$/

// URLs we hold — filled from the cache at SW start and via page messages.
// Top-level code runs before the first event of this SW instance; the async
// fill may lag the very first fetches, which then just pass through (benign).
const known = new Set()
;(async () => {
  try {
    const c = await caches.open(CACHE)
    for (const k of await c.keys()) known.add(k.url)
  } catch {
    /* cache unavailable — nothing to serve */
  }
})()

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

self.addEventListener('message', (e) => {
  const d = e.data || {}
  if (d.type !== 'cache-asset' || typeof d.url !== 'string' || !(d.blob instanceof Blob)) return
  const url = d.url
  e.waitUntil(
    (async () => {
      const c = await caches.open(CACHE)
      await c.put(url, new Response(d.blob))
      known.add(url)
    })(),
  )
})

self.addEventListener('fetch', (e) => {
  const req = e.request
  if (req.method !== 'GET') return
  let u
  try {
    u = new URL(req.url)
  } catch {
    return
  }
  if (u.origin !== self.location.origin) return
  if (!ASSET.test(u.pathname) || !u.search.startsWith('?v=')) return
  // Only URLs the page explicitly handed us are served from here.
  if (!known.has(req.url)) return
  e.respondWith((async () => (await caches.match(req)) || fetch(req))())
})
