// live E2E: uniprot_search in a fresh agent session renders the structured
// hit table (search card), not the broken confidence-panel fallback.
import { chromium } from '/tmp/node_modules/playwright-core/index.mjs'

const exe =
  '/Users/wanghanbao/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell'
const browser = await chromium.launch({ executablePath: exe, headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
const errors = []
page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)))
await page.goto('http://127.0.0.1:4177/', { waitUntil: 'domcontentloaded', timeout: 60000 })
await page.waitForTimeout(5000)
try {
  await page
    .getByRole('button', { name: /close|关闭/i })
    .first()
    .click({ timeout: 3000 })
} catch {}
await page.getByText('protein-predictor').first().click()
await page.waitForTimeout(2000)
await page
  .getByRole('button', { name: /new session/i })
  .first()
  .click()
await page.waitForTimeout(2000)
const box = page.locator('textarea').first()
await box.fill(
  '用 uniprot_search 搜索 human lysozyme，告诉我在 UniProtKB 里有几条结果、第一条的 accession 和长度。',
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
  stats = await page.evaluate(() => ({
    roots: document.querySelectorAll('.pv-root').length,
    searchTables: document.querySelectorAll('.pv-search-table').length,
    rows: document.querySelectorAll('.pv-search-row').length,
    acc: document.querySelector('.pv-search-acc')?.textContent ?? null,
  }))
  if (i % 6 === 0) console.log(`t=${(i + 1) * 5}s`, JSON.stringify(stats))
  if (stats.searchTables > 0 && stats.rows > 0) break
}
console.log('final:', JSON.stringify(stats), 'errors:', JSON.stringify(errors.slice(0, 3)))
if (!stats || stats.searchTables < 1 || stats.rows < 1) {
  console.log('SEARCH CARD MISSING')
  process.exitCode = 1
} else if (
  !stats.acc ||
  !/^[OPQ][0-9][A-Z0-9]{3}[0-9]|[A-NR-Z][0-9]([A-Z][A-Z0-9]{2}[0-9]){1,2}/.test(stats.acc.replace(' ✓', ''))
) {
  console.log('ACCESSION FORMAT SUSPECT:', stats.acc)
  process.exitCode = 1
}
await page.screenshot({ path: '/tmp/pv-search-live.png' })
await browser.close()
