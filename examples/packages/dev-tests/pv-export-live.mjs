import { chromium } from '/tmp/node_modules/playwright-core/index.mjs'
const exe = '/Users/wanghanbao/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell'
const browser = await chromium.launch({ executablePath: exe, headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
const errors = []
page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)))
await page.goto('http://127.0.0.1:4177/', { waitUntil: 'domcontentloaded', timeout: 60000 })
await page.waitForTimeout(5000)
await page.getByText('protein-predictor').first().click()
await page.waitForTimeout(2000)
await page.getByRole('button', { name: /new session/i }).first().click()
await page.waitForTimeout(2000)
const box = page.locator('textarea').first()
const PROMPT = '请用 uniprot_fetch 获取 P61626 的序列并用 predict_structure 预测结构，中文一句话总结。'
let stats = null
// The Ark model route rate-limits (RATE_LIMIT: status=429) after dense live
// runs — on a failed turn, cool down and re-submit once.
for (let attempt = 1; attempt <= 3 && !stats?.exports?.length; attempt++) {
  if (attempt > 1) {
    console.log('turn failed (likely 429); cooling down 180s and retrying')
    await page.waitForTimeout(180000)
    await page.getByRole('button', { name: /new session/i }).first().click()
    await page.waitForTimeout(2000)
  }
  await box.fill(PROMPT)
  await page.keyboard.press('Enter')
  console.log('submitted attempt', attempt)
  for (let i = 0; i < 60; i++) {
    await page.waitForTimeout(5000)
    stats = await page.evaluate(() => ({
      pvRoots: document.querySelectorAll('.pv-root').length,
      curve: document.querySelectorAll('.pv-curve').length,
      threeD: document.querySelectorAll('.pv-3d').length,
      exports: [...document.querySelectorAll('.pv-export')].map((e) => e.textContent),
      failed: !! [...document.querySelectorAll('*')].find((e) => e.childElementCount === 0 && /RATE_LIMIT/.test(e.textContent ?? '')),
    }))
    if (i % 6 === 0) console.log(`t=${(i + 1) * 5}s`, JSON.stringify({ ...stats, failed: undefined }))
    if (stats.failed && stats.pvRoots === 0) break
    if (stats.pvRoots > 0 && stats.exports.length >= 2) break
  }
}
console.log('panel:', JSON.stringify(stats), 'errors:', JSON.stringify(errors.slice(0, 3)))
// Account-quota exhaustion (every attempt died on RATE_LIMIT before any panel
// existed) is an external condition, not a panel regression — skip loudly.
if (stats.failed && stats.pvRoots === 0 && stats.exports?.length === 0) {
  console.log('SKIP: model route quota exhausted (HTTP 429 on every attempt) — rerun when quota resets')
  await page.screenshot({ path: '/tmp/pv-export-live.png' })
  await browser.close()
  process.exit(0)
}

if (!stats.exports || stats.exports.length < 2) {
  console.log('FAIL: panel never produced export buttons')
  await page.screenshot({ path: '/tmp/pv-export-live.png' })
  await browser.close()
  process.exit(1)
}

// Panels live inside <details class="turn-process"> — a completed turn may be
// collapsed, which makes .pv-export "not visible" to playwright. Expand all.
await page.evaluate(() => document.querySelectorAll('details.turn-process:not([open]) summary').forEach((s) => s.click()))
await page.waitForTimeout(1500)

// click the 3D export button and capture the download — locate by column and
// text, not index: the toolbars now carry 复制序列 / 导出 CSV too (no downloads).
if (stats.exports?.length >= 2) {
  const dl3d = page.waitForEvent('download', { timeout: 10000 }).catch(() => null)
  await page.locator('.pv-3d-col .pv-export', { hasText: '导出 PNG' }).first().click()
  const d1 = await dl3d
  const dlCurve = page.waitForEvent('download', { timeout: 10000 }).catch(() => null)
  await page.locator('.pv-curve-col .pv-export', { hasText: '导出 PNG' }).first().click()
  const d2 = await dlCurve
  console.log('3D download:', d1 ? d1.suggestedFilename() : 'NONE')
  console.log('curve download:', d2 ? d2.suggestedFilename() : 'NONE')
  if (!d1 || !d2) { console.log('FAIL: expected two downloads'); process.exitCode = 1 }
  if (d1) await d1.saveAs('/tmp/export-3d.png')
  if (d2) await d2.saveAs('/tmp/export-curve.png')
}
await page.screenshot({ path: '/tmp/pv-export-live.png' })
await browser.close()
