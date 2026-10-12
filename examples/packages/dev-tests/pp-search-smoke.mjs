// Search smoke: uniprot_search → SearchCard renders hits with accessions.
import { chromium } from '/tmp/node_modules/playwright-core/index.mjs'

const exe = `${process.env.HOME}/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell`
const base = 'http://127.0.0.1:4177/platform/'
const fail = []
const browser = await chromium.launch({ executablePath: exe, headless: true })
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } })
await page.goto(`${base}#/search`, { waitUntil: 'domcontentloaded', timeout: 60000 })
await page.waitForSelector('.pl-input-name', { timeout: 15000 })
await page.fill('.pl-input-name', 'hemoglobin human')
await page.click('.pl-submit')
await page.goto(`${base}#/tasks`, { timeout: 15000 })
const outcome = await page
  .waitForSelector('.pl-tasklist a.pl-taskrow:first-child .pl-badge.done, .pl-tasklist a.pl-taskrow:first-child .pl-badge.failed', {
    timeout: 180000,
    state: 'attached',
  })
  .then((el) => el.textContent())
  .catch(() => null)
if (outcome !== '已完成') fail.push(`search outcome: ${outcome}`)
await page.click('a.pl-taskrow')
await page.waitForSelector('.pv-root', { timeout: 60000 })
// Card data arrives via a later BFF roundtrip — wait until hits render (the
// component first shows the raw preview as a fallback).
await page
  .waitForFunction(() => /P6\d{4}|HBB|HBA/.test(document.querySelector('.pl-result')?.innerText ?? ''), { timeout: 60000 })
  .catch(() => {})
const body = (await page.textContent('.pl-result').catch(() => '')) ?? ''
if (!/P6\d{4}|HBB|HBA/.test(body)) fail.push(`SearchCard missing accessions: ${body.slice(0, 150)}`)
await page.screenshot({ path: '/tmp/pp-search-smoke.png' })
await browser.close()
if (fail.length) {
  console.error('FAIL:', fail.join(' | '))
  process.exit(1)
}
console.log('search smoke: PASS')
