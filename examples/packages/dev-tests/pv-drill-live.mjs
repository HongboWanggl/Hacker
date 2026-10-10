import { chromium } from '/tmp/node_modules/playwright-core/index.mjs'
const exe = '/Users/wanghanbao/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell'
const browser = await chromium.launch({ executablePath: exe, headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 1200 } })
const errors = []
page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)))
await page.goto('http://127.0.0.1:4177/', { waitUntil: 'domcontentloaded', timeout: 60000 })
await page.waitForTimeout(5000)
await page.getByText('protein-predictor').first().click()
await page.waitForTimeout(2000)
await page.getByRole('button', { name: /new session/i }).first().click()
await page.waitForTimeout(2000)
const box = page.locator('textarea').first()
await box.fill('用 batch_predict 预测 P61626 和 P0A7B8 两个蛋白，中文一句话总结。')
await page.keyboard.press('Enter')
console.log('submitted')
let stats = null
for (let i = 0; i < 72; i++) {
  await page.waitForTimeout(5000)
  stats = await page.evaluate(() => ({
    pvRoots: document.querySelectorAll('.pv-root').length,
    batchRows: document.querySelectorAll('.pv-batch-row--ok').length,
  }))
  if (i % 6 === 0) console.log(`t=${(i + 1) * 5}s`, JSON.stringify(stats))
  if (stats.batchRows > 0) break
}
console.log('batch panel:', JSON.stringify(stats), 'errors:', JSON.stringify(errors.slice(0, 3)))

// expand first row and wait for drill-down 3D + curve.
// After the turn ends the panel lives inside the turn's collapsible step ("Completed ·
// took Ns") plus a collapsed copy in the trace — expand every collapsed details first,
// then click a *visible* row.
if (stats.batchRows > 0) {
  for (const d of await page.locator('details:not([open])').all())
    await d.locator('summary').click().catch(() => {})
  await page.waitForTimeout(1000)
  const row = page.locator('.pv-batch-row--ok:visible').first()
  if (await row.count() === 0) { console.log('FAIL no visible batch row', JSON.stringify(stats)); process.exitCode = 1 }
  else await row.click()
  let detail = null
  for (let i = 0; i < 24; i++) {
    await page.waitForTimeout(2500)
    detail = await page.evaluate(() => ({
      detail: document.querySelectorAll('.pv-batch-detail').length,
      loading: document.querySelectorAll('.pv-batch-loading').length,
      detail3d: document.querySelectorAll('.pv-batch-detail .pv-3d').length,
      detailCurve: document.querySelectorAll('.pv-batch-detail .pv-curve').length,
      detailStrip: document.querySelectorAll('.pv-batch-detail .pv-seq-tile').length,
    }))
    if (detail.detail3d > 0 && detail.detailCurve > 0) break
  }
  if (!detail || !detail.detailStrip) { console.log('FAIL drill-down missing sequence strip', JSON.stringify(detail)); process.exitCode = 1 }
  console.log('drill-down:', JSON.stringify(detail), 'errors:', JSON.stringify(errors.slice(0, 3)))
  await page.screenshot({ path: '/tmp/pv-drill.png' })
}
await browser.close()
