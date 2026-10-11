// Live E2E on the agnes-ai route: full agent flow (uniprot_fetch → predict_structure
// → confidence panel) without depending on the Ark route's quota. Selects
// agnes-3.0-flash in the model picker before sending the prompt.
import { chromium } from '/tmp/node_modules/playwright-core/index.mjs'

const exe =
  '/Users/wanghanbao/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell'
const browser = await chromium.launch({ executablePath: exe, headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } })
const errors = []
page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)))
await page.goto('http://127.0.0.1:4177/', { waitUntil: 'domcontentloaded', timeout: 60000 })
await page.waitForTimeout(5000)
await page
  .getByRole('button', { name: /new session/i })
  .first()
  .click()
await page.waitForTimeout(1200)
if (await page.locator('#new-session[open]').count())
  await page
    .locator('#workspace-option-items .workspace-option', { hasText: /protein-predictor/ })
    .first()
    .click()
await page.waitForTimeout(2000)
// switch the session to the agnes route (bypasses Ark 429 quota)
const trigger = page.locator('button[aria-haspopup="listbox"]').nth(1)
await trigger.click()
await page.waitForTimeout(1000)
await page.locator('[role="option"]', { hasText: /agnes/i }).first().click()
await page.waitForTimeout(800)
console.log('model:', (await trigger.textContent())?.trim())
const box = page.locator('textarea').first()
const PROMPT = '预测序列 MSTHDTSLTSTDILRGQVSAARFGLLMLLPFFVHSANVSTLA 蛋白结构并总结置信度。'
let stats = null
for (let attempt = 1; attempt <= 3 && !stats?.pvRoots; attempt++) {
  if (attempt > 1) {
    console.log('turn failed; cooling down 60s and retrying')
    await page.waitForTimeout(60000)
    await page
      .getByRole('button', { name: /new session/i })
      .first()
      .click()
    await page.waitForTimeout(1200)
    if (await page.locator('#new-session[open]').count())
      await page
        .locator('#workspace-option-items .workspace-option', { hasText: /protein-predictor/ })
        .first()
        .click()
    await page.waitForTimeout(2000)
  }
  await box.fill(PROMPT)
  await page.keyboard.press('Enter')
  console.log('submitted attempt', attempt)
  for (let i = 0; i < 48; i++) {
    await page.waitForTimeout(5000)
    stats = await page.evaluate(() => ({
      pvRoots: document.querySelectorAll('.pv-root').length,
      curve: document.querySelectorAll('.pv-curve').length,
      threeD: document.querySelectorAll('.pv-3d, canvas').length,
      seqTiles: document.querySelectorAll('.pv-seq-tile').length,
      failed: !![...document.querySelectorAll('*')].find(
        (e) =>
          e.childElementCount === 0 &&
          /RATE_LIMIT|could not complete|credentials have expired/.test(e.textContent ?? ''),
      ),
    }))
    if (i % 6 === 0)
      console.log(`t=${(i + 1) * 5}s`, JSON.stringify({ pvRoots: stats.pvRoots, seqTiles: stats.seqTiles }))
    if (stats.pvRoots > 0 && stats.seqTiles > 0) break
    if (stats.failed && stats.pvRoots === 0) break
  }
}
console.log('final:', JSON.stringify(stats), 'errors:', JSON.stringify(errors.slice(0, 3)))
await page.screenshot({ path: '/tmp/pv-agnes-e2e.png' })
if (!stats?.pvRoots || stats.seqTiles < 30) {
  console.log('FAIL: agnes-route live E2E did not produce a confidence panel')
  await browser.close()
  process.exit(1)
}
console.log('PASS: agnes-route live E2E produced panel with', stats.seqTiles, 'seq tiles')
await browser.close()
