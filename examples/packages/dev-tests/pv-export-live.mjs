// Live E2E: PNG export downloads. Uses the historical single-protein session
// (蛋白结构预测与置信度总结) — the original new-session flow broke when turn
// markup changed, and a fresh live turn only re-tests what other probes already
// cover. Clicks both 3D and curve 导出 PNG and asserts two downloads.
import { chromium } from '/tmp/node_modules/playwright-core/index.mjs'
const exe = '/Users/wanghanbao/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell'
const browser = await chromium.launch({ executablePath: exe, headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
const errors = []
page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)))
await page.goto('http://127.0.0.1:4177/', { waitUntil: 'domcontentloaded', timeout: 60000 })
await page.waitForTimeout(5000)
// expand all workspace groups so the session row is clickable
await page.evaluate(() => {
  document.querySelectorAll('.workspace-heading').forEach((h) => {
    if (h.getAttribute('aria-expanded') !== 'true') h.click()
  })
})
await page.waitForTimeout(1500)
const clicked = await page.evaluate(() => {
  const el = [...document.querySelectorAll('.session-row .session')].find((e) => e.textContent.trim() === '蛋白结构预测与置信度总结')
  el?.click()
  return !!el
})
if (!clicked) { console.log('FAIL session not found'); process.exit(1) }
await page.waitForTimeout(5000)
// a completed turn may be collapsed — expand before clicking exports
await page.evaluate(() => document.querySelectorAll('details.turn-process:not([open]) summary').forEach((s) => s.click()))
await page.waitForTimeout(2000)
const vis = await page.evaluate(() => ({
  exports: [...document.querySelectorAll('.pv-export')].filter((e) => e.offsetParent !== null).map((e) => e.textContent),
}))
console.log('visible exports:', JSON.stringify(vis.exports))
if (vis.exports.length < 2) { console.log('FAIL: no visible export buttons'); process.exit(1) }

const dl3d = page.waitForEvent('download', { timeout: 10000 }).catch(() => null)
await page.locator('.pv-3d-col .pv-export', { hasText: '导出 PNG' }).first().click()
const d1 = await dl3d
const dlCurve = page.waitForEvent('download', { timeout: 10000 }).catch(() => null)
await page.locator('.pv-curve-col .pv-export', { hasText: '导出 PNG' }).first().click()
const d2 = await dlCurve
console.log('3D download:', d1 ? d1.suggestedFilename() : 'NONE')
console.log('curve download:', d2 ? d2.suggestedFilename() : 'NONE')
let failed = 0
if (!d1 || !d2) { console.log('FAIL: expected two downloads'); failed = 1 }
if (d1) await d1.saveAs('/tmp/export-3d.png')
if (d2) await d2.saveAs('/tmp/export-curve.png')
console.log('pageerrors:', errors.length ? errors.join(' | ') : 'none')
await page.screenshot({ path: '/tmp/pv-export-live.png' })
await browser.close()
process.exit(failed)
console.log('EXPORT LIVE DONE')
