// App-shell SW registration + cache fill. Must stay an EXTERNAL script: the
// chain's CSP is script-src 'self', which silently blocks inline <script> —
// an inline version of this file never ran (see sw.js for the protocol: the
// SW itself never fetches; the page posts content-hashed asset blobs to it).
(function () {
  if (!('serviceWorker' in navigator)) return
  if (location.protocol !== 'https:' && location.hostname !== '127.0.0.1' && location.hostname !== 'localhost') return

  var fill = function () {
    var sw = navigator.serviceWorker
    if (!sw.controller) return
    var urls = []
    document.querySelectorAll('script[src], link[rel="stylesheet"]').forEach(function (el) {
      var u = el.src || el.href
      if (u && /\/platform\/(app\.js|app\.css|theme\.js)\?v=/.test(u)) urls.push(u)
    })
    urls.forEach(function (u) {
      fetch(u)
        .then(function (r) {
          if (!r.ok) return
          return r.blob().then(function (b) {
            sw.controller.postMessage({ type: 'cache-asset', url: u, blob: b })
          })
        })
        .catch(function () {})
    })
  }

  addEventListener('load', function () {
    navigator.serviceWorker.register('sw.js').catch(function () {})
    if (document.readyState === 'complete') fill()
    else addEventListener('load', fill)
  })
})()
