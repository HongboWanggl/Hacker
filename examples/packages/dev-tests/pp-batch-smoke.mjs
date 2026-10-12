// Batch smoke: submit 2 accessions → batch_predict → BatchCard renders jobs summary.
import { chromium } from '/tmp/node_modules/playwright-core/index.mjs'

const exe = `${process.env.HOME}/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell`
const base = 'http://127.0.0.1:4177/platform/'
const fail = []
const browser = await chromium.launch({ executablePath: exe, headless: true })
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } })
await page.goto(`${base}#/batch`, { waitUntil: 'domcontentloaded', timeout: 60000 })
await page.waitForSelector('.pl-composer textarea', { timeout: 15000 })
await page.fill('.pl-composer textarea', 'P69905\nP68871')
await page.click('.pl-submit')
await page.goto(`${base}#/tasks`, { timeout: 15000 })
const outcome = await page
  .waitForSelector('.pl-tasklist a.pl-taskrow:first-child .pl-badge.done, .pl-tasklist a.pl-taskrow:first-child .pl-badge.failed', {
    timeout: 600000,
    state: 'attached',
  })
  .then((el) => el.textContent())
  .catch(() => null)
if (outcome !== '已完成') fail.push(`batch outcome: ${outcome}`)
await page.click('a.pl-taskrow')
await page.waitForSelector('.pv-root', { timeout: 60000 })
// BatchCard data arrives via a later BFF roundtrip — wait until job rows render.
await page
  .waitForFunction(() => /P69905/.test(document.querySelector('.pl-result')?.innerText ?? ''), { timeout: 60000 })
  .catch(() => {})
const body = await page.textContent('.pl-result').catch(() => '')
if (!/P69905/.test(body ?? '')) fail.push('BatchCard missing P69905 row')
if (!/P68871/.test(body ?? '')) fail.push('BatchCard missing P68871 row')
await page.screenshot({ path: '/tmp/pp-batch-smoke.png' })
await browser.close()
if (fail.length) {
  console.error('FAIL:', fail.join(' | '))
  process.exit(1)
}
console.log('batch smoke: PASS')
