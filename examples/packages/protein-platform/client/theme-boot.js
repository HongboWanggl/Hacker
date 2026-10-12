// Anti-flash theme boot. Classic blocking script in <head> (the surface CSP is
// `script-src 'self'`, so no inline script — same shape as the AGH web host's
// theme-boot). Applies `.dark` on <html> BEFORE the stylesheet paints: the pv
// components and the platform chrome both key their dark rules on that class.
// Resolution: explicit localStorage choice (`pp-theme`) → system preference.
// Everything is fault-tolerant: no storage or no matchMedia just falls back.
(function () {
  'use strict'
  var dark = false
  try {
    var saved = localStorage.getItem('pp-theme')
    if (saved === 'dark') dark = true
    else if (saved === 'light') dark = false
    else dark = window.matchMedia('(prefers-color-scheme: dark)').matches
  } catch {
    try {
      dark = window.matchMedia('(prefers-color-scheme: dark)').matches
    } catch {
      dark = false
    }
  }
  var root = document.documentElement
  root.classList.toggle('dark', dark)
  try {
    root.style.colorScheme = dark ? 'dark' : 'light'
  } catch {
    // older engines: class rules still apply
  }
})()
