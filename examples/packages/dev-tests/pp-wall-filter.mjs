// Home wall filter smoke: the type chips narrow the capped wall to one task
// type (live + archive cards alike) and 全部 restores the mixed preview.
import { chromium } from '/tmp/node_modules/playwright-core/index.mjs'
import { login } from './pp-login.mjs'

const exe = `${process.env.HOME}/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell`
const base = process.env.PP_BASE ?? 'http://127.0.0.1:4177/platform/'
const httpCreds = process.env.PP_USER
  ? { username: process.env.PP_USER, password: process.env.PP_PASS ?? '' }
  : undefined
const fail = []
const browser = await chromium.launch({ executablePath: exe, headless: true })
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 }, ...(httpCreds ? { httpCredentials: httpCreds } : {}) })
if (httpCreds) await login(page.request, base, httpCreds)
page.on('pageerror', (err) => fail.push(`pageerror: ${String(err).slice(0, 120)}`))

await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 60000 })
await page.waitForSelector('.pl-filters-wall .pl-type-tab', { timeout: 20000 })
await page.waitForSelector('.pl-wall .pl-card', { timeout: 20000 }).catch(() => fail.push('wall has no cards'))
await page.waitForTimeout(300)

const total = await page.locator('.pl-wall .pl-card').count()
if (total === 0) fail.push('wall empty — smoke needs history')
else console.log(`wall cards (全部): ${total}`)

// Each type chip: every visible card's type label matches the chip.
for (const label of ['单体', '复合物', '批量', '对比']) {
  await page.locator('.pl-filters-wall .pl-type-tab', { hasText: label }).first().click()
  await page.waitForTimeout(250)
  const shown = await page.locator('.pl-wall .pl-card').count()
  const types = await page.locator('.pl-wall .pl-card-type').allTextContents()
  if (shown === 0) fail.push(`${label} filter shows zero cards`)
  if (types.some((t) => !t.includes(label))) fail.push(`${label} filter shows a foreign card: ${JSON.stringify(types)}`)
  console.log(`${label}: ${shown}`)
}

// 全部 restores.
await page.locator('.pl-filters-wall .pl-type-tab', { hasText: '全部' }).click()
await page.waitForTimeout(250)
const restored = await page.locator('.pl-wall .pl-card').count()
if (restored !== total) fail.push(`全部 did not restore ${total} cards (got ${restored})`)

await page.screenshot({ path: '/tmp/pp-wall-filter.png' })
await browser.close()
if (fail.length) {
  console.error('FAIL:', fail.join(' | '))
  process.exit(1)
}
console.log('wall filter smoke: PASS')
