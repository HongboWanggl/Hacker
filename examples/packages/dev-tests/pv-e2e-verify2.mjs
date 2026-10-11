import { chromium } from '/tmp/node_modules/playwright-core/index.mjs'

const exe = `${process.env.HOME}/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell`
const browser = await chromium.launch({ executablePath: exe, headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
const errors = []
page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)))
await page.goto('http://127.0.0.1:4177/', { waitUntil: 'domcontentloaded', timeout: 60000 })
await page.waitForTimeout(5000)
// close onboarding modal if present
const close = page.getByRole('button', { name: /close|关闭/i }).first()
try {
  await close.click({ timeout: 3000 })
  console.log('closed modal')
} catch {
  console.log('no modal close')
}
await page.waitForTimeout(2000)
// expand workspaces / find session entries
const labels = await page.evaluate(() =>
  [...document.querySelectorAll('li, a, button, [role=button], span, div')]
    .map((el) => (el.childElementCount === 0 ? (el.textContent ?? '').trim() : ''))
    .filter((t) => t && t.length < 60 && /p53|P04637|protein|预测/.test(t)),
)
console.log('labels:', JSON.stringify([...new Set(labels)].slice(0, 10)))
// Session titles rotate as new probes run; try known historical titles in
// order, else stay on the current view. The point is slot replay of an
// already-completed turn, so any opened session works.
const candidates = [/p53蛋白P04637/, /p53蛋白/, /对比p53/, /预测P61626/, /预测蛋白质/]
let opened = false
for (const rx of candidates) {
  try {
    await page.getByText(rx).first().click({ timeout: 4000 })
    console.log('opened session', rx)
    opened = true
    break
  } catch {}
}
if (!opened) console.log('no historical title matched; using current view')
await page.waitForTimeout(9000)
const stats = await page.evaluate(() => ({
  pvRoots: document.querySelectorAll('.pv-root').length,
  curve: document.querySelectorAll('.pv-curve').length,
  threeD: document.querySelectorAll('.pv-3d').length,
  seqTiles: document.querySelectorAll('.pv-seq-tile').length,
  toolviewVisible: [...document.querySelectorAll('[data-agnes-dsh-slot="tool.call.toolview"]')].filter(
    (e) => !e.hidden,
  ).length,
}))
if (stats.pvRoots < 1 || !stats.threeD || stats.seqTiles < 100) {
  console.log('REGRESSION FAIL', JSON.stringify(stats))
  process.exit(1)
}
console.log('stats:', JSON.stringify(stats), 'errors:', JSON.stringify(errors.slice(0, 3)))
// sequence strip ↔ hoverline sync: real hover over tile 100 → readout updates.
// Panel lives inside details.turn-process — expand first or tiles are hidden.
try {
  await page.evaluate(() =>
    document.querySelectorAll('details.turn-process:not([open]) summary').forEach((s) => {
      s.click()
    }),
  )
  await page.waitForTimeout(2500)
  await page.locator('.pv-seq-tile').nth(100).hover({ timeout: 5000 })
  await page.waitForTimeout(500)
  const tileHover = await page.evaluate(() => document.querySelector('.pv-hoverline')?.textContent ?? '')
  console.log('strip hover:', tileHover.slice(0, 80))
} catch (e) {
  console.log('strip hover skipped:', String(e).slice(0, 80))
}
await page.screenshot({ path: '/tmp/pv-after-hostfix.png' })
await browser.close()
