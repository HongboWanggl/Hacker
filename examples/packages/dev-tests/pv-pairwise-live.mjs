import { chromium } from '/tmp/node_modules/playwright-core/index.mjs'

const exe =
  '/Users/wanghanbao/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell'
const browser = await chromium.launch({ executablePath: exe, headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } })
const errors = []
page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)))
await page.goto('http://127.0.0.1:4177/', { waitUntil: 'domcontentloaded', timeout: 60000 })
await page.waitForTimeout(5000)
await page.getByText('protein-predictor').first().click()
await page.waitForTimeout(2000)
await page
  .getByRole('button', { name: /new session/i })
  .first()
  .click()
await page.waitForTimeout(2000)
const box = page.locator('textarea').first()
await box.fill(
  '用 compare_structures 对比 structures/p53_1_393aa.pdb 和 structures/P04637_alphafold_ref.pdb，label_a 是「ESMFold 预测」label_b 是「AlphaFold 参考」，然后中文解读结果。',
)
await page.keyboard.press('Enter')
console.log('submitted')
let stats = null
for (let i = 0; i < 60; i++) {
  await page.waitForTimeout(5000)
  stats = await page.evaluate(() => ({
    pvRoots: document.querySelectorAll('.pv-root').length,
    hasPairwise: document.body.textContent.includes('ESMFold 预测 vs AlphaFold 参考'),
  }))
  if (i % 6 === 0) console.log(`t=${(i + 1) * 5}s`, JSON.stringify(stats))
  if (stats.hasPairwise) break
}
console.log('panel:', JSON.stringify(stats), 'errors:', JSON.stringify(errors.slice(0, 3)))
if (stats.hasPairwise) {
  await page.evaluate(() => {
    document.querySelectorAll('details.turn-process:not([open])').forEach((d) => {
      d.querySelector('summary')?.click()
    })
  })
  await page.waitForTimeout(4000)
  const detail = await page.evaluate(() => ({
    score: document.querySelector('.pv-score-value')?.textContent,
    labels: document.body.textContent.includes('ESMFold 预测 vs AlphaFold 参考'),
    chips: [...document.querySelectorAll('.pv-metric-chip')].slice(0, 4).map((c) => c.textContent),
    verdict: document.querySelector('.pv-hoverline')?.textContent?.slice(0, 80),
  }))
  console.log('card:', JSON.stringify(detail, null, 1))
  await page.screenshot({ path: '/tmp/pv-pairwise.png' })
}
await browser.close()
