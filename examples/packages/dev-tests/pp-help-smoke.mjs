// Help-page smoke: the in-product usage guide (#/help) renders its five
// sections, the pLDDT band swatches, and cross-links back into the app.
import { chromium } from '/tmp/node_modules/playwright-core/index.mjs'

const exe = `${process.env.HOME}/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell`
// PP_BASE/PP_USER/PP_PASS: drive a remote deployment (see pp-complex-full.mjs).
const base = process.env.PP_BASE ?? 'http://127.0.0.1:4177/platform/'
const httpCreds = process.env.PP_USER
  ? { username: process.env.PP_USER, password: process.env.PP_PASS ?? '' }
  : undefined
const fail = []
const browser = await chromium.launch({ executablePath: exe, headless: true })
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 }, ...(httpCreds ? { httpCredentials: httpCreds } : {}) })
await page.goto(`${base}#/help`, { waitUntil: 'domcontentloaded', timeout: 60000 })

// Nav link exists and highlights on the help route.
await page.waitForSelector('.pl-nav a[href="#/help"].on', { timeout: 15000, state: 'attached' }).catch(() => fail.push('nav 指南 link missing/not active'))

// Five numbered sections.
const secs = await page.locator('.pl-help-sec h2').count()
if (secs < 5) fail.push(`expected ≥5 sections, got ${secs}`)

// pLDDT palette: 4 swatches in the pv band colors.
await page.waitForFunction(
  () => document.querySelectorAll('.pl-help-swatch').length >= 4,
  { timeout: 10000 },
).catch(() => fail.push('pLDDT band swatches missing'))
const swatchColors = await page.locator('.pl-help-swatch').evaluateAll((els) => els.map((e) => e.style.background))
const hex2rgb = (h) => {
  const n = parseInt(h.slice(1), 16)
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`
}
for (const c of ['#0053D6', '#65CBF3', '#FFDB13', '#FF7D45']) {
  if (!swatchColors.some((s) => s.replace(/\s/g, '') === hex2rgb(c).replace(/\s/g, ''))) fail.push(`swatch color ${c} missing`)
}

// Cross-links resolve inside the SPA.
await page.screenshot({ path: '/tmp/pp-help-smoke.png', fullPage: true })
await page.locator('.pl-help-foot a', { hasText: '首页' }).click()
await page.waitForSelector('.pl-composer textarea', { timeout: 15000 }).catch(() => fail.push('footer link did not reach home composer'))

await browser.close()
if (fail.length) {
  console.error('FAIL:', fail.join(' | '))
  process.exit(1)
}
console.log('help page smoke: PASS')
