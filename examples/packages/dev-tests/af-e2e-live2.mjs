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
await box.fill('用 compare_alphafold 对比 structures/p53_human_P04637_393aa.pdb 与 AlphaFold DB 的 P04637 参考模型，报告 caRmsd、caRmsdCore 和 meanAbsPlddtDelta，并解释差异来源。')
await page.keyboard.press('Enter')
console.log('submitted')
let stats = null
for (let i = 0; i < 48; i++) {
  await page.waitForTimeout(5000)
  await page.evaluate(() => document.querySelectorAll('details.turn-process:not([open]) summary').forEach((s) => s.click()))
  stats = await page.evaluate(() => ({
    compareCards: document.querySelectorAll('.pv-compare-bars').length,
    chips: [...document.querySelectorAll('.pv-root')].some((r) => r.innerText.includes('CA-RMSD')),
  }))
  if (i % 8 === 0) console.log(`t=${(i + 1) * 5}s…`, JSON.stringify(stats))
  if (stats.compareCards > 0 && stats.chips) break
}
console.log('final:', JSON.stringify(stats))
if (!stats || !stats.compareCards) { console.log('AF COMPARE PANEL MISSING'); process.exitCode = 1 }
await page.screenshot({ path: '/tmp/af-e2e-live2.png' })
await browser.close()
