// Search smoke: uniprot_search → SearchCard renders hits with accessions.
import { chromium } from '/tmp/node_modules/playwright-core/index.mjs'
import { login } from './pp-login.mjs'

const exe = `${process.env.HOME}/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell`
// PP_BASE/PP_USER/PP_PASS: drive a remote deployment (see pp-complex-full.mjs).
const base = process.env.PP_BASE ?? 'http://127.0.0.1:4177/platform/'
const httpCreds = process.env.PP_USER
  ? { username: process.env.PP_USER, password: process.env.PP_PASS ?? '' }
  : undefined
const fail = []
const browser = await chromium.launch({ executablePath: exe, headless: true })
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 }, ...(httpCreds ? { httpCredentials: httpCreds } : {}) })
if (httpCreds) await login(page.request, base, httpCreds)
await page.goto(`${base}#/search`, { waitUntil: 'domcontentloaded', timeout: 60000 })
await page.waitForSelector('.pl-input-name', { timeout: 15000 })
await page.fill('.pl-input-name', 'hemoglobin human')
await page.click('.pl-submit')
await page.goto(`${base}#/tasks`, { timeout: 15000 })
const outcome = await page
  .waitForSelector(
    '.pl-tasklist a.pl-taskrow:first-child .pl-badge.done, .pl-tasklist a.pl-taskrow:first-child .pl-badge.failed',
    {
      timeout: 180000,
      state: 'attached',
    },
  )
  .then((el) => el.textContent())
  .catch(() => null)
if (outcome !== '已完成') fail.push(`search outcome: ${outcome}`)
// Archive write runs in-page after turn/end — hold the tab open until it lands.
const taskId = await page.getAttribute('a.pl-taskrow', 'href').then((h) => h?.split('/').pop() ?? '')
await page
  .waitForFunction(
    async (id) => {
      try {
        return (await fetch(`api/archive/${id}/meta`)).ok
      } catch {
        return false
      }
    },
    taskId,
    { timeout: 45000 },
  )
  .then(() => console.log('archive: landed'))
  .catch(() => fail.push('archive did not land within 45s'))
await page.click('a.pl-taskrow')
await page.waitForSelector('.pv-root', { timeout: 60000 })
// Card data arrives via a later BFF roundtrip — wait until hits render (the
// component first shows the raw preview as a fallback).
await page
  .waitForFunction(() => /P6\d{4}|HBB|HBA/.test(document.querySelector('.pl-result')?.innerText ?? ''), {
    timeout: 60000,
  })
  .catch(() => {})
const body = (await page.textContent('.pl-result').catch(() => '')) ?? ''
if (!/P6\d{4}|HBB|HBA/.test(body)) fail.push(`SearchCard missing accessions: ${body.slice(0, 150)}`)
await page.screenshot({ path: '/tmp/pp-search-smoke.png' })
// Fresh context: the archived search page must rebuild SearchCard from the
// archived report.json alone.
const page2 = await browser.newPage({ viewport: { width: 1400, height: 1000 }, ...(httpCreds ? { httpCredentials: httpCreds } : {}) })
if (httpCreds) await login(page2.request, base, httpCreds)
await page2.goto(`${base}#/task/${taskId}`, { waitUntil: 'domcontentloaded', timeout: 60000 })
await page2.waitForSelector('.pv-root', { timeout: 60000 })
await page2
  .waitForFunction(() => /P6\d{4}|HBB|HBA/.test(document.querySelector('.pl-result')?.innerText ?? ''), {
    timeout: 30000,
  })
  .catch(() => {})
const body2 = (await page2.textContent('.pl-result').catch(() => '')) ?? ''
if (!/P6\d{4}|HBB|HBA/.test(body2)) fail.push('archived search page missing accessions')
if (!/历史归档/.test(body2)) fail.push('archived search page lacks archive badge')
// One-click predict hand-off (platform host only): hit-row ▶ starts a single
// task verbatim from the accession. Assert on the archived page — proves the
// hand-off works without the live task, like a researcher on another device.
const predBtn = page2.locator('.pv-search-predict').first()
await predBtn.waitFor({ timeout: 15000, state: 'visible' }).catch(() => fail.push('predict ▶ missing on search card'))
if (fail.length === 0) {
  await predBtn.click()
  await page2
    .waitForFunction(
      () => {
        const t = JSON.parse(localStorage.getItem('pp-tasks-v1') ?? '[]')
        return t.length >= 1 && t[0].type === 'single' && t[0].status === 'running'
      },
      { timeout: 30000 },
    )
    .catch(() => fail.push('predict ▶ click did not start a single task'))
}
await browser.close()
if (fail.length) {
  console.error('FAIL:', fail.join(' | '))
  process.exit(1)
}
console.log('search smoke: PASS')
