// Fresh-session full loop at phone width (400px): composer usable → real
// predict_structure run → panel mounts → single-column grid, no overflow.
// Validates the scenario live suites at desktop width never see: creating a
// session and running a real prediction on a phone-sized viewport.
import { chromium } from '/tmp/node_modules/playwright-core/index.mjs'

const exe =
  '/Users/wanghanbao/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell'
const browser = await chromium.launch({ executablePath: exe, headless: true })
const errors = []
const page = await browser.newPage({ viewport: { width: 400, height: 850 } })
page.on('pageerror', (e) => errors.push(String(e).slice(0, 120)))
await page.goto('http://127.0.0.1:4177/', { waitUntil: 'domcontentloaded', timeout: 60000 })
await page.waitForTimeout(5000)
await page.evaluate(() => {
  document.querySelectorAll('.workspace-heading').forEach((h) => {
    if (h.getAttribute('aria-expanded') !== 'true') h.click()
  })
})
await page.waitForTimeout(1500)
await page.evaluate(() => {
  for (const el of document.querySelectorAll('button'))
    if (/new session/i.test(el.textContent ?? '')) {
      el.click()
      break
    }
})
await page.waitForTimeout(2000)
const composer = await page.evaluate(() => {
  const ta = document.querySelector('textarea')
  if (!ta) return null
  const r = ta.getBoundingClientRect()
  return { ok: r.width > 200 && r.height > 30, w: Math.round(r.width) }
})
console.log('composer@400:', JSON.stringify(composer))
const box = page.locator('textarea').first()
await box.fill(
  '用 uniprot_fetch 获取 P61626 的序列，用 predict_structure 预测结构，再用 analyze_confidence 分析置信度，一句话总结。',
)
await page.keyboard.press('Enter')
console.log('submitted')
let stats = null
for (let i = 0; i < 36; i++) {
  await page.waitForTimeout(5000)
  await page.evaluate(() =>
    document.querySelectorAll('details.turn-process:not([open]) summary').forEach((s) => {
      s.click()
    }),
  )
  stats = await page.evaluate(() => {
    const main = [...document.querySelectorAll('.pv-root')].find((r) => r.querySelector('.pv-3d'))
    const g = main?.querySelector('.pv-grid')
    return {
      has3d: !!main,
      curve: !!main?.querySelector('.pv-curve-col'),
      cols: g ? getComputedStyle(g).gridTemplateColumns.split(' ').length : null,
      sw: g ? g.scrollWidth : null,
      cw: g ? g.clientWidth : null,
    }
  })
  if (stats.has3d && stats.curve) break
}
console.log('final:', JSON.stringify(stats))
if (!composer?.ok || !stats?.has3d || !stats.curve || stats.sw !== stats.cw || stats.cols !== 1) {
  console.log('MOBILE E2E FAILED')
  process.exitCode = 1
}
if (errors.length) {
  console.log('pageerrors:', errors.join(' | '))
  process.exitCode = 1
}
await browser.close()
process.exit(process.exitCode || 0)
