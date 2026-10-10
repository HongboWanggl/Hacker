import { chromium } from '/tmp/node_modules/playwright-core/index.mjs'
const exe = '/Users/wanghanbao/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell'
const browser = await chromium.launch({ executablePath: exe, headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } })
const errors = []
page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)))
await page.goto('http://127.0.0.1:4177/', { waitUntil: 'domcontentloaded', timeout: 60000 })
await page.waitForTimeout(5000)
await page.getByText('protein-predictor').first().click()
await page.waitForTimeout(2000)
await page.getByRole('button', { name: /new session/i }).first().click()
await page.waitForTimeout(2000)
const box = page.locator('textarea').first()
await box.fill('预测序列 MSTHDTSLTSTDILRGQVSAARFGLLMLLPFFVHSANVSTLA 蛋白结构并总结置信度。')
await page.keyboard.press('Enter')
console.log('submitted')
let stats = null
for (let i = 0; i < 60; i++) {
  await page.waitForTimeout(5000)
  stats = await page.evaluate(() => ({
    pvRoots: document.querySelectorAll('.pv-root').length,
    jump: document.querySelectorAll('.pv-jump').length,
  }))
  if (i % 6 === 0) console.log(`t=${(i + 1) * 5}s`, JSON.stringify(stats))
  if (stats.jump > 0) break
}
console.log('panel:', JSON.stringify(stats), 'errors:', JSON.stringify(errors.slice(0, 3)))
if (stats.jump > 0) {
  await page.locator('.pv-jump').first().fill('17')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(1200)
  const line = await page.evaluate(() => document.querySelector('.pv-hoverline')?.textContent ?? '')
  console.log('hoverline after jump:', line)
  await page.screenshot({ path: '/tmp/pv-jump.png' })
}
await browser.close()
