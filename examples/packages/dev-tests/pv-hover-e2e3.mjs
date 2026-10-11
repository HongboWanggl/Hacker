import { chromium } from '/tmp/node_modules/playwright-core/index.mjs'

const exe = `${process.env.HOME}/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell`
const browser = await chromium.launch({ executablePath: exe, headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } })
const errors = []
page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)))
await page.goto('http://127.0.0.1:4177/', { waitUntil: 'domcontentloaded', timeout: 60000 })
await page.waitForTimeout(5000)
const clicked = await page.evaluate(() => {
  const spans = [...document.querySelectorAll('.session-title')]
  const el = spans.find((s) => s.textContent.includes('compare_structures'))
  if (!el) return 'not found'
  el.closest('li, [role=button], button, div')?.click()
  el.click()
  return 'clicked'
})
console.log(clicked)
await page.waitForTimeout(5000)
await page.evaluate(() => {
  document.querySelectorAll('details.turn-process:not([open])').forEach((d) => {
    d.querySelector('summary')?.click()
  })
})
await page.waitForTimeout(5000)
await page.evaluate(() => document.querySelector('.pv-3d')?.scrollIntoView({ block: 'center' }))
await page.waitForTimeout(800)
await page.evaluate(() => document.querySelector('.pv-3d')?.scrollIntoView({ block: 'center' }))
await page.waitForTimeout(800)
const canvas = page.locator('.pv-3d').first()
const bb = await canvas.boundingBox().catch(() => null)
if (bb) {
  await page.mouse.move(bb.x + bb.width * 0.42, bb.y + bb.height * 0.45)
  await page.waitForTimeout(600)
  await page.mouse.move(bb.x + bb.width * 0.44, bb.y + bb.height * 0.47, { steps: 4 })
  await page.waitForTimeout(900)
}
const info = await page.evaluate(() => ({
  hoverlines: [...document.querySelectorAll('.pv-hoverline')].map((e) => e.textContent).filter(Boolean),
  overlays: document.querySelectorAll('.pv-3d').length,
}))
console.log('info:', JSON.stringify(info), 'errors:', JSON.stringify(errors.slice(0, 2)))
await page.evaluate(() => document.querySelector('.pv-3d')?.scrollIntoView({ block: 'center' }))
await page.waitForTimeout(600)
await page.screenshot({ path: '/tmp/pv-hover.png' })
await browser.close()
